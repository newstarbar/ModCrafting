/**
 * Exporting a solved pack.
 *
 * Two destinations, one rule: the export must be reproducible from the lockfile.
 * `.mrpack` writes the Modrinth index and URL references; a Prism/MultiMC
 * instance directory writes the launcher metadata and copies only jars whose
 * license allows redistribution. Neither path downloads mods, and neither inlines
 * bytes it has no right to redistribute.
 *
 * Export refuses to run from a stale lock. A lock that no longer matches
 * `pack.json` would produce a package that disagrees with the workspace, which is
 * worse than a failed export.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PACK_LOCK_FILE } from '../pack-model.ts'
import type { LockedEntry, PackLock } from '../pack-model.ts'
import type { EntrySide, PackEntry } from '../workspace-model.ts'
import type { LoaderId } from '../version/schema.ts'
import { parseTargetId, resolveTarget } from '../version/targets.ts'
import { safeEntryFileName } from './pack-entry.ts'
import { loadPackWorkspace, type PackWorkspace } from './pack-workspace.ts'
import { createZip } from './zip.ts'

export type PackExportKind = 'mrpack' | 'prism'

export interface PackExportInput {
  root: string
  kind: PackExportKind
  /** Relative to the pack root. Defaults to `dist/`. Absolute paths are refused if outside the pack. */
  outputDir?: string
  /** Overrides the loader version from the shipped matrix (use when the matrix has no cell). */
  loaderVersion?: string
  /** Metadata only; the archive itself is deterministic. */
  generatedAt?: string
  overwrite?: boolean
}

export interface PackExportResult {
  ok: true
  kind: PackExportKind
  /** Absolute path of the `.mrpack` file, or of the instance directory. */
  file: string
  bytes: number
  targetId: string
  loaderVersion: string
  warnings: string[]
  /** Paths inside the exported package, sorted. */
  files: string[]
}

const LOADER_COMPONENT: Readonly<Record<LoaderId, string>> = {
  fabric: 'net.fabricmc.fabric-loader',
  neoforge: 'net.neoforged',
  forge: 'net.minecraftforge'
}

const MRPACK_DEPENDENCY: Readonly<Record<LoaderId, string>> = {
  fabric: 'fabric-loader',
  neoforge: 'neoforge',
  forge: 'forge'
}

const OVERRIDE_DIRECTORIES = ['config', 'defaultconfigs'] as const
const MAX_OVERRIDE_FILES = 2000
const MAX_OVERRIDE_BYTES = 64 * 1024 * 1024

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function slugOf(name: string, fallback: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || fallback
}

function resolveOutputDir(root: string, outputDir: string | undefined): string {
  const absoluteRoot = path.resolve(root)
  const target = outputDir ? path.resolve(absoluteRoot, outputDir) : path.join(absoluteRoot, 'dist')
  const relative = path.relative(absoluteRoot, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('EXPORT_PATH_FORBIDDEN', `导出目录必须位于整合包目录内（当前：${target}）。请改用相对路径，例如 dist 或 build/export。`)
  }
  return target
}

function loaderVersionFor(manifestTarget: string, override?: string): { loader: LoaderId; minecraft: string; loaderVersion: string } {
  const { loader, minecraft } = parseTargetId(manifestTarget)
  if (override) return { loader, minecraft, loaderVersion: override }
  try {
    const resolved = resolveTarget(loader, minecraft)
    const version = resolved.release.loaderVersion
    if (version) return { loader, minecraft, loaderVersion: version }
  } catch {
    // Fall through to the actionable error below: the matrix has no cell for this
    // target, and guessing a loader build would produce a package that cannot start.
  }
  fail(
    'EXPORT_LOADER_VERSION_REQUIRED',
    `版本矩阵里没有 ${manifestTarget} 的加载器版本，无法写出启动器元数据。请显式传入 loaderVersion，或先运行 pnpm run versions:sync 更新矩阵。`
  )
}

function mrpackEnvironment(side: EntrySide | undefined): { client: string; server: string } {
  if (side === 'client') return { client: 'required', server: 'unsupported' }
  if (side === 'server') return { client: 'unsupported', server: 'required' }
  return { client: 'required', server: 'required' }
}

/**
 * The lock is the source of truth for bytes and versions, but the manifest is the
 * source of truth for inclusion. A disagreement in file name or target means the
 * lock predates an edit, so exporting would ship the wrong jar.
 */
function assertLockFresh(workspace: PackWorkspace): { lock: PackLock; manifestEntries: PackEntry[] } {
  const { lock, manifest } = workspace
  if (!lock) {
    fail('PACK_LOCK_MISSING', `还没有 ${PACK_LOCK_FILE}。先求解（modcrafting_pack_solve）生成锁文件，再导出。`)
  }
  if (lock.targetId !== manifest.targetId) {
    fail('PACK_LOCK_STALE', `锁文件的目标是 ${lock.targetId}，清单已经把目标改为 ${manifest.targetId}。请重新求解后再导出。`)
  }
  if (workspace.drift && (workspace.drift.missingInLock.length > 0 || workspace.drift.extraInLock.length > 0)) {
    const detail = [
      workspace.drift.missingInLock.length > 0 ? `缺少 ${workspace.drift.missingInLock.join(', ')}` : '',
      workspace.drift.extraInLock.length > 0 ? `多出 ${workspace.drift.extraInLock.join(', ')}` : ''
    ].filter(Boolean).join('；')
    fail('PACK_LOCK_STALE', `锁文件与清单不一致（${detail}）。请重新求解后再导出。`)
  }
  const lockedById = new Map(lock.entries.map((entry) => [entry.entryId, entry]))
  const enabled = manifest.entries.filter((entry) => entry.enabled)
  for (const entry of enabled) {
    const locked = lockedById.get(entry.entryId)
    if (!locked) fail('PACK_LOCK_STALE', `清单条目 ${entry.entryId} 不在锁文件里。请重新求解后再导出。`)
    if (locked.fileName !== entry.fileName) {
      fail('PACK_LOCK_STALE', `清单条目 ${entry.entryId} 的文件名已从 ${locked.fileName} 改为 ${entry.fileName}。请重新求解后再导出。`)
    }
  }
  return { lock, manifestEntries: enabled }
}

interface OverrideFile {
  /** Forward-slash path relative to the pack root, e.g. `config/example.json`. */
  relativePath: string
  data: Buffer
}

function collectOverrides(root: string, warnings: string[]): OverrideFile[] {
  const files: OverrideFile[] = []
  let total = 0

  const walk = (relativeDirectory: string): void => {
    const absolute = path.join(root, ...relativeDirectory.split('/'))
    if (!existsSync(absolute)) return
    for (const name of readdirSync(absolute).sort()) {
      const relative = `${relativeDirectory}/${name}`
      const absoluteFile = path.join(absolute, name)
      const stats = lstatSync(absoluteFile)
      if (stats.isSymbolicLink()) {
        warnings.push(`跳过符号链接 ${relative}：导出包不跟随指向包外的链接。`)
        continue
      }
      if (stats.isDirectory()) { walk(relative); continue }
      if (!stats.isFile()) continue
      if (files.length >= MAX_OVERRIDE_FILES) {
        fail('EXPORT_TOO_LARGE', `配置覆盖层超过 ${MAX_OVERRIDE_FILES} 个文件，请只导出真正需要的配置目录。`)
      }
      total += stats.size
      if (total > MAX_OVERRIDE_BYTES) {
        fail('EXPORT_TOO_LARGE', `配置覆盖层超过 ${Math.floor(MAX_OVERRIDE_BYTES / 1024 / 1024)}MB，请精简 config/defaultconfigs。`)
      }
      files.push({ relativePath: relative, data: readFileSync(absoluteFile) })
    }
  }

  for (const directory of OVERRIDE_DIRECTORIES) walk(directory)
  return files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
}

interface ExportPayload {
  entries: LockedEntry[]
  warnings: string[]
}

function selectEntries(manifestEntries: readonly PackEntry[], lock: PackLock, warnings: string[]): ExportPayload {
  const lockedById = new Map(lock.entries.map((entry) => [entry.entryId, entry]))
  const entries: LockedEntry[] = []
  for (const entry of manifestEntries) {
    const locked = lockedById.get(entry.entryId)
    if (!locked) continue
    if (!safeEntryFileName(locked.fileName)) {
      fail('EXPORT_ENTRY_UNSAFE', `条目 ${entry.entryId} 的文件名 ${locked.fileName} 不能作为包内 jar 名。请修正清单后重新求解。`)
    }
    if (!locked.license.redistributable) {
      warnings.push(`${entry.entryId} 的许可证（${locked.license.id}）不允许再分发，导出只写官方下载引用，不内联字节。`)
    }
    entries.push(locked)
  }
  return { entries, warnings }
}

function buildMrpackIndex(input: {
  workspace: PackWorkspace
  entries: readonly LockedEntry[]
  loader: LoaderId
  minecraft: string
  loaderVersion: string
  warnings: string[]
}): string {
  const { manifest } = input.workspace
  const files = input.entries.flatMap((entry) => {
    if (!entry.downloadUrl) {
      input.warnings.push(`${entry.entryId} 没有公开下载地址，已从 .mrpack 中省略；请改为本地 Prism 实例或随包分发。`)
      return []
    }
    if (!entry.hashes.sha1 && !entry.hashes.sha512) {
      input.warnings.push(`${entry.entryId} 没有任何哈希，启动器无法校验下载，已从 .mrpack 中省略。`)
      return []
    }
    return [{
      path: `mods/${entry.fileName}`,
      hashes: { ...entry.hashes },
      env: mrpackEnvironment(entry.side),
      downloads: [entry.downloadUrl],
      ...(entry.size !== undefined ? { fileSize: entry.size } : {})
    }]
  })

  return `${JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: manifest.version,
    name: manifest.name,
    ...(manifest.notes ? { summary: manifest.notes } : {}),
    files,
    dependencies: {
      minecraft: input.minecraft,
      [MRPACK_DEPENDENCY[input.loader]]: input.loaderVersion
    }
  }, null, 2)}\n`
}

function writeMrpack(input: {
  workspace: PackWorkspace
  outputDir: string
  file: string
  overwrite: boolean
  entries: readonly LockedEntry[]
  overrides: readonly OverrideFile[]
  loader: LoaderId
  minecraft: string
  loaderVersion: string
  warnings: string[]
}): number {
  const index = buildMrpackIndex({
    workspace: input.workspace,
    entries: input.entries,
    loader: input.loader,
    minecraft: input.minecraft,
    loaderVersion: input.loaderVersion,
    warnings: input.warnings
  })
  const zeroEnabled = input.entries.filter((entry) => !entry.downloadUrl || (!entry.hashes.sha1 && !entry.hashes.sha512))
  if (zeroEnabled.length > 0) {
    input.warnings.push(`${zeroEnabled.length} 个条目无法写入 .mrpack；这个包在启动器里会缺少这些模组。`)
  }

  const archive = createZip([
    { path: 'modrinth.index.json', data: index },
    ...input.overrides.map((file) => ({ path: `overrides/${file.relativePath}`, data: file.data }))
  ])

  if (existsSync(input.file) && !input.overwrite) {
    fail('EXPORT_EXISTS', `${input.file} 已经存在。确认要覆盖时传 overwrite=true，或换一个输出目录。`)
  }
  mkdirSync(input.outputDir, { recursive: true })
  const temporary = `${input.file}.${process.pid}.tmp`
  writeFileSync(temporary, archive)
  if (existsSync(input.file)) unlinkSync(input.file)
  renameSync(temporary, input.file)
  return archive.length
}

function writeFileInside(directory: string, relative: string, data: string | Buffer): number {
  const file = path.join(directory, ...relative.split('/'))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
  return typeof data === 'string' ? Buffer.byteLength(data) : data.length
}

function writePrism(input: {
  workspace: PackWorkspace
  root: string
  directory: string
  overwrite: boolean
  entries: readonly LockedEntry[]
  overrides: readonly OverrideFile[]
  loader: LoaderId
  minecraft: string
  loaderVersion: string
  warnings: string[]
  generatedAt: string
}): { bytes: number; files: string[]; missing: string[] } {
  const manifest = input.workspace.manifest
  const mmc = {
    formatVersion: 1,
    components: [
      { uid: 'net.minecraft', version: input.minecraft, important: true },
      { uid: LOADER_COMPONENT[input.loader], version: input.loaderVersion }
    ]
  }
  const files: string[] = []
  const missing: string[] = []
  let bytes = 0

  if (existsSync(input.directory)) {
    const recognizable = statSync(input.directory).isDirectory() && existsSync(path.join(input.directory, 'mmc-pack.json'))
    if (!input.overwrite) {
      fail('EXPORT_EXISTS', `${input.directory} 已经存在。确认要覆盖时传 overwrite=true，或换一个输出目录。`)
    }
    if (!recognizable) {
      fail('EXPORT_EXISTS', `${input.directory} 已存在且不像 ModCrafting 导出的 Prism 实例（缺少 mmc-pack.json），为安全起见不覆盖。请手动清理或换一个目录。`)
    }
    rmSync(input.directory, { recursive: true, force: true })
  }

  const temporary = `${input.directory}.${process.pid}.tmp`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })

  try {
    bytes += writeFileInside(temporary, 'mmc-pack.json', `${JSON.stringify(mmc, null, 2)}\n`)
    files.push('mmc-pack.json')
    bytes += writeFileInside(temporary, 'instance.cfg', `InstanceType=OneSix\nname=${manifest.name}\niconKey=default\n`)
    files.push('instance.cfg')

    for (const override of input.overrides) {
      const relative = `minecraft/${override.relativePath}`
      bytes += writeFileInside(temporary, relative, override.data)
      files.push(relative)
    }

    mkdirSync(path.join(temporary, 'minecraft', 'mods'), { recursive: true })
    for (const entry of input.entries) {
      const source = path.join(input.root, 'mods', entry.fileName)
      if (!existsSync(source)) {
        missing.push(entry.entryId)
        input.warnings.push(`Prism 实例不会下载模组：${entry.fileName} 不在整合包的 mods/ 里，请在启动器中手动安装${entry.downloadUrl ? `（${entry.downloadUrl}）` : ''}。`)
        continue
      }
      if (!entry.license.redistributable) {
        missing.push(entry.entryId)
        input.warnings.push(`${entry.fileName} 的许可证（${entry.license.id}）不允许再分发，Prism 实例没有复制它；请在本机手动放入 minecraft/mods/。`)
        continue
      }
      const bytesIn = readFileSync(source)
      const relative = `minecraft/mods/${entry.fileName}`
      bytes += writeFileInside(temporary, relative, bytesIn)
      files.push(relative)
    }

    const report = {
      schemaVersion: 1,
      generatedAt: input.generatedAt,
      targetId: manifest.targetId,
      loaderVersion: input.loaderVersion,
      warnings: input.warnings,
      missing
    }
    bytes += writeFileInside(temporary, '.modcrafting-export.json', `${JSON.stringify(report, null, 2)}\n`)
    files.push('.modcrafting-export.json')

    renameSync(temporary, input.directory)
  } catch (cause) {
    rmSync(temporary, { recursive: true, force: true })
    throw cause
  }

  return { bytes, files: files.sort(), missing }
}

export function exportPack(input: PackExportInput): PackExportResult {
  const workspace = loadPackWorkspace(input.root)
  const { lock, manifestEntries } = assertLockFresh(workspace)
  const outputDir = resolveOutputDir(workspace.path, input.outputDir)
  const { loader, minecraft, loaderVersion } = loaderVersionFor(workspace.manifest.targetId, input.loaderVersion)
  const warnings: string[] = []
  const { entries } = selectEntries(manifestEntries, lock, warnings)
  const overrides = collectOverrides(workspace.path, warnings)
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const baseName = `${slugOf(workspace.manifest.name, 'pack')}-${workspace.manifest.version}`

  if (input.kind === 'mrpack') {
    const file = path.join(outputDir, `${baseName}.mrpack`)
    const bytes = writeMrpack({
      workspace,
      outputDir,
      file,
      overwrite: input.overwrite === true,
      entries,
      overrides,
      loader,
      minecraft,
      loaderVersion,
      warnings
    })
    return {
      ok: true,
      kind: 'mrpack',
      file,
      bytes,
      targetId: workspace.manifest.targetId,
      loaderVersion,
      warnings,
      files: ['modrinth.index.json', ...overrides.map((entry) => `overrides/${entry.relativePath}`)].sort()
    }
  }

  const directory = path.join(outputDir, baseName)
  mkdirSync(outputDir, { recursive: true })
  const written = writePrism({
    workspace,
    root: workspace.path,
    directory,
    overwrite: input.overwrite === true,
    entries,
    overrides,
    loader,
    minecraft,
    loaderVersion,
    warnings,
    generatedAt
  })
  return {
    ok: true,
    kind: 'prism',
    file: directory,
    bytes: written.bytes,
    targetId: workspace.manifest.targetId,
    loaderVersion,
    warnings,
    files: written.files
  }
}
