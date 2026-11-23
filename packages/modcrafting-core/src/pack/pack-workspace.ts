/**
 * Reading and writing an integration pack on disk.
 *
 * `pack.json` is human-edited, so every write is transactional and revision
 * checked: the caller must say which revision it read, and a mismatch is refused
 * instead of overwriting someone else's edit. `pack.lock.json` is machine output
 * and is written whole; drift against the manifest is reported, never repaired
 * silently.
 *
 * Creating a pack is the only write that does not take a revision, and it refuses
 * to touch an existing manifest. That keeps "create" from becoming an implicit
 * overwrite path.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PACK_LOCK_FILE,
  PACK_MANIFEST_FILE,
  emptyPackManifest,
  lockDrift,
  packLockSchema,
  packManifestSchema,
  type PackLock,
  type PackManifest
} from '../pack-model.ts'
import { packEntrySchema, type PackEntry } from '../workspace-model.ts'

export interface PackWorkspace {
  path: string
  manifestFile: string
  lockFile: string
  manifest: PackManifest
  /** Hash of the manifest bytes this view was read from. `none` when the file is absent. */
  revision: string
  lock: PackLock | null
  drift: { missingInLock: string[]; extraInLock: string[] } | null
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function describeIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`).join('; ')
}

export function packManifestPath(root: string): string {
  return path.join(path.resolve(root), PACK_MANIFEST_FILE)
}

export function packLockPath(root: string): string {
  return path.join(path.resolve(root), PACK_LOCK_FILE)
}

function revisionOf(file: string): string {
  if (!existsSync(file)) return 'none'
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function writeAtomic(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, contents, 'utf8')
  renameSync(temporary, file)
}

function assertRevision(action: string, current: string, expected: string | undefined): void {
  if (!expected) {
    fail('PACK_REVISION_REQUIRED', `${action}前必须带上读取时的 revision，避免覆盖别人刚做的修改。请重新读取整合包再保存。`)
  }
  if (expected !== current) {
    fail('PACK_REVISION_CONFLICT', `pack.json 在读取后已被修改（当前 revision ${current.slice(0, 12)}…）。请重新读取整合包，确认改动后再保存。`)
  }
}

function parseManifest(contents: string): PackManifest {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (cause) {
    fail('PACK_INVALID', `${PACK_MANIFEST_FILE} 不是合法 JSON：${(cause as Error).message}`)
  }
  const parsed = packManifestSchema.safeParse(raw)
  if (!parsed.success) fail('PACK_INVALID', `${PACK_MANIFEST_FILE} 不合法：${describeIssues(parsed.error)}`)
  return parsed.data
}

export function readPackLock(root: string): PackLock | undefined {
  const file = packLockPath(root)
  if (!existsSync(file)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (cause) {
    fail('PACK_LOCK_INVALID', `${PACK_LOCK_FILE} 不是合法 JSON：${(cause as Error).message}。删除它并重新求解即可重建。`)
  }
  const parsed = packLockSchema.safeParse(raw)
  if (!parsed.success) fail('PACK_LOCK_INVALID', `${PACK_LOCK_FILE} 不合法：${describeIssues(parsed.error)}。删除它并重新求解即可重建。`)
  return parsed.data
}

export function loadPackWorkspace(root: string): PackWorkspace {
  const absolute = path.resolve(root)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    fail('PACK_NOT_FOUND', `整合包目录不存在：${absolute}。请先建立目录并调用 create。`)
  }
  const file = packManifestPath(absolute)
  if (!existsSync(file)) {
    fail('PACK_NOT_FOUND', `${absolute} 还不是整合包（缺少 ${PACK_MANIFEST_FILE}）。先调用 modcrafting_pack_workspace 的 create 建立清单。`)
  }
  const contents = readFileSync(file, 'utf8')
  const manifest = parseManifest(contents)
  const lock = readPackLock(absolute) ?? null
  return {
    path: absolute,
    manifestFile: file,
    lockFile: packLockPath(absolute),
    manifest,
    revision: createHash('sha256').update(contents).digest('hex'),
    lock,
    drift: lock ? lockDrift(manifest, lock) : null
  }
}

export function createPack(root: string, input: { name: string; version?: string; targetId: string; baselineGroups?: string[] }): PackWorkspace {
  const absolute = path.resolve(root)
  mkdirSync(absolute, { recursive: true })
  const file = packManifestPath(absolute)
  if (existsSync(file)) {
    fail('PACK_EXISTS', `${absolute} 已经有 ${PACK_MANIFEST_FILE}。请用 load 读取，或换一个目录建立新整合包。`)
  }
  const manifest = packManifestSchema.parse(emptyPackManifest(input))
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return loadPackWorkspace(absolute)
}

export function savePackManifest(root: string, input: { manifest: PackManifest; expectedRevision: string }): PackWorkspace {
  const absolute = path.resolve(root)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    fail('PACK_NOT_FOUND', `整合包目录不存在：${absolute}。请先调用 create。`)
  }
  const file = packManifestPath(absolute)
  assertRevision('保存 pack.json', revisionOf(file), input.expectedRevision)
  const parsed = packManifestSchema.safeParse(input.manifest)
  if (!parsed.success) fail('PACK_INVALID', `${PACK_MANIFEST_FILE} 不合法：${describeIssues(parsed.error)}`)
  writeAtomic(file, `${JSON.stringify(parsed.data, null, 2)}\n`)
  return loadPackWorkspace(absolute)
}

export function addPackEntries(root: string, input: { entries: readonly PackEntry[]; expectedRevision: string }): { workspace: PackWorkspace; added: number; replaced: number } {
  const workspace = loadPackWorkspace(root)
  assertRevision('添加条目', workspace.revision, input.expectedRevision)

  const parsed = input.entries.map((entry) => {
    const result = packEntrySchema.safeParse(entry)
    if (!result.success) fail('PACK_ENTRY_INVALID', `条目 ${String(entry?.entryId ?? '?')} 不合法：${describeIssues(result.error)}`)
    return result.data
  })

  const byId = new Map(workspace.manifest.entries.map((entry) => [entry.entryId, entry]))
  const fileNameOwners = new Map(workspace.manifest.entries.map((entry) => [entry.fileName.toLowerCase(), entry.entryId]))
  let added = 0
  let replaced = 0

  for (const entry of parsed) {
    const owner = fileNameOwners.get(entry.fileName.toLowerCase())
    if (owner && owner !== entry.entryId) {
      fail('PACK_ENTRY_FILE_CONFLICT', `条目 ${entry.entryId} 的文件名 ${entry.fileName} 已被 ${owner} 占用。整合包安装时同名 jar 会互相覆盖，请先移除旧条目。`)
    }
    if (byId.has(entry.entryId)) {
      const previous = byId.get(entry.entryId)!
      fileNameOwners.delete(previous.fileName.toLowerCase())
      replaced++
    } else {
      added++
    }
    byId.set(entry.entryId, entry)
    fileNameOwners.set(entry.fileName.toLowerCase(), entry.entryId)
  }

  const saved = savePackManifest(root, {
    manifest: { ...workspace.manifest, entries: [...byId.values()] },
    expectedRevision: workspace.revision
  })
  return { workspace: saved, added, replaced }
}

export function removePackEntries(root: string, input: { entryIds: readonly string[]; expectedRevision: string }): { workspace: PackWorkspace; removed: string[] } {
  const workspace = loadPackWorkspace(root)
  assertRevision('移除条目', workspace.revision, input.expectedRevision)
  const wanted = new Set(input.entryIds)
  const removed = workspace.manifest.entries.filter((entry) => wanted.has(entry.entryId)).map((entry) => entry.entryId)
  const saved = savePackManifest(root, {
    manifest: { ...workspace.manifest, entries: workspace.manifest.entries.filter((entry) => !wanted.has(entry.entryId)) },
    expectedRevision: workspace.revision
  })
  return { workspace: saved, removed }
}

export function setPackEntryEnabled(root: string, input: { entryId: string; enabled: boolean; expectedRevision: string }): PackWorkspace {
  const workspace = loadPackWorkspace(root)
  assertRevision('修改条目', workspace.revision, input.expectedRevision)
  if (!workspace.manifest.entries.some((entry) => entry.entryId === input.entryId)) {
    fail('PACK_ENTRY_NOT_FOUND', `整合包里没有条目 ${input.entryId}。请刷新清单后重试。`)
  }
  return savePackManifest(root, {
    manifest: {
      ...workspace.manifest,
      entries: workspace.manifest.entries.map((entry) => entry.entryId === input.entryId ? { ...entry, enabled: input.enabled } : entry)
    },
    expectedRevision: workspace.revision
  })
}

export function writePackLock(root: string, lock: PackLock): { file: string; lock: PackLock; drift: { missingInLock: string[]; extraInLock: string[] } } {
  const workspace = loadPackWorkspace(root)
  const parsed = packLockSchema.safeParse(lock)
  if (!parsed.success) fail('PACK_LOCK_INVALID', `${PACK_LOCK_FILE} 不合法：${describeIssues(parsed.error)}`)
  const file = packLockPath(root)
  writeAtomic(file, `${JSON.stringify(parsed.data, null, 2)}\n`)
  return { file, lock: parsed.data, drift: lockDrift(workspace.manifest, parsed.data) }
}
