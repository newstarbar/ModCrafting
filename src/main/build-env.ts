import { app, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { promisify } from 'util'
import { getAppEdition, isPortableEdition, isFullEdition } from './edition'
import {
  downloadAndExtractGradle,
  downloadAndExtractJdk,
  isCompleteGradleDist
} from './toolchain-download'
import { ensureGradleHomeOnline } from './portable-prefetch'

export { getAppEdition, isPortableEdition, isFullEdition } from './edition'

const copyFileAsync = promisify(fs.copyFile)
const mkdirAsync = promisify(fs.mkdir)
const rmAsync = promisify(fs.rm)

export const GRADLE_VERSION = '9.5.0'
export const GRADLE_DIST_NAME = `gradle-${GRADLE_VERSION}-bin`
export const GRADLE_HOME_DIR = `gradle-${GRADLE_VERSION}`
export const GRADLE_RUNTIME_DIR = 'gradle-9.5'
const GRADLE_LAUNCHER_JAR = `gradle-launcher-${GRADLE_VERSION}.jar`
const SEED_MARKER = '.modcrafting-seed.json'
const SEED_ARCHIVE_NAME = 'gradle-home-seed.zip'

type FabricVersions = {
  minecraft_version: string
  loader_version: string
  fabric_version: string
  yarn_mappings: string
  loom_version: string
  gradle_version: string
}

type SeedMarker = FabricVersions & {
  fileCount?: number
  totalBytes?: number
  createdAt?: string
  verifiedOffline?: boolean
}

/** Fabric API modules required for the default template offline build. */
const REQUIRED_FABRIC_API_MODULES = [
  'fabric-api',
  'fabric-api-lookup-api-v1',
  'fabric-blockrenderlayer-v1',
  'fabric-client-tags-api-v1',
  'fabric-content-registries-v0',
  'fabric-data-generation-api-v1',
  'fabric-convention-tags-v1',
  'fabric-convention-tags-v2',
  'fabric-data-attachment-api-v1',
  'fabric-events-interaction-v0',
  'fabric-lifecycle-events-v1',
  'fabric-model-loading-api-v1',
  'fabric-screen-handler-api-v1',
  'fabric-networking-api-v1',
  'fabric-object-builder-api-v1',
  'fabric-rendering-fluids-v1',
  'fabric-rendering-data-attachment-v1',
  'fabric-block-view-api-v2',
  'fabric-client-gametest-api-v1',
  'fabric-crash-report-info-v1',
  'fabric-key-binding-api-v1',
  'fabric-resource-conditions-api-v1',
  'fabric-resource-loader-v0',
  'fabric-transitive-access-wideners-v1'
]

export type ToolchainPhase = 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'

export interface ToolchainProgressPayload {
  phase: ToolchainPhase
  message: string
  percent: number
  error?: string
}

type ProgressInput = string | ToolchainProgressPayload
type ProgressSender = (input: ProgressInput) => void

const RM_OPTS: fs.RmOptions = { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }

let gradleHomeSeedLock: Promise<{ ok: boolean; error?: string }> | null = null
let toolchainInitLock: Promise<{ ok: boolean; error?: string }> | null = null
let toolchainInitDone = false
let copyModsLock: Promise<{ copied: number; skipped: boolean }> | null = null
let copyModsLockPath: string | null = null

function modFilesMatch(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(dest)) return false
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 2000
  } catch {
    return false
  }
}

function lerpPercent(rangeStart: number, rangeEnd: number, stepPct: number): number {
  return Math.min(rangeEnd, Math.round(rangeStart + ((rangeEnd - rangeStart) * stepPct) / 100))
}

export function normalizeProgress(input: ProgressInput): ToolchainProgressPayload {
  if (typeof input !== 'string') return input

  const pctMatch = input.match(/(\d+)%/)
  const stepPct = pctMatch ? parseInt(pctMatch[1], 10) : 0

  if (input.includes('JDK')) {
    return { phase: 'jdk', message: input, percent: stepPct ? lerpPercent(5, 25, stepPct) : 12 }
  }
  if (input.includes('Gradle') && !input.includes('离线')) {
    return { phase: 'gradle', message: input, percent: stepPct ? lerpPercent(25, 35, stepPct) : 28 }
  }
  if (input.includes('离线') || input.includes('依赖')) {
    return { phase: 'deps', message: input, percent: stepPct ? lerpPercent(35, 88, stepPct) : 40 }
  }
  if (input.includes('模组') || input.includes('wrapper') || input.includes('Wrapper')) {
    return { phase: 'project', message: input, percent: stepPct ? lerpPercent(90, 99, stepPct) : 95 }
  }
  if (input.includes('项目')) {
    return { phase: 'project', message: input, percent: 92 }
  }
  if (input.includes('就绪')) {
    return { phase: 'ready', message: input, percent: 100 }
  }
  if (input.includes('不可写') || input.includes('失败') || input.includes('缺失')) {
    return { phase: 'error', message: input, percent: 0, error: input }
  }
  return { phase: 'checking', message: input, percent: 0 }
}

function emitToolchainProgress(payload: ToolchainProgressPayload): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('env:toolchainProgress', payload)
    win.webContents.send('env:downloadProgress', payload.message)
  })
}

function defaultProgress(input: ProgressInput): void {
  emitToolchainProgress(normalizeProgress(input))
}

export function createWindowProgressSender(
  send: (channel: string, payload: ToolchainProgressPayload | string) => void
): ProgressSender {
  return (input) => {
    const payload = normalizeProgress(input)
    send('env:toolchainProgress', payload)
    send('env:downloadProgress', payload.message)
  }
}

export function isToolchainInitializing(): boolean {
  return toolchainInitLock !== null || gradleHomeSeedLock !== null
}

export function isGlobalToolchainReady(): boolean {
  if (!toolchainInitDone) return false
  const status = getToolchainStatus()
  return status.jdk === 'ready' && status.gradle === 'ready' && status.deps === 'ready'
}

export function resetToolchainInitState(): void {
  toolchainInitDone = false
}

export async function initToolchain(
  onProgress: ProgressSender = defaultProgress,
  force = false
): Promise<{ ok: boolean; error?: string }> {
  if (force) toolchainInitDone = false

  if (toolchainInitDone) {
    onProgress({ phase: 'checking', message: '验证构建环境…', percent: 10 })
    onProgress({ phase: 'jdk', message: 'JDK 已就绪', percent: 30 })
    onProgress({ phase: 'gradle', message: 'Gradle 已就绪', percent: 50 })
    onProgress({ phase: 'deps', message: '离线依赖已就绪', percent: 80 })
    onProgress({ phase: 'ready', message: '构建环境已就绪', percent: 100 })
    return { ok: true }
  }
  if (toolchainInitLock) return toolchainInitLock

  toolchainInitLock = initToolchainImpl(onProgress).finally(() => {
    toolchainInitLock = null
  })
  const result = await toolchainInitLock
  if (result.ok) toolchainInitDone = true
  return result
}

async function initToolchainImpl(
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  if (isPortableEdition()) {
    return initPortableToolchainImpl(onProgress)
  }
  return initFullToolchainImpl(onProgress)
}

async function initPortableToolchainImpl(
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  onProgress({ phase: 'checking', message: '检查运行时目录（便携版需联网）…', percent: 0 })

  const writable = checkRuntimeWritable()
  if (!writable.writable) {
    const err = writable.error || '运行时目录不可写'
    onProgress({ phase: 'error', message: err, percent: 0, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'jdk', message: '准备 JDK 21（联网下载）…', percent: 5 })
  const jdk = await ensurePortableJdk(onProgress)
  if (!jdk.ok) {
    const err = jdk.error || 'JDK 21 准备失败'
    onProgress({ phase: 'error', message: err, percent: 10, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'gradle', message: '准备 Gradle（联网下载）…', percent: 25 })
  const gradleOk = await ensurePortableGradle(onProgress)
  if (!gradleOk) {
    const err = 'Gradle 下载失败，请检查网络后重试'
    onProgress({ phase: 'error', message: err, percent: 28, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'deps', message: '准备 Fabric 依赖（联网下载）…', percent: 35 })
  const deps = await ensurePortableGradleHome(onProgress)
  if (!deps.ok) {
    const err = deps.error || 'Fabric 依赖准备失败'
    onProgress({ phase: 'error', message: err, percent: 40, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'ready', message: '构建环境已就绪，可以开始开发', percent: 100 })
  return { ok: true }
}

async function ensurePortableJdk(onProgress: ProgressSender): Promise<{ ok: boolean; path?: string; error?: string }> {
  const runtimeJdk = getRuntimeJdkPath()
  if (isValidJdk(runtimeJdk)) {
    return { ok: true, path: runtimeJdk }
  }
  try {
    await downloadAndExtractJdk(runtimeJdk, getRuntimeRoot(), (msg) => {
      onProgress({ phase: 'jdk', message: msg, percent: 15 })
    })
    return isValidJdk(runtimeJdk) ? { ok: true, path: runtimeJdk } : { ok: false, error: 'JDK 验证失败' }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

async function ensurePortableGradle(onProgress: ProgressSender): Promise<boolean> {
  const dest = getRuntimeGradlePath()
  if (isCompleteGradleDist(dest)) return true
  try {
    await downloadAndExtractGradle(dest, getRuntimeRoot(), (msg) => {
      onProgress({ phase: 'gradle', message: msg, percent: 30 })
    })
    return isCompleteGradleDist(dest)
  } catch {
    return false
  }
}

function writeRuntimeSeedMarker(gradleHome: string): void {
  const expected = loadFabricVersions()
  let fileCount = 0
  let totalBytes = 0
  function walk(d: string): void {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else {
        fileCount++
        try { totalBytes += fs.statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(gradleHome)) walk(gradleHome)
  const marker: SeedMarker = {
    ...expected,
    fileCount,
    totalBytes,
    createdAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(gradleHome, SEED_MARKER), JSON.stringify(marker, null, 2), 'utf-8')
}

async function ensurePortableGradleHome(onProgress: ProgressSender): Promise<{ ok: boolean; error?: string }> {
  const runtimeRoot = getRuntimeRoot()
  const gradleHome = runtimeGradleHomePath()
  const expected = loadFabricVersions()

  const isReady = (): boolean => {
    const marker = readSeedMarker(path.join(gradleHome, SEED_MARKER))
    return Boolean(marker && versionsMatchSeed(marker, expected) && gradleHomeHasFabricCache(gradleHome))
  }

  const wrapperJar = wrapperJarSearchPaths().find((p) => fs.existsSync(p)) || path.join(runtimeRoot, 'gradle-wrapper.jar')

  return ensureGradleHomeOnline(
    runtimeRoot,
    getRuntimeGradlePath(),
    wrapperJar,
    gradleHome,
    expected,
    isReady,
    () => writeRuntimeSeedMarker(gradleHome),
    onProgress
  )
}

async function initFullToolchainImpl(
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  onProgress({ phase: 'checking', message: '检查运行时目录…', percent: 0 })

  const writable = checkRuntimeWritable()
  if (!writable.writable) {
    const err = writable.error || '运行时目录不可写，请勿安装到 Program Files 等受保护目录'
    onProgress({ phase: 'error', message: err, percent: 0, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'jdk', message: '准备 JDK 21…', percent: 5 })
  let jdk = await ensureJdkReady(onProgress)
  if (!jdk.ok && !app.isPackaged) {
    onProgress({ phase: 'jdk', message: '正在下载 JDK 21…', percent: 8 })
    const dl = await downloadJdk(onProgress)
    if (dl.success) {
      jdk = await ensureJdkReady(onProgress)
    } else if (!jdk.ok) {
      const err = dl.error || jdk.error || 'JDK 21 准备失败'
      onProgress({ phase: 'error', message: err, percent: 10, error: err })
      return { ok: false, error: err }
    }
  }
  if (!jdk.ok) {
    const err = jdk.error || 'JDK 21 准备失败'
    onProgress({ phase: 'error', message: err, percent: 10, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'gradle', message: '准备 Gradle 构建工具…', percent: 25 })
  const gradleOk = await ensureRuntimeGradle(onProgress)
  if (!gradleOk) {
    const err = 'Gradle 运行时未就绪，请重新安装完整版 ModCrafting'
    onProgress({ phase: 'error', message: err, percent: 28, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'deps', message: '准备离线 Fabric 依赖缓存…', percent: 35 })
  const seed = await ensureGradleHomeFromSeed(onProgress)
  if (!seed.ok) {
    const err = seed.error || '离线依赖准备失败'
    onProgress({ phase: 'error', message: err, percent: 40, error: err })
    return { ok: false, error: err }
  }

  onProgress({ phase: 'ready', message: '构建环境已就绪，可以开始开发', percent: 100 })
  return { ok: true }
}

function javaBinName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

/** Writable runtime root next to the app executable (or ModCrafting/runtime in dev). */
export function getRuntimeRoot(): string {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'runtime')
  }
  // Dev: out/main -> ModCrafting/runtime (not parent Full-stack/runtime)
  return path.resolve(__dirname, '..', '..', 'runtime')
}

async function stopGradleDaemons(jdkPath?: string | null): Promise<void> {
  const jdk = jdkPath || resolveJdkPath()
  if (!jdk) return

  const gradleDirs = new Set<string>()
  const runtimeGradle = getRuntimeGradlePath()
  const bundled = resolveBundledGradlePath()
  if (fs.existsSync(runtimeGradle)) gradleDirs.add(runtimeGradle)
  if (bundled) gradleDirs.add(bundled)

  const gradleUserHome = getGradleUserHome()
  const stopPromises: Promise<void>[] = []

  for (const gradleDir of gradleDirs) {
    const gradleBat = path.join(gradleDir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
    if (!fs.existsSync(gradleBat)) continue
    stopPromises.push(new Promise((resolve) => {
      const child = spawn(`"${gradleBat}" --stop`, {
        env: {
          ...process.env,
          JAVA_HOME: jdk,
          GRADLE_USER_HOME: gradleUserHome,
          GRADLE_OPTS: `-Dorg.gradle.java.home=${jdk}`
        },
        shell: true,
        windowsHide: true
      })
      const done = (): void => resolve()
      child.on('close', done)
      child.on('error', done)
      setTimeout(done, 4000)
    }))
  }

  await Promise.all(stopPromises)
  await new Promise((r) => setTimeout(r, 300))
}

export async function stopGradleDaemonsOnExit(): Promise<void> {
  try {
    await stopGradleDaemons(resolveJdkPath())
  } catch {
    /* ignore shutdown errors */
  }
}

function safeRmSync(target: string): void {
  if (!fs.existsSync(target)) return
  fs.rmSync(target, RM_OPTS)
}

async function safeRmAsync(target: string): Promise<void> {
  if (!fs.existsSync(target)) return
  await rmAsync(target, RM_OPTS)
}

/** Non-blocking directory copy; yields to the event loop so the UI stays responsive. */
async function copyTreeAsync(
  src: string,
  dest: string,
  onProgress?: (copied: number, total: number) => void
): Promise<void> {
  const files: { src: string; dest: string }[] = []

  function collect(dir: string, outDir: string): void {
    fs.mkdirSync(outDir, { recursive: true })
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, ent.name)
      const d = path.join(outDir, ent.name)
      if (ent.isDirectory()) collect(s, d)
      else files.push({ src: s, dest: d })
    }
  }

  collect(src, dest)
  const total = Math.max(files.length, 1)
  const YIELD_EVERY = 25

  for (let i = 0; i < files.length; i++) {
    const { src: from, dest: to } = files[i]
    await mkdirAsync(path.dirname(to), { recursive: true })
    await copyFileAsync(from, to)
    if (i % YIELD_EVERY === 0 || i === files.length - 1) {
      onProgress?.(i + 1, total)
      await new Promise<void>((r) => setImmediate(r))
    }
  }
}

function runtimeGradleHomePath(): string {
  return path.join(getRuntimeRoot(), 'gradle-home')
}

export function getRuntimeJdkPath(): string {
  return path.join(getRuntimeRoot(), 'jdk-21')
}

export function getRuntimeGradlePath(): string {
  return path.join(getRuntimeRoot(), GRADLE_RUNTIME_DIR)
}

function bundledJdkSearchPaths(): string[] {
  return [
    path.join(process.resourcesPath || '', 'jdk-21'),
    path.join(__dirname, '..', 'resources', 'jdk-21'),
    path.join(__dirname, '..', '..', 'resources', 'jdk-21')
  ]
}

function bundledGradleSearchPaths(): string[] {
  return [
    path.join(process.resourcesPath || '', GRADLE_RUNTIME_DIR),
    path.join(__dirname, '..', 'resources', GRADLE_RUNTIME_DIR),
    path.join(__dirname, '..', '..', 'resources', GRADLE_RUNTIME_DIR),
    path.join(__dirname, '..', '..', '..', 'resources', GRADLE_RUNTIME_DIR),
    // legacy bundle path (pre-9.5 upgrade)
    path.join(process.resourcesPath || '', 'gradle-8.11'),
    path.join(__dirname, '..', 'resources', 'gradle-8.11'),
    path.join(__dirname, '..', '..', 'resources', 'gradle-8.11')
  ]
}

function jdkSearchPaths(): string[] {
  return [getRuntimeJdkPath(), ...bundledJdkSearchPaths()]
}

function gradleSearchPaths(): string[] {
  return [getRuntimeGradlePath(), ...bundledGradleSearchPaths()]
}

function bundledGradleHomeSeedPaths(): string[] {
  return [
    path.join(process.resourcesPath || '', 'gradle-home-seed'),
    path.join(__dirname, '..', 'resources', 'gradle-home-seed'),
    path.join(__dirname, '..', '..', 'resources', 'gradle-home-seed')
  ]
}

function bundledGradleHomeSeedArchivePaths(): string[] {
  return [
    path.join(process.resourcesPath || '', SEED_ARCHIVE_NAME),
    path.join(__dirname, '..', 'resources', SEED_ARCHIVE_NAME),
    path.join(__dirname, '..', '..', 'resources', SEED_ARCHIVE_NAME)
  ]
}

function resolveBundledGradleHomeSeedArchivePath(): string | null {
  return bundledGradleHomeSeedArchivePaths().find((p) => fs.existsSync(p)) ?? null
}

function gradleHomeDirLooksValid(home: string): boolean {
  const expected = loadFabricVersions()
  const marker = readSeedMarker(path.join(home, SEED_MARKER))
  return Boolean(
    marker &&
      seedMarkerIsValid(marker, expected) &&
      gradleHomeHasFabricCache(home) &&
      gradleHomeHasLoomCache(home)
  )
}

async function extractGradleHomeSeedArchive(
  archivePath: string,
  destDir: string,
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  const staging = `${destDir}.staging`
  await safeRmAsync(staging)
  fs.mkdirSync(staging, { recursive: true })

  onProgress({
    phase: 'deps',
    message: '正在解压离线依赖包（约 1GB，请稍候）…',
    percent: 38
  })

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        'tar',
        ['-xf', archivePath, '-C', staging, '--strip-components=1'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.on('close', (code) => resolve(code ?? 1))
      child.on('error', reject)
    })
    if (exitCode !== 0) {
      await safeRmAsync(staging)
      return { ok: false, error: `离线依赖包解压失败 (tar exit ${exitCode})` }
    }

    if (!gradleHomeDirLooksValid(staging)) {
      await safeRmAsync(staging)
      return { ok: false, error: '离线依赖包解压后校验失败，请重新安装完整版 ModCrafting' }
    }

    if (fs.existsSync(destDir)) {
      await stopGradleDaemons(resolveJdkPath())
      await safeRmAsync(destDir)
    }
    fs.renameSync(staging, destDir)
    onProgress({ phase: 'deps', message: '离线 Fabric 依赖已就绪', percent: 100 })
    return { ok: true }
  } catch (err) {
    await safeRmAsync(staging)
    return { ok: false, error: `解压离线依赖失败: ${String(err)}` }
  }
}

function bundledBaseModsSearchPaths(): string[] {
  return [
    path.join(process.resourcesPath || '', '_base_mods'),
    path.join(__dirname, '..', 'resources', '_base_mods'),
    path.join(__dirname, '..', '..', 'resources', '_base_mods')
  ]
}

/** Copy bundled dev helper mods (e.g. Mod Menu) into the project for runClient. */
export async function copyBaseModsToProject(
  projectPath: string,
  onProgress: ProgressSender = defaultProgress,
  opts?: { quiet?: boolean }
): Promise<{ copied: number; skipped: boolean }> {
  if (copyModsLock && copyModsLockPath === projectPath) {
    return copyModsLock
  }

  const job = copyBaseModsToProjectImpl(projectPath, onProgress, opts).finally(() => {
    if (copyModsLockPath === projectPath) {
      copyModsLock = null
      copyModsLockPath = null
    }
  })
  copyModsLock = job
  copyModsLockPath = projectPath
  return job
}

async function copyBaseModsToProjectImpl(
  projectPath: string,
  onProgress: ProgressSender,
  opts?: { quiet?: boolean }
): Promise<{ copied: number; skipped: boolean }> {
  const report: ProgressSender = opts?.quiet ? () => {} : onProgress

  const src = bundledBaseModsSearchPaths().find((p) => fs.existsSync(p))
  if (!src) {
    report({ phase: 'project', message: '调试模组已就绪', percent: 99 })
    return { copied: 0, skipped: true }
  }

  const dest = path.join(projectPath, '.modcrafting', 'base-mods')
  const runMods = path.join(projectPath, 'run', 'mods')
  fs.mkdirSync(dest, { recursive: true })
  fs.mkdirSync(runMods, { recursive: true })

  const jars = fs.readdirSync(src).filter((f) => f.endsWith('.jar'))
  if (jars.length === 0) {
    report({ phase: 'project', message: '调试模组已就绪', percent: 99 })
    return { copied: 0, skipped: true }
  }

  const alreadySynced = jars.every((jar) => {
    const from = path.join(src, jar)
    return modFilesMatch(from, path.join(dest, jar)) && modFilesMatch(from, path.join(runMods, jar))
  })
  if (alreadySynced) {
    report({ phase: 'project', message: `调试模组已就绪（${jars.length} 个）`, percent: 99 })
    return { copied: 0, skipped: true }
  }

  report({ phase: 'project', message: '正在同步调试辅助模组…', percent: 96 })

  let copied = 0
  for (const jar of jars) {
    const from = path.join(src, jar)
    const toProject = path.join(dest, jar)
    const toRun = path.join(runMods, jar)
    try {
      if (!modFilesMatch(from, toProject)) {
        await copyFileAsync(from, toProject)
        copied++
      }
      if (!modFilesMatch(from, toRun)) {
        await copyFileAsync(from, toRun)
      }
    } catch (err) {
      console.warn(`[ModCrafting] 复制调试模组 ${jar} 失败（可能被占用，构建将继续）:`, err)
    }
  }

  report({
    phase: 'project',
    message: copied > 0 ? `已同步 ${jars.length} 个调试模组` : `调试模组已就绪（${jars.length} 个）`,
    percent: 99
  })
  return { copied, skipped: false }
}

function fabricVersionsSearchPaths(): string[] {
  return [
    path.join(process.resourcesPath || '', 'fabric-versions.json'),
    path.join(__dirname, '..', 'resources', 'fabric-versions.json'),
    path.join(__dirname, '..', '..', 'resources', 'fabric-versions.json')
  ]
}

export function loadFabricVersions(): FabricVersions {
  const fallback: FabricVersions = {
    minecraft_version: '1.21.4',
    loader_version: '0.16.10',
    fabric_version: '0.116.0+1.21.4',
    yarn_mappings: '1.21.4+build.1',
    loom_version: '1.17.12',
    gradle_version: GRADLE_VERSION
  }
  for (const p of fabricVersionsSearchPaths()) {
    if (fs.existsSync(p)) {
      try {
        return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf-8')) }
      } catch { /* use fallback */ }
    }
  }
  return fallback
}

function versionsMatchSeed(marker: SeedMarker, expected: FabricVersions): boolean {
  for (const key of Object.keys(expected) as (keyof FabricVersions)[]) {
    if (marker[key] !== expected[key]) return false
  }
  return (marker.fileCount ?? 0) > 100 && (marker.totalBytes ?? 0) > 50_000_000
}

function readSeedMarker(markerPath: string): SeedMarker | null {
  if (!fs.existsSync(markerPath)) return null
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as SeedMarker
  } catch {
    return null
  }
}

function fabricApiModuleDir(home: string, moduleName: string): string {
  return path.join(home, 'caches', 'modules-2', 'files-2.1', 'net.fabricmc.fabric-api', moduleName)
}

function moduleDirHasJar(moduleDir: string): boolean {
  if (!fs.existsSync(moduleDir)) return false
  try {
    const walk = (dir: string): boolean => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (walk(full)) return true
        } else if (ent.name.endsWith('.jar')) {
          return true
        }
      }
      return false
    }
    return walk(moduleDir)
  } catch {
    return false
  }
}

function gradleHomeHasFabricCache(home: string): boolean {
  const fabricApiDir = path.join(home, 'caches', 'modules-2', 'files-2.1', 'net.fabricmc.fabric-api')
  if (!fs.existsSync(fabricApiDir)) return false
  return REQUIRED_FABRIC_API_MODULES.every((name) => moduleDirHasJar(fabricApiModuleDir(home, name)))
}

function gradleHomeHasLoomCache(home: string): boolean {
  const loomCache = path.join(home, 'caches', 'fabric-loom')
  if (!fs.existsSync(loomCache)) return false
  const mcVersion = loadFabricVersions().minecraft_version
  try {
    const walk = (dir: string): boolean => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (walk(full)) return true
        } else {
          const lower = ent.name.toLowerCase()
          if (lower.includes('minecraft') || lower.includes(mcVersion)) return true
        }
      }
      return false
    }
    return walk(loomCache)
  } catch {
    return false
  }
}

function seedMarkerIsValid(marker: SeedMarker | null, expected: FabricVersions): boolean {
  if (!marker || !versionsMatchSeed(marker, expected)) return false
  if (app.isPackaged && marker.verifiedOffline !== true) return false
  return true
}

export function resolveBundledGradleHomeSeedPath(): string | null {
  const expected = loadFabricVersions()
  for (const p of bundledGradleHomeSeedPaths()) {
    const marker = readSeedMarker(path.join(p, SEED_MARKER))
    if (!seedMarkerIsValid(marker, expected)) continue
    if (!gradleHomeHasFabricCache(p) || !gradleHomeHasLoomCache(p)) continue
    return p
  }
  return null
}

export function isGradleHomeSeedReady(): boolean {
  const expected = loadFabricVersions()
  const home = getGradleUserHome()
  const marker = readSeedMarker(path.join(home, SEED_MARKER))
  if (!seedMarkerIsValid(marker, expected)) return false
  if (!gradleHomeHasFabricCache(home) || !gradleHomeHasLoomCache(home)) return false
  if (!app.isPackaged) return resolveBundledGradleHomeSeedPath() !== null
  return true
}

export function getGradleUserHome(): string {
  const runtimeHome = runtimeGradleHomePath()
  const runtimeMarker = readSeedMarker(path.join(runtimeHome, SEED_MARKER))
  const expected = loadFabricVersions()
  if (
    runtimeMarker &&
    seedMarkerIsValid(runtimeMarker, expected) &&
    gradleHomeHasFabricCache(runtimeHome) &&
    gradleHomeHasLoomCache(runtimeHome)
  ) {
    return runtimeHome
  }
  // Dev: use seed in place — avoids copying ~1GB on every fresh runtime
  if (!app.isPackaged) {
    const seed = resolveBundledGradleHomeSeedPath()
    if (seed) return seed
  }
  return runtimeHome
}

export async function ensureGradleHomeFromSeed(
  onProgress: ProgressSender = defaultProgress
): Promise<{ ok: boolean; error?: string }> {
  if (gradleHomeSeedLock) return gradleHomeSeedLock

  gradleHomeSeedLock = ensureGradleHomeFromSeedImpl(onProgress).finally(() => {
    gradleHomeSeedLock = null
  })
  return gradleHomeSeedLock
}

async function ensureGradleHomeFromSeedImpl(
  onProgress: ProgressSender = defaultProgress
): Promise<{ ok: boolean; error?: string }> {
  const expected = loadFabricVersions()
  const dest = runtimeGradleHomePath()
  const destMarkerPath = path.join(dest, SEED_MARKER)
  const existing = readSeedMarker(destMarkerPath)
  if (
    existing &&
    seedMarkerIsValid(existing, expected) &&
    gradleHomeHasFabricCache(dest) &&
    gradleHomeHasLoomCache(dest)
  ) {
    return { ok: true }
  }

  const seedSrc = resolveBundledGradleHomeSeedPath()

  // Dev: point GRADLE_USER_HOME at resources/gradle-home-seed (no copy)
  if (!app.isPackaged) {
    if (seedSrc) {
      purgeGradleEphemeralCaches(seedSrc)
      onProgress({ phase: 'deps', message: '离线 Fabric 依赖已就绪', percent: 100 })
      return { ok: true }
    }
    // resolveBundledGradleHomeSeedPath may fail because transient dirs
    // (transforms, mc-instances) left by an unclean runClient exit make
    // validateSeedContent reject the seed. Purge them and re-validate.
    for (const p of bundledGradleHomeSeedPaths()) {
      if (fs.existsSync(p)) purgeGradleEphemeralCaches(p)
    }
    const recovered = resolveBundledGradleHomeSeedPath()
    if (recovered) {
      onProgress({ phase: 'deps', message: '离线 Fabric 依赖已就绪', percent: 100 })
      return { ok: true }
    }
    return { ok: false, error: '离线依赖种子未生成，开发模式请运行 npm run prefetch:deps' }
  }

  // Packaged: NSIS 7z 无法可靠展开上万级 Gradle 缓存文件，改用单文件 zip 首次解压
  const archive = resolveBundledGradleHomeSeedArchivePath()
  if (archive) {
    return extractGradleHomeSeedArchive(archive, dest, onProgress)
  }

  if (!seedSrc) {
    return { ok: false, error: '离线依赖包缺失或损坏，请重新安装完整版 ModCrafting' }
  }

  onProgress({
    phase: 'deps',
    message: '正在初始化离线 Fabric 依赖缓存（首次约 1GB，请稍候）…',
    percent: 36
  })
  try {
    if (fs.existsSync(dest)) {
      await stopGradleDaemons(resolveJdkPath())
    }

    const staging = `${dest}.staging`
    await safeRmAsync(staging)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    let lastPct = -1
    await copyTreeAsync(seedSrc, staging, (copied, total) => {
      const pct = Math.floor((copied / total) * 100)
      if (pct >= lastPct + 5 || copied === total) {
        lastPct = pct
        onProgress({
          phase: 'deps',
          message: `正在复制离线依赖… ${pct}%`,
          percent: lerpPercent(36, 99, pct)
        })
      }
    })

    const staged = readSeedMarker(path.join(staging, SEED_MARKER))
    if (
      !staged ||
      !seedMarkerIsValid(staged, expected) ||
      !gradleHomeHasFabricCache(staging) ||
      !gradleHomeHasLoomCache(staging)
    ) {
      await safeRmAsync(staging)
      return { ok: false, error: '离线依赖缓存复制后校验失败（缺少 Fabric 依赖）。请重新安装完整版或运行 npm run prefetch:deps' }
    }

    if (fs.existsSync(dest)) {
      try {
        await safeRmAsync(dest)
      } catch {
        const backup = `${dest}.old-${Date.now()}`
        try {
          fs.renameSync(dest, backup)
          await safeRmAsync(backup)
        } catch {
          await safeRmAsync(staging)
          return {
            ok: false,
            error: '无法更新离线依赖缓存（文件被占用）。请关闭所有 Gradle/Minecraft 构建进程后重试。'
          }
        }
      }
    }

    fs.renameSync(staging, dest)
    onProgress({ phase: 'deps', message: '离线 Fabric 依赖已就绪', percent: 100 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `复制离线依赖失败: ${String(err)}` }
  }
}

function wrapperJarSearchPaths(): string[] {
  return [
    path.join(getRuntimeRoot(), 'gradle-wrapper.jar'),
    path.join(process.resourcesPath || '', 'gradle-wrapper.jar'),
    path.join(__dirname, '..', '..', 'resources', 'gradle-wrapper.jar'),
    path.join(__dirname, '..', '..', '..', 'resources', 'gradle-wrapper.jar')
  ]
}

function isValidJdk(jdkPath: string): boolean {
  return fs.existsSync(path.join(jdkPath, 'bin', javaBinName()))
}

function isCompleteGradleDist(gradleDir: string): boolean {
  const launcher = path.join(gradleDir, 'lib', GRADLE_LAUNCHER_JAR)
  return fs.existsSync(path.join(gradleDir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle'))
    && fs.existsSync(launcher)
}

export function resolveJdkPath(): string | null {
  for (const jdkPath of jdkSearchPaths()) {
    if (isValidJdk(jdkPath)) return jdkPath
  }
  return null
}

export function resolveBundledGradlePath(): string | null {
  for (const p of gradleSearchPaths()) {
    if (isCompleteGradleDist(p)) return p
  }
  return null
}

export function checkRuntimeWritable(): { writable: boolean; runtimeRoot: string; error?: string } {
  const runtimeRoot = getRuntimeRoot()
  try {
    fs.mkdirSync(runtimeRoot, { recursive: true })
    const probe = path.join(runtimeRoot, '.write-test')
    fs.writeFileSync(probe, 'ok', 'utf-8')
    fs.unlinkSync(probe)
    return { writable: true, runtimeRoot }
  } catch (err) {
    return {
      writable: false,
      runtimeRoot,
      error: `无法在安装目录创建运行时文件夹：${runtimeRoot}\n请使用便携版或将软件安装到可写目录（勿安装到 Program Files）。\n${String(err)}`
    }
  }
}

export async function ensureRuntimeGradle(onProgress: ProgressSender = defaultProgress): Promise<boolean> {
  const dest = getRuntimeGradlePath()
  if (isCompleteGradleDist(dest)) return true
  for (const src of bundledGradleSearchPaths()) {
    if (isCompleteGradleDist(src)) {
      if (!isCompleteGradleDist(dest)) {
        if (fs.existsSync(dest)) await safeRmAsync(dest)
        onProgress({ phase: 'gradle', message: '正在初始化运行时 Gradle…', percent: 26 })
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        let lastGradlePct = -1
        await copyTreeAsync(src, dest, (copied, total) => {
          const pct = Math.floor((copied / total) * 100)
          if (pct >= lastGradlePct + 10 || copied === total) {
            lastGradlePct = pct
            onProgress({
              phase: 'gradle',
              message: `正在复制 Gradle… ${pct}%`,
              percent: lerpPercent(26, 35, pct)
            })
          }
        })
        onProgress({ phase: 'gradle', message: 'Gradle 已就绪', percent: 35 })
      }
      return isCompleteGradleDist(dest)
    }
  }

  if (isPortableEdition()) {
    return ensurePortableGradle(onProgress)
  }

  return false
}

export async function ensureJdkReady(onProgress: ProgressSender = defaultProgress): Promise<{
  ok: boolean
  path?: string
  error?: string
}> {
  const writable = checkRuntimeWritable()
  if (!writable.writable) {
    return { ok: false, error: writable.error }
  }

  const runtimeJdk = getRuntimeJdkPath()
  if (isValidJdk(runtimeJdk)) {
    return { ok: true, path: runtimeJdk }
  }

  for (const src of bundledJdkSearchPaths()) {
    if (isValidJdk(src)) {
      onProgress('正在初始化运行时 JDK 21（安装目录）...')
      try {
        if (fs.existsSync(runtimeJdk)) await safeRmAsync(runtimeJdk)
        fs.mkdirSync(path.dirname(runtimeJdk), { recursive: true })
        onProgress('正在复制 JDK 21…')
        let lastJdkPct = -1
        await copyTreeAsync(src, runtimeJdk, (copied, total) => {
          const pct = Math.floor((copied / total) * 100)
          if (pct >= lastJdkPct + 5 || copied === total) {
            lastJdkPct = pct
            onProgress({
              phase: 'jdk',
              message: `正在复制 JDK 21… ${pct}%`,
              percent: lerpPercent(5, 25, pct)
            })
          }
        })
        onProgress({ phase: 'jdk', message: 'JDK 21 已就绪', percent: 25 })
        return { ok: true, path: runtimeJdk }
      } catch (err) {
        return { ok: false, error: `复制 JDK 到运行时目录失败: ${String(err)}` }
      }
    }
  }

  if (isPortableEdition() && app.isPackaged) {
    return ensurePortableJdk(onProgress)
  }

  return { ok: false, error: app.isPackaged ? (isPortableEdition() ? 'JDK 未就绪' : '安装包不完整，缺少捆绑 JDK 21') : '未找到 JDK 21，请运行 npm run prefetch:deps 或检查 resources/jdk-21' }
}

function shouldUseOfflineGradle(): boolean {
  if (!app.isPackaged) {
    return resolveBundledGradleHomeSeedPath() !== null
  }
  return isGradleHomeSeedReady()
}

export function getBuildEnv(jdkPath: string): NodeJS.ProcessEnv {
  const runtimeRoot = getRuntimeRoot()
  const gradleUserHome = getGradleUserHome()
  const javaBin = path.join(jdkPath, 'bin')
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const existingPath = process.env.PATH || process.env.Path || ''
  const offline = shouldUseOfflineGradle()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MODCRAFTING_RUNTIME: runtimeRoot,
    JAVA_HOME: jdkPath,
    GRADLE_USER_HOME: gradleUserHome,
    GRADLE_OPTS: `-Dorg.gradle.java.home=${jdkPath}`,
    PATH: `${javaBin}${pathSep}${existingPath}`
  }
  if (offline) {
    env.ORG_GRADLE_PROJECT_org_gradle_offline = 'true'
  }
  return env
}

export function getCmdEnvPrefix(jdkPath: string): string {
  const runtimeRoot = getRuntimeRoot()
  const gradleUserHome = getGradleUserHome()
  const offline = shouldUseOfflineGradle() ? ' && set "ORG_GRADLE_PROJECT_org_gradle_offline=true"' : ''
  return `set "MODCRAFTING_RUNTIME=${runtimeRoot}" && set "JAVA_HOME=${jdkPath}" && set "PATH=${jdkPath}\\bin;%PATH%" && set "GRADLE_OPTS=-Dorg.gradle.java.home=${jdkPath}" && set "GRADLE_USER_HOME=${gradleUserHome}"${offline} && `
}

export function getPowerShellEnvScript(jdkPath: string): string {
  const runtimeRoot = getRuntimeRoot().replace(/\\/g, '\\\\')
  const gradleUserHome = getGradleUserHome().replace(/\\/g, '\\\\')
  const jdkEscaped = jdkPath.replace(/\\/g, '\\\\')
  const offlineLine = shouldUseOfflineGradle()
    ? `$env:ORG_GRADLE_PROJECT_org_gradle_offline = "true"\r`
    : ''
  return `$env:MODCRAFTING_RUNTIME = "${runtimeRoot}"\r$env:JAVA_HOME = "${jdkEscaped}"\r$env:GRADLE_USER_HOME = "${gradleUserHome}"\r$env:GRADLE_OPTS = "-Dorg.gradle.java.home=${jdkEscaped}"\r${offlineLine}$env:PATH = "${jdkEscaped}\\bin;" + $env:PATH\r`
}

export async function ensureGradleWrapper(
  projectPath: string,
  onProgress: ProgressSender = defaultProgress
): Promise<{ exists: boolean; copied?: boolean; downloaded?: boolean; error?: string }> {
  const wrapperDir = path.join(projectPath, 'gradle', 'wrapper')
  const wrapperJar = path.join(wrapperDir, 'gradle-wrapper.jar')
  if (fs.existsSync(wrapperJar)) return { exists: true }

  for (const src of wrapperJarSearchPaths()) {
    if (fs.existsSync(src)) {
      fs.mkdirSync(wrapperDir, { recursive: true })
      fs.copyFileSync(src, wrapperJar)
      return { exists: true, copied: true }
    }
  }

  onProgress('正在下载 gradle-wrapper.jar...')
  if (app.isPackaged) {
    return { exists: false, error: '安装包不完整，缺少 gradle-wrapper.jar' }
  }
  try {
    fs.mkdirSync(wrapperDir, { recursive: true })
    const url = `https://raw.githubusercontent.com/gradle/gradle/v${GRADLE_VERSION}/gradle/wrapper/gradle-wrapper.jar`
    const cmd = `powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${url}' -OutFile '${wrapperJar}'}"`
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, { shell: true })
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(wrapperJar)) {
          const cachePath = path.join(getRuntimeRoot(), 'gradle-wrapper.jar')
          fs.mkdirSync(getRuntimeRoot(), { recursive: true })
          fs.copyFileSync(wrapperJar, cachePath)
          resolve()
        } else {
          reject(new Error(`Download failed: ${code}`))
        }
      })
      child.on('error', reject)
    })
    return { exists: true, downloaded: true }
  } catch (err) {
    return { exists: false, error: String(err) }
  }
}

export async function copyBundledGradle(projectPath: string): Promise<{
  copied: boolean
  reason?: string
  error?: string
}> {
  const bundledGradleDir = resolveBundledGradlePath()
  if (!bundledGradleDir) {
    return { copied: false, reason: 'Gradle 运行时未就绪（缺少 lib/），请运行 npm run setup:toolchain' }
  }

  const targetDir = path.join(projectPath, '.modcrafting', GRADLE_RUNTIME_DIR)
  try {
    if (isCompleteGradleDist(targetDir)) {
      return { copied: true }
    }

    await stopGradleDaemons(resolveJdkPath())
    if (fs.existsSync(targetDir)) await safeRmAsync(targetDir)
    fs.mkdirSync(path.join(projectPath, '.modcrafting'), { recursive: true })
    await copyTreeAsync(bundledGradleDir, targetDir)
    if (!isCompleteGradleDist(targetDir)) {
      return { copied: false, error: `项目 Gradle 副本不完整，缺少 ${GRADLE_LAUNCHER_JAR}` }
    }
    return { copied: true }
  } catch (err) {
    return { copied: false, error: String(err) }
  }
}

function findGradleDistZip(): string | null {
  const candidates = [
    path.join(getRuntimeRoot(), `${GRADLE_DIST_NAME}.zip`),
    path.join(process.resourcesPath || '', `${GRADLE_DIST_NAME}.zip`),
    path.join(__dirname, '..', 'resources', `${GRADLE_DIST_NAME}.zip`),
    path.join(__dirname, '..', '..', 'resources', `${GRADLE_DIST_NAME}.zip`)
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

export async function prefetchGradleDistribution(
  onProgress: ProgressSender = defaultProgress
): Promise<{ ok: boolean; error?: string }> {
  const gradleUserHome = getGradleUserHome()
  const wrapperDists = path.join(gradleUserHome, 'wrapper', 'dists', GRADLE_DIST_NAME)
  if (fs.existsSync(wrapperDists)) {
    const entries = fs.readdirSync(wrapperDists, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const gradleHome = path.join(wrapperDists, entry.name, GRADLE_HOME_DIR)
      if (isCompleteGradleDist(gradleHome)) {
        return { ok: true }
      }
    }
  }

  const bundled = resolveBundledGradlePath()
  if (bundled) {
    onProgress('正在准备 Gradle 离线缓存...')
    try {
      fs.mkdirSync(wrapperDists, { recursive: true })
      const hashDir = path.join(wrapperDists, 'modcrafting-offline')
      const targetGradle = path.join(hashDir, GRADLE_HOME_DIR)
      if (!isCompleteGradleDist(targetGradle)) {
        if (fs.existsSync(hashDir)) fs.rmSync(hashDir, { recursive: true })
        fs.mkdirSync(targetGradle, { recursive: true })
        fs.cpSync(bundled, targetGradle, { recursive: true })
      }
      const okFile = path.join(hashDir, `${GRADLE_DIST_NAME}.zip.ok`)
      fs.writeFileSync(okFile, '', 'utf-8')
      onProgress('Gradle 离线缓存已就绪')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  const zipPath = findGradleDistZip()
  if (zipPath) {
    onProgress('正在解压 Gradle 发行版到离线缓存...')
    try {
      fs.mkdirSync(wrapperDists, { recursive: true })
      const hashDir = path.join(wrapperDists, 'modcrafting-offline')
      const targetGradle = path.join(hashDir, GRADLE_HOME_DIR)
      if (!isCompleteGradleDist(targetGradle)) {
        if (fs.existsSync(hashDir)) fs.rmSync(hashDir, { recursive: true })
        fs.mkdirSync(hashDir, { recursive: true })
        await new Promise<void>((resolve, reject) => {
          const cmd = `powershell -Command "& {Expand-Archive -Path '${zipPath}' -DestinationPath '${hashDir}' -Force}"`
          const child = spawn(cmd, { shell: true })
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed: ${code}`)))
          child.on('error', reject)
        })
      }
      const okFile = path.join(hashDir, `${GRADLE_DIST_NAME}.zip.ok`)
      fs.writeFileSync(okFile, '', 'utf-8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  return { ok: false, error: 'Gradle 离线资源不完整，Wrapper 首次构建可能需要联网' }
}

export async function downloadJdk(onProgress: ProgressSender = defaultProgress): Promise<{
  success: boolean
  path?: string
  error?: string
}> {
  const writable = checkRuntimeWritable()
  if (!writable.writable) {
    return { success: false, error: writable.error }
  }

  const jdkDir = getRuntimeJdkPath()
  const zipPath = path.join(getRuntimeRoot(), 'jdk-21.zip')
  const jdkUrl = 'https://aka.ms/download-jdk/microsoft-jdk-21.0.6-windows-x64.zip'

  onProgress('正在下载 JDK 21...')
  try {
    fs.mkdirSync(getRuntimeRoot(), { recursive: true })
    const downloadCmd = `powershell -Command "& {Invoke-WebRequest -Uri '${jdkUrl}' -OutFile '${zipPath}'}"`
    await new Promise<void>((resolve, reject) => {
      const child = spawn(downloadCmd, { shell: true })
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Download failed: ${code}`)))
      child.on('error', reject)
    })

    onProgress('正在解压 JDK 21...')
    const extractDir = path.join(getRuntimeRoot(), '_jdk_extract')
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true })
    fs.mkdirSync(extractDir, { recursive: true })

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        `powershell -Command "& {Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force}"`,
        { shell: true }
      )
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Extract failed: ${code}`)))
      child.on('error', reject)
    })

    const extracted = fs.readdirSync(extractDir).filter((f) => f.startsWith('jdk-21'))
    if (extracted.length > 0) {
      const src = path.join(extractDir, extracted[0])
      if (fs.existsSync(jdkDir)) fs.rmSync(jdkDir, { recursive: true })
      fs.renameSync(src, jdkDir)
    }
    fs.rmSync(extractDir, { recursive: true, force: true })

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)

    if (!isValidJdk(jdkDir)) {
      return { success: false, error: 'JDK 解压后验证失败' }
    }

    onProgress('JDK 21 安装完成')
    return { success: true, path: jdkDir }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function generateGradlewBatContent(): string {
  return `@echo off
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set APP_HOME=%DIRNAME%

if not "%JAVA_HOME%"=="" (
  "%JAVA_HOME%\\bin\\java" -version 2>&1 | findstr "21" >nul
  if !ERRORLEVEL! equ 0 goto :run
)

if not "%MODCRAFTING_RUNTIME%"=="" (
  set "MC_RUNTIME_JDK=%MODCRAFTING_RUNTIME%\\jdk-21"
  if exist "%MC_RUNTIME_JDK%\\bin\\java.exe" (
    set "JAVA_HOME=%MC_RUNTIME_JDK%"
    set "PATH=%MC_RUNTIME_JDK%\\bin;%PATH%"
    goto :run
  )
)

set "MC_BUNDLED_JDK=%DIRNAME%.modcrafting\\jdk-21"
if exist "%MC_BUNDLED_JDK%\\bin\\java.exe" (
  set "JAVA_HOME=%MC_BUNDLED_JDK%"
  set "PATH=%MC_BUNDLED_JDK%\\bin;%PATH%"
  goto :run
)

set "JDK21=C:\\Program Files\\Java\\jdk-21"
if exist "%JDK21%\\bin\\java.exe" (
  set "JAVA_HOME=%JDK21%"
  set "PATH=%JDK21%\\bin;%PATH%"
  goto :run
)

echo WARNING: JDK 21 not found. Launch from ModCrafting or set JAVA_HOME.

:run
if not "%GRADLE_USER_HOME%"=="" (
  rem keep injected GRADLE_USER_HOME (ModCrafting or user)
) else if not "%MODCRAFTING_RUNTIME%"=="" (
  set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
) else (
  echo WARNING: GRADLE_USER_HOME not set. Launch from ModCrafting for correct cache path.
)

set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${GRADLE_RUNTIME_DIR}"
if not exist "%MC_BUNDLED_GRADLE%\\bin\\gradle.bat" (
  if not "%MODCRAFTING_RUNTIME%"=="" (
    set "MC_BUNDLED_GRADLE=%MODCRAFTING_RUNTIME%\\${GRADLE_RUNTIME_DIR}"
  )
)
if exist "%MC_BUNDLED_GRADLE%\\bin\\gradle.bat" (
  if not "%JAVA_HOME%"=="" (
    set "GRADLE_OPTS=-Dorg.gradle.java.home=%JAVA_HOME%"
  )
  "%MC_BUNDLED_GRADLE%\\bin\\gradle.bat" --stop 2>nul
  "%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER_JAR}" org.gradle.launcher.GradleMain %*
  exit /b !ERRORLEVEL!
)

set WRAPPER_JAR=%APP_HOME%gradle\\wrapper\\gradle-wrapper.jar
if not exist "%WRAPPER_JAR%" (
  echo ERROR: gradle-wrapper.jar not found.
  pause & exit /b 1
)
if not "%JAVA_HOME%"=="" (
  set "GRADLE_OPTS=-Dorg.gradle.java.home=%JAVA_HOME%"
)
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%WRAPPER_JAR%" org.gradle.wrapper.GradleWrapperMain %*
exit /b %ERRORLEVEL%
`
}

function writeGradlewBat(projectPath: string): void {
  fs.writeFileSync(path.join(projectPath, 'gradlew.bat'), generateGradlewBatContent(), 'utf-8')
}

export function generateGradleWrapperPropertiesContent(): string {
  return `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/${GRADLE_DIST_NAME}.zip
networkTimeout=120000
validateDistributionUrl=false
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
}

function writeGradleWrapperProperties(projectPath: string): void {
  const propsPath = path.join(projectPath, 'gradle', 'wrapper', 'gradle-wrapper.properties')
  fs.mkdirSync(path.dirname(propsPath), { recursive: true })
  fs.writeFileSync(propsPath, generateGradleWrapperPropertiesContent(), 'utf-8')
}

export async function ensureProjectToolchain(
  projectPath: string,
  onProgress: ProgressSender = defaultProgress
): Promise<{
  ok: boolean
  jdkReady: boolean
  gradleReady: boolean
  depsReady: boolean
  errors: string[]
}> {
  const errors: string[] = []

  const jdkResult = await ensureJdkReady(onProgress)
  if (!jdkResult.ok) errors.push(jdkResult.error || 'JDK 未就绪')

  await ensureRuntimeGradle(onProgress)

  writeGradlewBat(projectPath)
  writeGradleWrapperProperties(projectPath)

  // Remove legacy project gradle bundle from pre-9.5 toolchain
  const legacyGradle = path.join(projectPath, '.modcrafting', 'gradle-8.11')
  if (fs.existsSync(legacyGradle)) {
    try { safeRmSync(legacyGradle) } catch { /* ignore locked legacy bundle */ }
  }

  const wrapperResult = await ensureGradleWrapper(projectPath, onProgress)
  if (!wrapperResult.exists) errors.push(wrapperResult.error || 'gradle-wrapper.jar 缺失')

  const gradleCopy = await copyBundledGradle(projectPath)
  if (!gradleCopy.copied) {
    errors.push(gradleCopy.reason || gradleCopy.error || 'Gradle 复制失败')
  }

  const prefetch = await prefetchGradleDistribution(onProgress)
  if (!prefetch.ok && prefetch.error) errors.push(prefetch.error)

  const seedResult = await ensureGradleHomeFromSeed(onProgress)
  const depsReady = seedResult.ok
  if (!seedResult.ok && seedResult.error) errors.push(seedResult.error)

  await copyBaseModsToProject(projectPath, onProgress)

  return {
    ok: jdkResult.ok && wrapperResult.exists && (gradleCopy.copied || prefetch.ok) && depsReady,
    jdkReady: jdkResult.ok,
    gradleReady: gradleCopy.copied || prefetch.ok,
    depsReady,
    errors
  }
}

/** Project-only toolchain after global init (wrapper, gradle bundle, debug mods). */
export async function ensureProjectEnvironment(
  projectPath: string,
  onProgress: ProgressSender = defaultProgress
): Promise<{ ok: boolean; errors: string[] }> {
  if (!isGlobalToolchainReady()) {
    const global = await initToolchain(onProgress)
    if (!global.ok) {
      return { ok: false, errors: [global.error || '全局构建环境未就绪'] }
    }
  }

  const errors: string[] = []

  onProgress({ phase: 'project', message: '准备项目构建环境…', percent: 90 })

  writeGradlewBat(projectPath)
  writeGradleWrapperProperties(projectPath)

  const legacyGradle = path.join(projectPath, '.modcrafting', 'gradle-8.11')
  if (fs.existsSync(legacyGradle)) {
    try { safeRmSync(legacyGradle) } catch { /* ignore locked legacy bundle */ }
  }

  const wrapperResult = await ensureGradleWrapper(projectPath, onProgress)
  if (!wrapperResult.exists) errors.push(wrapperResult.error || 'gradle-wrapper.jar 缺失')

  const gradleCopy = await copyBundledGradle(projectPath)
  if (!gradleCopy.copied) {
    errors.push(gradleCopy.reason || gradleCopy.error || 'Gradle 复制失败')
  }

  await copyBaseModsToProject(projectPath, onProgress)

  onProgress({ phase: 'ready', message: '项目环境已就绪', percent: 100 })
  return { ok: errors.length === 0, errors }
}

export function isGradleCacheCorrupted(output: string): boolean {
  return /immutable workspace|transformed \(Missing|have been modified\. These workspace directories are not supposed to be modified/i.test(output)
}

export function isOfflineCacheMiss(output: string): boolean {
  return /No cached version available for offline mode|Could not resolve all files for configuration/i.test(output)
}

export function isRecoverableGradleCacheError(output: string): boolean {
  return isGradleCacheCorrupted(output) || isOfflineCacheMiss(output)
}

const EPHEMERAL_GRADLE_HOME_DIRS = ['daemon', 'notifications', 'mc-instances'] as const
const EPHEMERAL_CACHE_DIRS = ['transforms', 'executionHistory', 'generated-gradle-jars', 'jars-9', 'journal-1'] as const

/**
 * Remove junctions/symlinks inside mc-instances subdirectories before a
 * recursive delete.  On Windows {@link fs.rmSync} with recursive:true follows
 * directory junctions and deletes their *target* content — which would wipe
 * caches/, wrapper/, and notifications/ inside the shared Gradle home (the
 * seed in dev mode).  Breaking the links individually first avoids that.
 *
 * Uses readlinkSync() rather than lstatSync().isSymbolicLink() because the
 * latter does NOT detect directory junctions on Windows (they are a different
 * reparse-point type).  readlinkSync() throws on non-links on all platforms.
 */
function breakJunctionsInInstanceDirs(instancesDir: string): void {
  try {
    for (const inst of fs.readdirSync(instancesDir, { withFileTypes: true })) {
      if (!inst.isDirectory()) continue
      const instPath = path.join(instancesDir, inst.name)
      for (const entry of fs.readdirSync(instPath, { withFileTypes: true })) {
        const entryPath = path.join(instPath, entry.name)
        try {
          fs.readlinkSync(entryPath) // throws if not a link (symlink or junction)
          fs.rmSync(entryPath, { force: true })
        } catch { /* not a link, or already gone */ }
      }
    }
  } catch { /* directory already removed or inaccessible */ }
}

/** Remove rebuildable Gradle caches that commonly cause immutable-workspace failures. */
export function purgeGradleEphemeralCaches(gradleHome: string): number {
  let removed = 0
  for (const name of EPHEMERAL_GRADLE_HOME_DIRS) {
    const target = path.join(gradleHome, name)
    if (!fs.existsSync(target)) continue
    if (name === 'mc-instances') {
      breakJunctionsInInstanceDirs(target)
    }
    safeRmSync(target)
    removed++
  }

  const cachesRoot = path.join(gradleHome, 'caches')
  if (!fs.existsSync(cachesRoot)) return removed

  for (const versionEnt of fs.readdirSync(cachesRoot, { withFileTypes: true })) {
    if (!versionEnt.isDirectory()) continue
    const versionPath = path.join(cachesRoot, versionEnt.name)
    for (const childName of EPHEMERAL_CACHE_DIRS) {
      const target = path.join(versionPath, childName)
      if (fs.existsSync(target)) {
        safeRmSync(target)
        removed++
      }
    }
  }

  return removed
}

/**
 * Re-copy runtime gradle-home from bundled seed after cache corruption.
 * Only applies to packaged full edition with a valid bundled seed.
 */
export async function recoverRuntimeGradleHomeFromSeed(
  onProgress: ProgressSender = defaultProgress
): Promise<{ ok: boolean; error?: string }> {
  if (isPortableEdition()) {
    return { ok: false, error: '便携版需联网重新下载依赖缓存' }
  }

  const seedSrc = resolveBundledGradleHomeSeedPath()
  if (!seedSrc) {
    return {
      ok: false,
      error: '离线依赖种子不可用，请重新安装完整版 ModCrafting 或运行 npm run prefetch:deps'
    }
  }

  const dest = runtimeGradleHomePath()
  onProgress({
    phase: 'deps',
    message: '检测到 Gradle 缓存损坏，正在从离线种子恢复…',
    percent: 40
  })

  try {
    await stopGradleDaemons(resolveJdkPath())
    if (fs.existsSync(dest)) {
      await safeRmAsync(dest)
    }

    const staging = `${dest}.recovery`
    await safeRmAsync(staging)
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    await copyTreeAsync(seedSrc, staging)
    fs.renameSync(staging, dest)

    onProgress({ phase: 'deps', message: '离线 Gradle 缓存已恢复', percent: 85 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `恢复离线缓存失败: ${String(err)}` }
  }
}

function formatGradleCommand(
  projectPath: string,
  cmdPrefix: string,
  task: string,
  offline: boolean
): string {
  const hasBat = fs.existsSync(path.join(projectPath, 'gradlew.bat'))
  const hasSh = fs.existsSync(path.join(projectPath, 'gradlew'))
  const flags = offline ? '--offline' : '-Dorg.gradle.offline=false'
  const gradleTask = `${flags} ${task} --no-daemon`
  if (hasBat) return `${cmdPrefix}.\\gradlew ${gradleTask}`
  if (hasSh) return `${cmdPrefix}./gradlew ${gradleTask}`
  return `${cmdPrefix}gradle ${gradleTask}`
}

async function execShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onOutput?: (text: string) => void
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env })
    let fullOutput = ''
    const onData = (data: Buffer) => {
      const text = data.toString()
      fullOutput += text
      onOutput?.(text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => resolve({ output: fullOutput, exitCode: code ?? -1 }))
    child.on('error', (err) => resolve({ output: String(err), exitCode: -1 }))
  })
}

export function canRunGradleBuild(): boolean {
  if (isToolchainInitializing()) return false
  if (app.isPackaged) {
    return isGlobalToolchainReady() || isGradleHomeSeedReady()
  }
  const status = getToolchainStatus()
  return status.jdk === 'ready' && (status.deps === 'ready' || isGradleHomeSeedReady())
}

export async function runGradleTask(
  projectPath: string,
  task: string,
  onOutput?: (text: string) => void
): Promise<{ output: string; exitCode: number; usedOnlineFallback: boolean }> {
  if (!canRunGradleBuild()) {
    const msg = isToolchainInitializing()
      ? '[ModCrafting] 构建环境正在初始化，请等待进度条完成后再构建。'
      : '[ModCrafting] 构建环境尚未就绪，请等待应用完成环境初始化。'
    onOutput?.(`${msg}\n`)
    return { output: msg, exitCode: -1, usedOnlineFallback: false }
  }

  const prep = await prepareBuild(projectPath)
  if (!prep.ok) {
    const err = prep.error || '构建环境未就绪'
    onOutput?.(`[ModCrafting] ${err}\n`)
    return { output: err, exitCode: -1, usedOnlineFallback: false }
  }

  onOutput?.(`\n[ModCrafting] 开始执行: gradlew ${task}\n`)

  writeGradlewBat(projectPath)

  let cmd = formatGradleCommand(projectPath, prep.cmdPrefix, task, true)
  let result = await execShellCommand(cmd, projectPath, prep.env, onOutput)

  if (result.exitCode !== 0 && isRecoverableGradleCacheError(result.output)) {
    const gradleHome = getGradleUserHome()
    const purged = purgeGradleEphemeralCaches(gradleHome)
    if (purged > 0) {
      onOutput?.(`\n[ModCrafting] 已清理 ${purged} 处损坏的 Gradle 缓存，正在重试离线构建…\n`)
      result = await execShellCommand(cmd, projectPath, prep.env, onOutput)
    }

    if (result.exitCode !== 0 && isRecoverableGradleCacheError(result.output) && app.isPackaged && isFullEdition()) {
      onOutput?.('\n[ModCrafting] 离线缓存仍不可用，正在从安装包内的离线种子恢复…\n')
      const recovered = await recoverRuntimeGradleHomeFromSeed((payload) => {
        const normalized = normalizeProgress(payload)
        onOutput?.(`[ModCrafting] ${normalized.message}\n`)
      })
      if (recovered.ok) {
        const refreshedPrep = await prepareBuild(projectPath)
        if (refreshedPrep.ok) {
          cmd = formatGradleCommand(projectPath, refreshedPrep.cmdPrefix, task, true)
          result = await execShellCommand(cmd, projectPath, refreshedPrep.env, onOutput)
        }
      } else if (recovered.error) {
        onOutput?.(`[ModCrafting] ${recovered.error}\n`)
      }
    }
  }

  if (result.exitCode !== 0 && isOfflineCacheMiss(result.output)) {
    onOutput?.('\n[ModCrafting] 离线缓存缺少 Fabric 依赖，正在联网下载并写入本地缓存…\n')
    const onlinePrep = await prepareBuild(projectPath)
    if (!onlinePrep.ok) {
      return { output: result.output, exitCode: result.exitCode, usedOnlineFallback: false }
    }
    cmd = formatGradleCommand(projectPath, onlinePrep.cmdPrefix, task, false)
    result = await execShellCommand(cmd, projectPath, onlinePrep.env, onOutput)
    if (result.exitCode === 0) {
      onOutput?.('\n[ModCrafting] 依赖已下载到本地缓存，后续构建可离线进行。\n')
    }
    return { ...result, usedOnlineFallback: true }
  }

  return { ...result, usedOnlineFallback: false }
}

export async function prepareBuild(projectPath: string): Promise<{
  ok: boolean
  jdkPath?: string
  cmdPrefix: string
  powershellEnv: string
  env: NodeJS.ProcessEnv
  error?: string
}> {
  if (isToolchainInitializing()) {
    return {
      ok: false,
      cmdPrefix: '',
      powershellEnv: '',
      env: { ...process.env },
      error: '构建环境正在初始化，请等待进度条完成'
    }
  }
  if (!canRunGradleBuild()) {
    return {
      ok: false,
      cmdPrefix: '',
      powershellEnv: '',
      env: { ...process.env },
      error: '构建环境尚未就绪，请等待环境初始化完成'
    }
  }

  const jdkResult = await ensureJdkReady()
  if (!jdkResult.ok || !jdkResult.path) {
    return { ok: false, cmdPrefix: '', powershellEnv: '', env: { ...process.env }, error: jdkResult.error }
  }

  await ensureRuntimeGradle()
  await ensureGradleWrapper(projectPath)
  await prefetchGradleDistribution()
  if (!isGradleHomeSeedReady()) {
    if (isPortableEdition()) {
      await ensurePortableGradleHome(defaultProgress)
    } else {
      await ensureGradleHomeFromSeed()
    }
  }
  await copyBaseModsToProject(projectPath, () => {}, { quiet: true })

  const jdkPath = jdkResult.path
  return {
    ok: true,
    jdkPath,
    cmdPrefix: getCmdEnvPrefix(jdkPath),
    powershellEnv: getPowerShellEnvScript(jdkPath),
    env: getBuildEnv(jdkPath)
  }
}

export function getToolchainStatus(): {
  jdk: 'ready' | 'bundled' | 'missing'
  gradle: 'ready' | 'incomplete' | 'missing'
  deps: 'ready' | 'missing'
  jdkPath: string | null
  runtimeRoot: string
  isPackaged: boolean
  edition: 'dev' | 'full' | 'portable'
} {
  const runtimeJdk = getRuntimeJdkPath()
  let jdk: 'ready' | 'bundled' | 'missing' = 'missing'
  let jdkPath: string | null = null

  if (isValidJdk(runtimeJdk)) {
    jdk = 'ready'
    jdkPath = runtimeJdk
  } else {
    const bundled = bundledJdkSearchPaths().find((p) => isValidJdk(p))
    if (bundled) {
      jdk = 'bundled'
      jdkPath = bundled
    }
  }

  const gradleBundled = resolveBundledGradlePath()
  let gradle: 'ready' | 'incomplete' | 'missing' = 'missing'
  if (isCompleteGradleDist(getRuntimeGradlePath()) || gradleBundled) {
    gradle = 'ready'
  } else {
    for (const p of gradleSearchPaths()) {
      if (fs.existsSync(p)) {
        gradle = 'incomplete'
        break
      }
    }
  }

  return {
    jdk,
    gradle,
    deps: isGradleHomeSeedReady() ? 'ready' : 'missing',
    jdkPath,
    runtimeRoot: getRuntimeRoot(),
    isPackaged: app.isPackaged,
    edition: getAppEdition()
  }
}
