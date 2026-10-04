import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile, copyFile, unlink } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import path from 'node:path'
import type { ExecutionWorkspace, WorkspaceManifestEntry, WorkspacePatchEntry } from '../shared/harness-runtime.ts'

const EXCLUDED_NAMES = new Set(['.git', '.gradle', 'build', 'run', 'release', 'runtime', 'node_modules', '.idea'])

function isWithin(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root)
  const candidateResolved = path.resolve(candidate)
  return candidateResolved === rootResolved || candidateResolved.startsWith(`${rootResolved}${path.sep}`)
}

function shouldSkip(root: string, candidate: string): boolean {
  if (!isWithin(root, candidate)) return true
  const relative = path.relative(root, candidate)
  return relative.split(path.sep).some((part) => EXCLUDED_NAMES.has(part))
}

async function hashFile(filePath: string): Promise<{ sha256: string; size: number }> {
  const content = await readFile(filePath)
  return { sha256: createHash('sha256').update(content).digest('hex'), size: content.byteLength }
}

async function manifestFor(root: string, current = root, result: WorkspaceManifestEntry[] = []): Promise<WorkspaceManifestEntry[]> {
  if (shouldSkip(root, current)) return result
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  try { entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' }) as Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }> } catch { return result }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (shouldSkip(root, absolute)) continue
    let link = false
    try { link = lstatSync(absolute).isSymbolicLink() } catch { continue }
    if (link) continue
    if (entry.isDirectory()) {
      await manifestFor(root, absolute, result)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const hash = await hashFile(absolute)
      result.push({ path: path.relative(root, absolute).replace(/\\/g, '/'), ...hash })
    } catch { /* a file removed while scanning is ignored */ }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

function manifestMap(entries: WorkspaceManifestEntry[]): Map<string, WorkspaceManifestEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

function changedPaths(baseline: WorkspaceManifestEntry[], current: WorkspaceManifestEntry[]): string[] {
  const before = manifestMap(baseline)
  const after = manifestMap(current)
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((filePath) => {
    const oldEntry = before.get(filePath)
    const newEntry = after.get(filePath)
    return !oldEntry || !newEntry || oldEntry.sha256 !== newEntry.sha256
  }).sort()
}

function patchJournalFor(baseline: WorkspaceManifestEntry[], current: WorkspaceManifestEntry[], recordedAt = Date.now()): WorkspacePatchEntry[] {
  const before = manifestMap(baseline)
  const after = manifestMap(current)
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths]
    .filter((filePath) => before.get(filePath)?.sha256 !== after.get(filePath)?.sha256)
    .sort()
    .map((filePath) => {
      const oldEntry = before.get(filePath)
      const newEntry = after.get(filePath)
      return {
        path: filePath,
        operation: !oldEntry ? 'create' : !newEntry ? 'delete' : 'modify',
        ...(oldEntry ? { beforeSha256: oldEntry.sha256 } : {}),
        ...(newEntry ? { afterSha256: newEntry.sha256 } : {}),
        recordedAt
      } satisfies WorkspacePatchEntry
    })
}

interface WorkspaceRecord {
  workspace: ExecutionWorkspace
  baselineMap: Map<string, WorkspaceManifestEntry>
  backupPath?: string
}

export interface WorkspaceManagerOptions {
  dataRoot: string
}

export interface PromoteResult {
  ok: boolean
  status: ExecutionWorkspace['status']
  changedPaths: string[]
  conflictPaths: string[]
  error?: string
}

/**
 * Creates isolated candidate workspaces and promotes only validated changes.
 * This class intentionally does not know anything about Electron or the
 * renderer; it can therefore be tested with ordinary temporary directories.
 */
export class WorkspaceManager {
  private readonly dataRoot: string
  private readonly records = new Map<string, WorkspaceRecord>()

  constructor(options: WorkspaceManagerOptions) {
    this.dataRoot = path.resolve(options.dataRoot)
  }

  async create(projectPath: string, taskId = randomUUID()): Promise<ExecutionWorkspace> {
    const userProjectPath = path.resolve(projectPath)
    if (isWithin(userProjectPath, this.dataRoot) || isWithin(this.dataRoot, userProjectPath)) {
      throw new Error('workspace data root must not be inside the user project (or vice versa)')
    }
    const projectStat = await stat(userProjectPath)
    if (!projectStat.isDirectory()) throw new Error('project path is not a directory')
    await mkdir(this.dataRoot, { recursive: true })
    const id = `ws_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const shadowPath = path.join(this.dataRoot, id, 'project')
    await mkdir(path.dirname(shadowPath), { recursive: true })
    await cp(userProjectPath, shadowPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (source) => {
        try { return !shouldSkip(userProjectPath, source) && !lstatSync(source).isSymbolicLink() } catch { return false }
      }
    })
    const baseline = await manifestFor(userProjectPath)
    const workspace: ExecutionWorkspace = {
      version: 1,
      id,
      userProjectPath,
      shadowPath,
      baseline,
      createdAt: Date.now(),
      status: 'active'
    }
    this.records.set(id, { workspace, baselineMap: manifestMap(baseline) })
    await this.persist(workspace)
    return { ...workspace, baseline: [...baseline] }
  }

  private async recordFor(id: string): Promise<WorkspaceRecord> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('invalid execution workspace id')
    const existing = this.records.get(id)
    if (existing) return existing
    const metadataPath = path.join(this.dataRoot, id, 'workspace.json')
    try {
      const workspace = JSON.parse(await readFile(metadataPath, 'utf8')) as ExecutionWorkspace
      if (workspace.version !== 1 || workspace.id !== id || !workspace.shadowPath || !workspace.userProjectPath) throw new Error('invalid workspace metadata')
      const persistedBackup = path.join(this.dataRoot, id, 'backup')
      const record: WorkspaceRecord = {
        workspace,
        baselineMap: manifestMap(workspace.baseline || []),
        ...(existsSync(persistedBackup) ? { backupPath: persistedBackup } : {})
      }
      this.records.set(id, record)
      return record
    } catch {
      throw new Error(`unknown execution workspace: ${id}`)
    }
  }

  async get(id: string): Promise<ExecutionWorkspace> {
    const record = await this.recordFor(id)
    return { ...record.workspace, baseline: [...record.workspace.baseline] }
  }

  async diff(id: string): Promise<{ changedPaths: string[]; current: WorkspaceManifestEntry[]; patchJournal: WorkspacePatchEntry[] }> {
    const record = await this.recordFor(id)
    const current = await manifestFor(record.workspace.shadowPath)
    const changed = changedPaths(record.workspace.baseline, current)
    record.workspace.changedPaths = changed
    record.workspace.patchJournal = patchJournalFor(record.workspace.baseline, current)
    await this.persist(record.workspace)
    return { changedPaths: changed, current, patchJournal: [...(record.workspace.patchJournal || [])] }
  }

  async promote(id: string): Promise<PromoteResult> {
    const record = await this.recordFor(id)
    const { workspace } = record
    const shadowManifest = await manifestFor(workspace.shadowPath)
    const changed = changedPaths(workspace.baseline, shadowManifest)
    workspace.changedPaths = changed
    workspace.patchJournal = patchJournalFor(workspace.baseline, shadowManifest)
    if (changed.length === 0) {
      workspace.status = 'promoted'
      workspace.changedPaths = []
      await this.persist(workspace)
      return { ok: true, status: workspace.status, changedPaths: [], conflictPaths: [] }
    }

    const currentUserManifest = await manifestFor(workspace.userProjectPath)
    const currentMap = manifestMap(currentUserManifest)
    const conflicts = changed.filter((filePath) => {
      const baseline = record.baselineMap.get(filePath)
      const current = currentMap.get(filePath)
      if (!baseline && !current) return false
      if (!baseline || !current) return Boolean(baseline || current)
      return baseline.sha256 !== current.sha256
    })
    if (conflicts.length > 0) {
      workspace.status = 'promotion_conflict'
      workspace.changedPaths = changed
      workspace.conflictPaths = conflicts
      await this.persist(workspace)
      return { ok: false, status: workspace.status, changedPaths: changed, conflictPaths: conflicts, error: 'user project changed while the task was running' }
    }

    const backupPath = path.join(this.dataRoot, id, 'backup')
    await mkdir(backupPath, { recursive: true })
    record.backupPath = backupPath
    const shadowMap = manifestMap(shadowManifest)
    try {
      for (const filePath of changed) {
        const target = path.join(workspace.userProjectPath, filePath)
        const backup = path.join(backupPath, filePath)
        if (!isWithin(workspace.userProjectPath, target)) throw new Error(`unsafe promotion path: ${filePath}`)
        if (existsSync(target)) {
          await mkdir(path.dirname(backup), { recursive: true })
          await copyFile(target, backup)
        }
      }
      for (const filePath of changed) {
        const target = path.join(workspace.userProjectPath, filePath)
        const source = path.join(workspace.shadowPath, filePath)
        if (!isWithin(workspace.userProjectPath, target) || !isWithin(workspace.shadowPath, source)) throw new Error(`unsafe promotion path: ${filePath}`)
        const next = shadowMap.get(filePath)
        if (!next) {
          if (existsSync(target)) await unlink(target)
          continue
        }
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(source, target)
      }
    } catch (error) {
      await this.rollbackRecord(record, changed)
      workspace.status = 'rolled_back'
      await this.persist(workspace)
      return { ok: false, status: workspace.status, changedPaths: changed, conflictPaths: [], error: String(error) }
    }
    workspace.status = 'promoted'
    workspace.changedPaths = changed
    await this.persist(workspace)
    return { ok: true, status: workspace.status, changedPaths: changed, conflictPaths: [] }
  }

  async rollback(id: string): Promise<void> {
    const record = await this.recordFor(id)
    const changed = record.workspace.changedPaths || (await this.diff(id)).changedPaths
    await this.rollbackRecord(record, changed)
    record.workspace.status = 'rolled_back'
    await this.persist(record.workspace)
  }

  async discard(id: string): Promise<void> {
    const record = await this.recordFor(id).catch(() => null)
    if (!record) return
    const container = path.dirname(record.workspace.shadowPath)
    if (!isWithin(this.dataRoot, container) || path.resolve(container) === path.resolve(this.dataRoot)) throw new Error('unsafe workspace cleanup path')
    await rm(container, { recursive: true, force: true })
    record.workspace.status = 'discarded'
    this.records.delete(id)
  }

  async mark(id: string, status: ExecutionWorkspace['status'], fields: Pick<ExecutionWorkspace, 'changedPaths' | 'conflictPaths'> = {}): Promise<ExecutionWorkspace> {
    const record = await this.recordFor(id)
    record.workspace.status = status
    if (fields.changedPaths !== undefined) record.workspace.changedPaths = fields.changedPaths
    if (fields.conflictPaths !== undefined) record.workspace.conflictPaths = fields.conflictPaths
    await this.persist(record.workspace)
    return { ...record.workspace, baseline: [...record.workspace.baseline] }
  }

  private async rollbackRecord(record: WorkspaceRecord, changed: string[]): Promise<void> {
    // Rehydrate the backup location after an application restart.  The old
    // implementation kept this path only in memory, making final-build
    // rollback a no-op after a renderer/main-process restart.
    const backupPath = record.backupPath || path.join(this.dataRoot, record.workspace.id, 'backup')
    if (!existsSync(backupPath)) return
    for (const filePath of changed) {
      const target = path.join(record.workspace.userProjectPath, filePath)
      const backup = path.join(backupPath, filePath)
      if (!isWithin(record.workspace.userProjectPath, target)) continue
      if (existsSync(backup)) {
        await mkdir(path.dirname(target), { recursive: true })
        await copyFile(backup, target)
      } else if (existsSync(target)) {
        await unlink(target)
      }
    }
  }

  private async persist(workspace: ExecutionWorkspace): Promise<void> {
    const metadataPath = path.join(path.dirname(workspace.shadowPath), 'workspace.json')
    await writeFile(metadataPath, JSON.stringify(workspace, null, 2), 'utf8')
  }
}
