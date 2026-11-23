/**
 * Where bulky build state lives.
 *
 * A mod build writes several gigabytes into Gradle's user home (the wrapper
 * distribution, Loom/Minecraft caches, downloaded JDKs) and into Gradle's temp
 * directory. Keeping that under the plugin data directory puts it on the system
 * drive for a default Windows install, so this module resolves one cache root
 * separately from the small data root and reports exactly where it went.
 *
 * The resolver is read-only: inspection never creates directories. Only a real
 * build calls `ensureStorageDirs`. Nothing here deletes or moves an existing
 * cache on its own; migration and cleanup stay explicit tool actions.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { cp, opendir, stat, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type StorageSource = 'env' | 'gradle-env' | 'configured' | 'existing' | 'auto' | 'default'

export type StorageDrive = { root: string; freeBytes: number; totalBytes: number; system?: boolean }

export type StorageStatus = {
  dataRoot: string
  cacheRoot: string
  source: StorageSource
  gradleUserHome: string
  temporaryDirectory: string
  /** False when GRADLE_USER_HOME belongs to the user and the plugin must not clean it. */
  managed: boolean
  configPath: string
  drives?: StorageDrive[]
  warning?: string
}

export type StorageConfig = { schema: 1; cacheRoot: string; source: 'configured' | 'auto'; chosenAt: string }

export type StorageOptions = {
  dataRoot: string
  projectPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  systemDrive?: string
  /** Injected by tests; defaults to the volume root of a path. */
  driveOf?: (value: string) => string
  /** Injected by tests; defaults to a PowerShell CIM query on Windows. */
  listDrives?: () => Promise<StorageDrive[]>
  /** Injected by tests; defaults to fs.statfs on the nearest existing directory. */
  freeBytes?: (root: string) => Promise<number | undefined>
  now?: () => Date
}

export const STORAGE_FILE = 'storage.json'
export const STORAGE_MARKER = '.modcrafting-cache.json'
export const SYSTEM_FREE_THRESHOLD = 20 * 1024 ** 3
export const CANDIDATE_FREE_MIN = 5 * 1024 ** 3
export const CHOOSE_FREE_MIN = 10 * 1024 ** 3

export function storageFilePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), STORAGE_FILE)
}

export function gradleHomeFor(cacheRoot: string): string {
  return path.join(path.resolve(cacheRoot), 'gradle')
}

export function temporaryDirectoryFor(cacheRoot: string): string {
  return path.join(path.resolve(cacheRoot), 'tmp')
}

export function cacheRootForDrive(drive: string): string {
  return path.join(drive, 'ModCrafting', 'cache')
}

export function isStorageCacheRoot(root: string): boolean {
  try { return statSync(path.join(path.resolve(root), STORAGE_MARKER)).isFile() } catch { return false }
}

export function readStorageConfig(dataRoot: string): StorageConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(storageFilePath(dataRoot), 'utf8')) as Partial<StorageConfig>
    if (value.schema !== 1 || typeof value.cacheRoot !== 'string' || !path.isAbsolute(value.cacheRoot)) return undefined
    if (value.source !== 'configured' && value.source !== 'auto') return undefined
    return { schema: 1, cacheRoot: path.resolve(value.cacheRoot), source: value.source, chosenAt: typeof value.chosenAt === 'string' ? value.chosenAt : '' }
  } catch { return undefined }
}

export function writeStorageConfig(dataRoot: string, config: StorageConfig): string {
  const target = storageFilePath(dataRoot)
  mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
  return target
}

function writeMarker(root: string, now: Date): void {
  mkdirSync(root, { recursive: true })
  const file = path.join(root, STORAGE_MARKER)
  if (existsSync(file)) return
  writeFileSync(file, `${JSON.stringify({ schema: 1, kind: 'gradle', createdAt: now.toISOString() }, null, 2)}\n`, 'utf8')
}

function sourceLabel(source: StorageSource): string {
  return source === 'env' ? 'MODCRAFTING_CACHE'
    : source === 'gradle-env' ? 'GRADLE_USER_HOME'
      : source === 'configured' ? '已保存的缓存配置'
        : source === 'existing' ? '已有缓存目录'
          : source === 'auto' ? '自动选择'
            : '默认数据目录'
}

export function storageSourceLabel(source: StorageSource): string {
  return sourceLabel(source)
}

function sameDrive(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (!relative) return true
  if (path.isAbsolute(relative)) return false
  return relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function looksLikeGradleInstall(home: string): boolean {
  const base = path.basename(home).toLowerCase()
  if (base === 'jars' || base === 'lib') return true
  try {
    const launcher = readdirSync(home).some((name) => /^gradle-launcher-.*\.jar$/.test(name))
    const parent = path.dirname(home)
    return launcher && (existsSync(path.join(parent, 'bin', 'gradle')) || existsSync(path.join(parent, 'bin', 'gradle.bat')))
  } catch { return false }
}

export async function defaultFreeBytes(root: string): Promise<number | undefined> {
  let current = path.resolve(root)
  for (let depth = 0; depth < 64; depth++) {
    try { if (statSync(current).isDirectory()) break } catch { /* walk to an existing ancestor */ }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    const value = await statfs(current)
    return Number(value.bavail) * Number(value.bsize)
  } catch { return undefined }
}

export function parseWindowsDriveList(output: string): StorageDrive[] {
  try {
    const parsed = JSON.parse(output) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as { DeviceID?: unknown; FreeSpace?: unknown; Size?: unknown }
      if (typeof item.DeviceID !== 'string' || !/^[A-Za-z]:$/.test(item.DeviceID)) return []
      const free = Number(item.FreeSpace), total = Number(item.Size)
      if (!Number.isFinite(free) || !Number.isFinite(total)) return []
      return [{ root: `${item.DeviceID}\\`, freeBytes: free, totalBytes: total }]
    })
  } catch { return [] }
}

let driveCache: { at: number; value: StorageDrive[] } | undefined

/** Fixed local disks only. Network and removable drives never receive a cache automatically. */
export async function listWindowsDrives(): Promise<StorageDrive[]> {
  if (process.platform !== 'win32') return []
  if (driveCache && Date.now() - driveCache.at < 60_000) return driveCache.value
  const script = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress'
  const value = await new Promise<string>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve('') }, 3000)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(output) })
  })
  const drives = parseWindowsDriveList(value)
  driveCache = { at: Date.now(), value: drives }
  return drives
}

function managedStatus(options: { dataRoot: string; cacheRoot: string; source: StorageSource; drives?: StorageDrive[]; warning?: string; configPath: string }): StorageStatus {
  return {
    dataRoot: path.resolve(options.dataRoot), cacheRoot: path.resolve(options.cacheRoot), source: options.source,
    gradleUserHome: gradleHomeFor(options.cacheRoot), temporaryDirectory: temporaryDirectoryFor(options.cacheRoot),
    managed: true, configPath: options.configPath, ...(options.drives ? { drives: options.drives } : {}), ...(options.warning ? { warning: options.warning } : {})
  }
}

function hasEntries(directory: string): boolean {
  try { return statSync(directory).isDirectory() && readdirSync(directory).length > 0 } catch { return false }
}

export async function resolveStorage(options: StorageOptions): Promise<StorageStatus> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const dataRoot = path.resolve(options.dataRoot)
  const configPath = storageFilePath(dataRoot)
  const driveOf = options.driveOf ?? ((value: string) => path.parse(path.resolve(value)).root)
  const systemDrive = options.systemDrive ?? (platform === 'win32' ? `${env.SystemDrive?.replace(/[\\/]+$/, '') || 'C'}:\\` : '/')
  const freeBytes = options.freeBytes ?? defaultFreeBytes
  const warnings: string[] = []

  const explicit = env.MODCRAFTING_CACHE
  if (explicit !== undefined) {
    if (!explicit.trim() || !path.isAbsolute(explicit)) warnings.push('MODCRAFTING_CACHE 必须是绝对路径，已忽略该设置。')
    else return managedStatus({ dataRoot, cacheRoot: explicit, source: 'env', configPath })
  }

  const gradleEnv = env.GRADLE_USER_HOME
  if (gradleEnv?.trim()) {
    if (!path.isAbsolute(gradleEnv)) warnings.push('GRADLE_USER_HOME 必须是绝对路径，已忽略该设置。')
    else {
      const gradleHome = path.resolve(gradleEnv)
      if (looksLikeGradleInstall(gradleHome)) warnings.push(`GRADLE_USER_HOME 看起来指向 Gradle 安装目录而不是缓存目录（${gradleHome}）；建议改用专用缓存目录，例如另一块盘上的 ModCrafting\\cache\\gradle。`)
      const gradleFree = await freeBytes(driveOf(gradleHome))
      if (sameDrive(driveOf(gradleHome), systemDrive, platform) && (gradleFree === undefined || gradleFree < SYSTEM_FREE_THRESHOLD)) warnings.push(`GRADLE_USER_HOME 仍在系统盘（${systemDrive}）；可用 modcrafting_toolchain action="storage-write" 指定其他磁盘，或 action="migrate" 迁移现有缓存。`)
      return {
        dataRoot, cacheRoot: gradleHome, source: 'gradle-env', gradleUserHome: gradleHome,
        temporaryDirectory: temporaryDirectoryFor(path.join(dataRoot, 'cache')), managed: false, configPath,
        ...(warnings.length ? { warning: warnings.join(' ') } : {})
      }
    }
  }

  const configured = readStorageConfig(dataRoot)
  if (configured && existsSync(driveOf(configured.cacheRoot))) {
    return managedStatus({ dataRoot, cacheRoot: configured.cacheRoot, source: configured.source === 'auto' ? 'auto' : 'configured', configPath, ...(warnings.length ? { warning: warnings.join(' ') } : {}) })
  }

  const legacy = path.join(dataRoot, 'cache')
  if (hasEntries(legacy)) {
    return managedStatus({ dataRoot, cacheRoot: legacy, source: 'existing', configPath, ...(warnings.length ? { warning: warnings.join(' ') } : {}) })
  }

  let drives: StorageDrive[] | undefined
  let drivesPromise: Promise<StorageDrive[]> | undefined
  const loadDrives = async () => {
    if (platform !== 'win32') return []
    drivesPromise ??= (options.listDrives ?? listWindowsDrives)()
    drives = await drivesPromise
    return drives
  }
  const freeOf = async (drive: string): Promise<number | undefined> => {
    const known = drives?.find((entry) => sameDrive(entry.root, drive, platform))
    if (known) return known.freeBytes
    return await freeBytes(drive)
  }
  const dataDrive = driveOf(dataRoot)
  const dataIsSystem = sameDrive(dataDrive, systemDrive, platform)
  const projectDrive = options.projectPath ? driveOf(options.projectPath) : undefined

  let chosen: { root: string; source: StorageSource } | undefined
  if (!dataIsSystem) {
    const free = await freeOf(dataDrive)
    if (free === undefined || free >= CANDIDATE_FREE_MIN) chosen = { root: legacy, source: 'default' }
  }

  if (!chosen) {
    const fixed = await loadDrives()
    const marked = fixed.filter((drive) => isStorageCacheRoot(cacheRootForDrive(drive.root)))
    if (marked.length) {
      const onProject = projectDrive ? marked.find((drive) => sameDrive(drive.root, projectDrive, platform)) : undefined
      const pick = onProject ?? [...marked].sort((left, right) => right.freeBytes - left.freeBytes)[0]
      chosen = { root: cacheRootForDrive(pick.root), source: 'auto' }
    }
  }

  if (!chosen && projectDrive && platform === 'win32' && !sameDrive(projectDrive, systemDrive, platform)) {
    const free = await freeOf(projectDrive)
    if (free !== undefined && free >= CANDIDATE_FREE_MIN) chosen = { root: cacheRootForDrive(projectDrive), source: 'auto' }
  }

  if (!chosen && !dataIsSystem) {
    const free = await freeOf(dataDrive)
    if (free === undefined || free >= CANDIDATE_FREE_MIN) chosen = { root: legacy, source: 'default' }
  }

  if (!chosen && platform === 'win32') {
    const fixed = await loadDrives()
    const system = fixed.find((drive) => sameDrive(drive.root, systemDrive, platform))
    const systemFree = system?.freeBytes ?? await freeOf(systemDrive)
    if (systemFree !== undefined && systemFree < SYSTEM_FREE_THRESHOLD) {
      const roomy = fixed.filter((drive) => !sameDrive(drive.root, systemDrive, platform) && drive.freeBytes >= CHOOSE_FREE_MIN)
        .sort((left, right) => right.freeBytes - left.freeBytes)[0]
      if (roomy) chosen = { root: cacheRootForDrive(roomy.root), source: 'auto' }
    }
  }

  if (!chosen) chosen = { root: legacy, source: 'default' }

  const chosenDrive = driveOf(chosen.root)
  const chosenFree = await freeOf(chosenDrive)
  if (sameDrive(chosenDrive, systemDrive, platform) && (chosenFree === undefined || chosenFree < SYSTEM_FREE_THRESHOLD)) warnings.push(`构建缓存仍在系统盘（${systemDrive}）；可用 modcrafting_toolchain action="storage-write" 指定其他磁盘，或 action="migrate" 迁移现有缓存。`)
  if (chosenFree !== undefined && chosenFree < CANDIDATE_FREE_MIN) warnings.push(`缓存所在磁盘剩余空间不足 5 GB（${chosenDrive}）。`)
  const markedDrives = drives ? drives.map((drive) => ({ ...drive, system: sameDrive(drive.root, systemDrive, platform) })) : undefined
  return managedStatus({
    dataRoot, cacheRoot: chosen.root, source: chosen.source, configPath,
    ...(markedDrives ? { drives: markedDrives } : {}), ...(warnings.length ? { warning: warnings.join(' ') } : {})
  })
}

/** Create the cache on a real build, record a shareable marker and freeze an automatic choice. */
export function ensureStorageDirs(status: StorageStatus, now: Date = new Date()): void {
  mkdirSync(status.gradleUserHome, { recursive: true })
  mkdirSync(status.temporaryDirectory, { recursive: true })
  if (!status.managed) return
  writeMarker(status.cacheRoot, now)
  if ((status.source === 'auto' || status.source === 'default') && !readStorageConfig(status.dataRoot)) {
    writeStorageConfig(status.dataRoot, { schema: 1, cacheRoot: status.cacheRoot, source: 'auto', chosenAt: now.toISOString() })
  }
}

function validateCacheRoot(cacheRoot: string): string {
  if (!cacheRoot?.trim() || !path.isAbsolute(cacheRoot)) throw new Error('缓存目录必须是绝对路径。')
  const resolved = path.resolve(cacheRoot)
  if (resolved === path.parse(resolved).root) throw new Error('缓存目录不能是磁盘根目录。')
  return resolved
}

/** Explain that an environment variable keeps overriding a cache choice just saved to disk. */
export function withEnvPrecedenceWarning(status: StorageStatus): StorageStatus {
  if (status.source !== 'env' && status.source !== 'gradle-env') return status
  const label = status.source === 'env' ? 'MODCRAFTING_CACHE' : 'GRADLE_USER_HOME'
  return { ...status, warning: [status.warning, `${label} 环境变量优先于已保存的缓存配置；要让新目录生效，请修改或移除该环境变量。`].filter((value): value is string => Boolean(value)).join(' ') }
}

export async function configureStorage(options: StorageOptions & { cacheRoot: string }): Promise<StorageStatus> {
  const cacheRoot = validateCacheRoot(options.cacheRoot)
  const now = options.now ?? (() => new Date())
  try { mkdirSync(cacheRoot, { recursive: true }) }
  catch (cause) { throw new Error(`缓存目录无法创建：${cacheRoot}（${String(cause)}）。请选择可写目录，例如其他盘上的 ModCrafting\\cache。`) }
  writeMarker(cacheRoot, now())
  writeStorageConfig(path.resolve(options.dataRoot), { schema: 1, cacheRoot, source: 'configured', chosenAt: now().toISOString() })
  return withEnvPrecedenceWarning(await resolveStorage(options))
}

export type StorageUsage = { bytes: number; files: number; truncated: boolean }

export async function storageUsage(root: string, budgetMs = 1500): Promise<StorageUsage> {
  const started = Date.now()
  let bytes = 0, files = 0, entries = 0, truncated = false
  const stack = [path.resolve(root)]
  while (stack.length) {
    if (Date.now() - started > budgetMs || entries > 200_000) { truncated = true; break }
    const current = stack.pop()!
    let directory
    try { directory = await opendir(current) } catch { continue }
    try {
      for await (const entry of directory) {
        entries++
        if (entry.isSymbolicLink()) continue
        const target = path.join(current, entry.name)
        if (entry.isDirectory()) { stack.push(target); continue }
        if (!entry.isFile()) continue
        try { const info = await stat(target); bytes += info.size; files++ }
        catch { /* a file that vanished mid-walk does not fail the report */ }
      }
    } finally { await directory.close().catch(() => {}) }
  }
  return { bytes, files, truncated }
}

export async function migrateStorage(options: StorageOptions & { targetRoot: string }): Promise<{ from: string; to: string; bytes: number; files: number }> {
  const current = await resolveStorage(options)
  const targetRoot = validateCacheRoot(options.targetRoot)
  if (sameDrive(current.cacheRoot, targetRoot, options.platform ?? process.platform) || sameDrive(current.gradleUserHome, gradleHomeFor(targetRoot), options.platform ?? process.platform)) {
    throw new Error('目标目录就是当前缓存目录，无需迁移。')
  }
  const destination = gradleHomeFor(targetRoot)
  if (hasEntries(destination)) throw new Error(`迁移目标已经包含 Gradle 缓存（非空）：${destination}。请选择空目录，避免覆盖。`)
  const usage = await storageUsage(current.gradleUserHome, 5000)
  let files = usage.files
  if (existsSync(current.gradleUserHome)) {
    try { await cp(current.gradleUserHome, destination, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true }) }
    catch (cause) { throw new Error(`复制 Gradle 缓存失败：${String(cause)}。请先停止构建和游戏，再重试。`) }
  } else mkdirSync(destination, { recursive: true })
  const now = options.now ?? (() => new Date())
  writeMarker(targetRoot, now())
  writeStorageConfig(path.resolve(options.dataRoot), { schema: 1, cacheRoot: targetRoot, source: 'configured', chosenAt: now().toISOString() })
  const copied = await storageUsage(destination, 5000)
  return { from: current.gradleUserHome, to: destination, bytes: Math.max(usage.bytes, copied.bytes), files: Math.max(files, copied.files) }
}

export async function cleanStorage(options: StorageOptions & { targetRoot?: string }): Promise<{ removed: string[]; freedBytes: number }> {
  const platform = options.platform ?? process.platform
  const current = await resolveStorage(options)
  const dataRoot = path.resolve(options.dataRoot)
  const target = path.resolve(options.targetRoot ?? path.join(dataRoot, 'cache'))
  if (sameDrive(target, current.cacheRoot, platform) || isInside(target, current.cacheRoot)) {
    throw new Error('不能清理当前活动的缓存目录。先迁移到其他目录，再清理旧缓存。')
  }
  const legacy = sameDrive(target, path.join(dataRoot, 'cache'), platform)
  if (!legacy && !isStorageCacheRoot(target)) throw new Error('这个目录不是插件缓存（缺少缓存标记）。为安全起见不删除；请确认路径，或只清理带插件标记的目录。')
  if (sameDrive(target, dataRoot, platform) || target === path.parse(target).root) throw new Error('拒绝清理数据根目录或磁盘根目录。')
  if (!existsSync(target)) return { removed: [], freedBytes: 0 }
  const usage = await storageUsage(target)
  const removed: string[] = []
  for (const name of ['gradle', 'tmp', 'projects']) {
    const directory = path.join(target, name)
    if (!existsSync(directory)) continue
    rmSync(directory, { recursive: true, force: true })
    removed.push(directory)
  }
  const marker = path.join(target, STORAGE_MARKER)
  if (existsSync(marker)) { unlinkSync(marker); removed.push(marker) }
  try { if (existsSync(target) && readdirSync(target).length === 0) rmdirSync(target) } catch { /* leave a non-empty directory alone */ }
  return { removed, freedBytes: usage.bytes }
}

/** The Gradle homes a local Minecraft client jar may live in, most specific first. */
export function visualGradleHomes(dataRoot: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const homes: string[] = []
  const add = (home: string | undefined) => { if (!home || !path.isAbsolute(home)) return; const resolved = path.resolve(home); if (!homes.includes(resolved)) homes.push(resolved) }
  const explicit = env.MODCRAFTING_CACHE
  if (explicit) add(gradleHomeFor(explicit))
  const configured = readStorageConfig(dataRoot)
  if (configured) add(gradleHomeFor(configured.cacheRoot))
  add(env.GRADLE_USER_HOME)
  add(path.join(path.resolve(dataRoot), 'cache', 'gradle'))
  const home = env.USERPROFILE || env.HOME || os.homedir()
  add(path.join(home, '.gradle'))
  return homes
}
