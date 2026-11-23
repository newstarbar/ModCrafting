import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { FABRIC_TARGET, GAME_TEST_WORLD, isAllowedBridgeApiPath, type GameTestVerdict } from './domain.ts'
import { acceptanceVerdict } from './acceptance.ts'
import { deriveResourceLayout, type ResourceLayout } from './version/resources-profile.ts'
import { getRegistry } from './version/registry.ts'
import { capabilitiesFor } from './version/capabilities.ts'
import { neoForgeProjectFiles } from './loaders/neoforge.ts'
import { forgeProjectFiles } from './loaders/forge.ts'
import { configureStorage, ensureStorageDirs, migrateStorage, cleanStorage, resolveStorage, storageSourceLabel, storageUsage, withEnvPrecedenceWarning, type StorageOptions, type StorageStatus, type StorageUsage } from './storage.ts'
import type { ResolvedTarget } from './version/targets.ts'
import type { RuntimePaths, RuntimeEvents, EnvironmentStatus, FabricProject, JavaCandidate, JavaSource, JavaStatus } from './contracts.ts'
export type { RuntimePaths, RuntimeEvents, EnvironmentStatus, FabricProject, JavaCandidate, JavaSource, JavaStatus } from './contracts.ts'

export interface BridgeDiscovery { port: number; token?: string; apiVersions?: number[]; modVersion?: string }

export function createRuntimePaths(dataRoot: string): RuntimePaths {
  const root = path.resolve(dataRoot)
  return { dataRoot: root, knowledgeRoot: path.join(root, 'knowledge'), assetsRoot: path.join(root, 'assets'), reportsRoot: path.join(root, 'reports'), logsRoot: path.join(root, 'logs') }
}

export function ensureRuntimePaths(paths: RuntimePaths): void { for (const value of Object.values(paths)) mkdirSync(value, { recursive: true }) }

function execCapture(command: string, args: string[], cwd?: string, timeoutMs = 30_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, output: 'command timed out' }) }, timeoutMs)
    child.stdout.on('data', (value) => { output += String(value) })
    child.stderr.on('data', (value) => { output += String(value) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }) })
  })
}

const JAVA_MAJOR = 21
const WINDOWS = process.platform === 'win32'
const JAVA_EXE = WINDOWS ? 'java.exe' : 'java'
const JAVAC_EXE = WINDOWS ? 'javac.exe' : 'javac'

interface JavaPointer { home: string; source: JavaSource }
interface JavaConfig { path?: string; javaHome?: string; error?: string }

function javaBinary(home: string): string { return path.join(home, 'bin', JAVA_EXE) }
function javacBinary(home: string): string { return path.join(home, 'bin', JAVAC_EXE) }
function javaMajor(version?: string): number | undefined {
  const major = version?.trim().split(/[.+-]/)[0]
  return major && /^\d+$/.test(major) ? Number(major) : undefined
}
function releaseVersion(home: string): string | undefined {
  try { return readFileSync(path.join(home, 'release'), 'utf8').match(/^JAVA_VERSION="?([^"\r\n]+)"?/m)?.[1]?.trim() } catch { return undefined }
}
function javaSourceLabel(source: JavaSource): string {
  return source === 'configured' ? '插件工具链配置' : source === 'modcrafting-env' ? 'MODCRAFTING_JAVA_HOME' : source === 'java-home' ? 'JAVA_HOME' : source === 'path' ? 'PATH' : '自动扫描'
}
function directoriesUnder(directory: string): string[] {
  try { return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name)).sort() } catch { return [] }
}
function javaHomesUnder(directory: string, depth: number, limit = 8): string[] {
  const result: string[] = [], seen = new Set<string>()
  const visit = (current: string, remaining: number) => {
    if (result.length >= limit) return
    const key = WINDOWS ? current.toLowerCase() : current
    if (seen.has(key)) return
    seen.add(key)
    if (existsSync(javaBinary(current))) { result.push(current); return }
    if (remaining <= 0) return
    for (const child of directoriesUnder(current)) visit(child, remaining - 1)
  }
  visit(path.resolve(directory), depth)
  return result
}
function pathJavaHomes(): string[] {
  const homes: string[] = []
  for (const entry of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const directory = path.resolve(entry)
    if (existsSync(path.join(directory, JAVA_EXE))) {
      const parent = path.dirname(directory)
      if (existsSync(javacBinary(parent))) homes.push(parent)
    } else if (existsSync(javaBinary(directory))) homes.push(directory)
  }
  return homes
}
function discoveredJavaHomes(): string[] {
  const directories: Array<[string, number]> = [
    [path.join(homedir(), '.jdks'), 2],
    [path.join(homedir(), '.gradle', 'jdks'), 2],
    [path.join(homedir(), '.sdkman', 'candidates', 'java'), 2],
    ['/usr/lib/jvm', 2],
    ['/Library/Java/JavaVirtualMachines', 3],
    ['/opt/java', 2],
    [path.join(homedir(), 'Library', 'Java', 'JavaVirtualMachines'), 3]
  ]
  const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined]
    .filter((value): value is string => Boolean(value))
  for (const parent of programs) for (const vendor of ['Java', 'Microsoft', 'Eclipse Adoptium', 'Eclipse Foundation', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'OpenJDK', 'JetBrains']) directories.push([path.join(parent, vendor), 2])
  const seen = new Set<string>(), result: string[] = []
  for (const [directory, depth] of directories) {
    for (const home of javaHomesUnder(directory, depth)) {
      const key = WINDOWS ? home.toLowerCase() : home
      if (seen.has(key)) continue
      seen.add(key); result.push(home)
    }
  }
  return result
}
function parseJavaProbe(home: string, source: JavaSource, code: number, output: string): JavaCandidate {
  const declared = releaseVersion(home)
  const version = output.match(/version\s+"([^"]+)"/)?.[1] ?? declared
  const reported = output.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1]?.trim()
  const resolved = reported && existsSync(reported) ? path.resolve(reported) : path.resolve(home)
  const javac = existsSync(javacBinary(resolved))
  const major = javaMajor(version)
  const ok = code === 0 && major === JAVA_MAJOR && javac
  return {
    path: resolved, source, version, javac, ok,
    error: ok ? undefined : !javac ? '缺少 javac（需要完整 JDK，而不是 JRE）' : code !== 0 ? '无法执行 java -version' : `需要 Java ${JAVA_MAJOR}，当前为 ${version ?? '未知版本'}`
  }
}
async function probeJava(home: string, source: JavaSource): Promise<JavaCandidate> {
  const resolved = path.resolve(home), declared = releaseVersion(resolved)
  if (!existsSync(javaBinary(resolved))) return { path: resolved, source, version: declared, javac: false, ok: false, error: '缺少 bin/java，目录不是 JDK' }
  if (declared && javaMajor(declared) !== JAVA_MAJOR) return { path: resolved, source, version: declared, javac: existsSync(javacBinary(resolved)), ok: false, error: `需要 Java ${JAVA_MAJOR}，当前为 ${declared}` }
  const result = await execCapture(javaBinary(resolved), ['-XshowSettings:properties', '-version'], undefined, 4000)
  return parseJavaProbe(resolved, source, result.code, result.output)
}
function probeJavaSync(home: string, source: JavaSource): JavaCandidate {
  const resolved = path.resolve(home), declared = releaseVersion(resolved)
  if (!existsSync(javaBinary(resolved))) return { path: resolved, source, version: declared, javac: false, ok: false, error: '缺少 bin/java，目录不是 JDK' }
  if (declared) {
    const javac = existsSync(javacBinary(resolved)), ok = javaMajor(declared) === JAVA_MAJOR && javac
    return { path: resolved, source, version: declared, javac, ok, error: ok ? undefined : !javac ? '缺少 javac（需要完整 JDK，而不是 JRE）' : `需要 Java ${JAVA_MAJOR}，当前为 ${declared}` }
  }
  const checked = spawnSync(javaBinary(resolved), ['-XshowSettings:properties', '-version'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
  return parseJavaProbe(resolved, source, checked.status ?? -1, `${checked.stdout || ''}${checked.stderr || ''}`)
}
function successfulJava(candidate: JavaCandidate, candidates: JavaCandidate[], config: JavaConfig): JavaStatus {
  return { ok: true, version: candidate.version, path: candidate.path, source: candidate.source, javac: candidate.javac, candidates, configPath: config.path, ...(config.error ? { configError: config.error } : {}) }
}
function failedJava(candidates: JavaCandidate[], config: JavaConfig, reason?: string): JavaStatus {
  const explicit = candidates.filter((candidate) => candidate.source === 'configured' || candidate.source === 'modcrafting-env' || candidate.source === 'java-home')
  const detail = explicit.map((candidate) => `${javaSourceLabel(candidate.source)} → ${candidate.version ?? '未知版本'}${candidate.javac ? '' : '（无 javac）'}`).join('；')
  const summary = explicit[0]
  return {
    ok: false, ...(summary ? { version: summary.version, path: summary.path, source: summary.source, javac: summary.javac } : {}),
    error: reason ?? `需要 JDK ${JAVA_MAJOR}（含 javac）。${detail ? `已检查：${detail}。` : ''}可调用 modcrafting_toolchain 指定已安装的 JDK 21。`,
    candidates, configPath: config.path, ...(config.error ? { configError: config.error } : {})
  }
}

export class SystemToolchainProvider {
  private readonly dataRoot?: string
  private readonly storageSettings: Omit<StorageOptions, 'dataRoot' | 'projectPath'>
  private cachedJava?: { key: string; value: JavaStatus; at: number }
  constructor(dataRoot?: string, storageSettings: Omit<StorageOptions, 'dataRoot' | 'projectPath'> = {}) { this.dataRoot = dataRoot; this.storageSettings = storageSettings }

  javaConfigPath(): string | undefined { return this.dataRoot ? path.join(this.dataRoot, 'toolchain.json') : undefined }
  readJavaConfig(): JavaConfig {
    const file = this.javaConfigPath()
    if (!file || !existsSync(file)) return { path: file }
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { javaHome?: unknown }
      if (typeof value.javaHome !== 'string' || !path.isAbsolute(value.javaHome)) throw Error('javaHome 必须是绝对路径')
      return { path: file, javaHome: value.javaHome }
    } catch (cause) { return { path: file, error: `工具链配置无法读取：${String(cause)}` } }
  }
  private pointers(config: JavaConfig): JavaPointer[] {
    const pointers: JavaPointer[] = []
    const add = (home: string | undefined, source: JavaSource) => { if (home?.trim()) pointers.push({ home: home.trim(), source }) }
    add(config.javaHome, 'configured')
    add(process.env.MODCRAFTING_JAVA_HOME, 'modcrafting-env')
    add(process.env.JAVA_HOME, 'java-home')
    for (const home of pathJavaHomes()) add(home, 'path')
    return pointers
  }
  private cacheKey(config: JavaConfig): string {
    let stamp = ''
    try { stamp = config.path && existsSync(config.path) ? String(statSync(config.path).mtimeMs) : '' } catch { /* unreadable config uses the fallback below */ }
    return [stamp, config.javaHome || '', process.env.MODCRAFTING_JAVA_HOME || '', process.env.JAVA_HOME || '', process.env.PATH || ''].join('|')
  }
  private remember(key: string, value: JavaStatus): JavaStatus {
    if (value.ok) this.cachedJava = { key, value, at: Date.now() }
    return value
  }
  private cached(key: string): JavaStatus | undefined {
    if (this.cachedJava?.key === key && Date.now() - this.cachedJava.at < 15_000) return this.cachedJava.value
    return undefined
  }
  async resolveJava(): Promise<JavaStatus> {
    const config = this.readJavaConfig(), key = this.cacheKey(config)
    const cached = this.cached(key)
    if (cached) return cached
    const candidates: JavaCandidate[] = [], seen = new Set<string>()
    let missing: string | undefined
    const inspect = async (home: string, source: JavaSource) => {
      const resolved = path.resolve(home), identity = WINDOWS ? resolved.toLowerCase() : resolved
      const known = candidates.find((candidate) => (WINDOWS ? candidate.path.toLowerCase() : candidate.path) === identity)
      if (known) return known
      seen.add(identity)
      if (!existsSync(resolved)) {
        const candidate: JavaCandidate = { path: resolved, source, javac: false, ok: false, error: '目录不存在' }
        candidates.push(candidate)
        if (source === 'configured' || source === 'modcrafting-env' || source === 'java-home') missing ??= `${javaSourceLabel(source)} 指向不存在的目录：${resolved}`
        return candidate
      }
      const candidate = await probeJava(resolved, source)
      candidates.push(candidate)
      return candidate
    }
    for (const pointer of this.pointers(config).filter((pointer) => pointer.source !== 'path')) {
      const candidate = await inspect(pointer.home, pointer.source)
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    if (missing) return this.remember(key, failedJava(candidates, config, `${missing}。请修正该变量，或调用 modcrafting_toolchain 指定已安装的 JDK 21；修改系统环境变量后需完全退出并重启 Qoder。`))
    for (const pointer of this.pointers(config).filter((pointer) => pointer.source === 'path')) {
      const identity = WINDOWS ? path.resolve(pointer.home).toLowerCase() : path.resolve(pointer.home)
      if (seen.has(identity)) continue
      const candidate = await inspect(pointer.home, pointer.source)
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    for (const home of discoveredJavaHomes()) {
      const identity = WINDOWS ? path.resolve(home).toLowerCase() : path.resolve(home)
      if (seen.has(identity)) continue
      const candidate = await inspect(home, 'discovered')
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    return this.remember(key, failedJava(candidates, config))
  }
  resolveJavaSync(): JavaStatus {
    const config = this.readJavaConfig(), key = this.cacheKey(config)
    const cached = this.cached(key)
    if (cached) return cached
    const candidates: JavaCandidate[] = [], seen = new Set<string>()
    let missing: string | undefined
    const inspect = (home: string, source: JavaSource): JavaCandidate => {
      const resolved = path.resolve(home), identity = WINDOWS ? resolved.toLowerCase() : resolved
      const known = candidates.find((candidate) => (WINDOWS ? candidate.path.toLowerCase() : candidate.path) === identity)
      if (known) return known
      seen.add(identity)
      if (!existsSync(resolved)) {
        const candidate: JavaCandidate = { path: resolved, source, javac: false, ok: false, error: '目录不存在' }
        candidates.push(candidate)
        if (source === 'configured' || source === 'modcrafting-env' || source === 'java-home') missing ??= `${javaSourceLabel(source)} 指向不存在的目录：${resolved}`
        return candidate
      }
      const candidate = probeJavaSync(resolved, source)
      candidates.push(candidate)
      return candidate
    }
    for (const pointer of this.pointers(config).filter((pointer) => pointer.source !== 'path')) {
      const candidate = inspect(pointer.home, pointer.source)
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    if (missing) return this.remember(key, failedJava(candidates, config, `${missing}。请修正该变量，或调用 modcrafting_toolchain 指定已安装的 JDK 21；修改系统环境变量后需完全退出并重启 Qoder。`))
    for (const pointer of this.pointers(config).filter((pointer) => pointer.source === 'path')) {
      const identity = WINDOWS ? path.resolve(pointer.home).toLowerCase() : path.resolve(pointer.home)
      if (seen.has(identity)) continue
      const candidate = inspect(pointer.home, pointer.source)
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    for (const home of discoveredJavaHomes()) {
      const identity = WINDOWS ? path.resolve(home).toLowerCase() : path.resolve(home)
      if (seen.has(identity)) continue
      const candidate = inspect(home, 'discovered')
      if (candidate.ok) return this.remember(key, successfulJava(candidate, candidates, config))
    }
    return this.remember(key, failedJava(candidates, config))
  }
  preflight(projectPath?: string): JavaStatus {
    if (projectPath) {
      const project = inspectFabricProject(projectPath)
      if (!project.wrapperPath) throw Object.assign(new Error('当前工程缺少 gradlew.bat；无法开始构建。请新建工程或选择已有完整 Fabric 工程。'), { code: 'ENVIRONMENT_UNAVAILABLE' })
    }
    const java = this.resolveJavaSync()
    if (!java.ok) throw Object.assign(new Error(java.error || `需要 JDK ${JAVA_MAJOR}`), { code: 'ENVIRONMENT_UNAVAILABLE', java })
    return java
  }
  async scanJavas(): Promise<JavaCandidate[]> {
    const config = this.readJavaConfig(), candidates: JavaCandidate[] = [], seen = new Set<string>()
    const homes: JavaPointer[] = [...this.pointers(config), ...discoveredJavaHomes().map((home) => ({ home, source: 'discovered' as const }))]
    for (const pointer of homes) {
      const resolved = path.resolve(pointer.home), identity = WINDOWS ? resolved.toLowerCase() : resolved
      if (seen.has(identity)) continue
      seen.add(identity)
      candidates.push(await probeJava(resolved, pointer.source))
    }
    return candidates.sort((a, b) => Number(b.ok) - Number(a.ok) || String(b.version || '').localeCompare(String(a.version || '')))
  }
  async configureJava(javaHome: string): Promise<{ configPath: string; javaHome: string; version?: string }> {
    if (!path.isAbsolute(javaHome)) throw Object.assign(new Error('javaHome 必须是绝对路径。'), { code: 'INVALID_ARGUMENT' })
    const candidate = await probeJava(javaHome, 'configured')
    if (!candidate.ok) throw Object.assign(new Error(`这个目录不是可用的 JDK ${JAVA_MAJOR}：${candidate.error}`), { code: 'JDK21_REQUIRED' })
    const file = this.javaConfigPath()
    if (!file) throw Object.assign(new Error('当前后端没有可写的数据目录，无法保存工具链配置。'), { code: 'DATA_DIRECTORY_UNAVAILABLE' })
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, javaHome: candidate.path }, null, 2) + '\n', 'utf8')
    this.cachedJava = undefined
    return { configPath: file, javaHome: candidate.path, version: candidate.version }
  }
  clearJava(): { configPath?: string; removed: boolean } {
    const file = this.javaConfigPath()
    if (!file || !existsSync(file)) { this.cachedJava = undefined; return { configPath: file, removed: false } }
    unlinkSync(file)
    this.cachedJava = undefined
    return { configPath: file, removed: true }
  }
  async status(projectPath?: string): Promise<EnvironmentStatus> {
    const java = await this.resolveJava()
    const project = projectPath ? inspectFabricProject(projectPath) : undefined
    const wrapper = Boolean(project?.wrapperPath)
    const storage = this.dataRoot ? await this.storageStatus(projectPath) : undefined
    const remediation: string[] = []
    if (!java.ok) {
      remediation.push('安装或选择 JDK 21（必须包含 javac）。')
      remediation.push('调用 modcrafting_toolchain（action="write", javaHome="C:\\\\path\\\\to\\\\jdk-21"）可立即切换工具链，无需重启 Qoder。')
      remediation.push('也可以设置 MODCRAFTING_JAVA_HOME；修改系统 JAVA_HOME 后必须完全退出并重启 Qoder，仅重新连接 MCP 不会刷新宿主环境变量。')
    }
    if (projectPath && !wrapper) remediation.push('当前文件夹还不是完整模组工程；新建工程或选择已有工程。')
    if (storage?.warning) remediation.push(storage.warning)
    return {
      ok: java.ok && (!projectPath || wrapper), platform: process.platform, node: process.version, java,
      gradleWrapper: wrapper, target: FABRIC_TARGET, remediation,
      ...(storage ? { storage } : {})
    }
  }
  private async storageStatus(projectPath?: string): Promise<StorageStatus> {
    if (!this.dataRoot) throw Object.assign(new Error('当前后端没有可写的数据目录，无法解析构建缓存。'), { code: 'DATA_DIRECTORY_UNAVAILABLE' })
    return resolveStorage({ dataRoot: this.dataRoot, ...(projectPath ? { projectPath } : {}), ...this.storageSettings })
  }
  async storageReport(projectPath?: string): Promise<{ storage: StorageStatus; usage: StorageUsage; legacy?: { path: string; usage: StorageUsage } }> {
    const storage = await this.storageStatus(projectPath)
    const usage = await storageUsage(storage.gradleUserHome)
    const legacyRoot = path.join(this.dataRoot!, 'cache')
    const legacy = path.resolve(legacyRoot) !== path.resolve(storage.cacheRoot) && existsSync(legacyRoot)
      ? { path: legacyRoot, usage: await storageUsage(legacyRoot) }
      : undefined
    return { storage, usage, ...(legacy ? { legacy } : {}) }
  }
  async storageWrite(cacheRoot: string, projectPath?: string): Promise<{ storage: StorageStatus }> {
    if (!this.dataRoot) throw Object.assign(new Error('当前后端没有可写的数据目录，无法保存缓存配置。'), { code: 'DATA_DIRECTORY_UNAVAILABLE' })
    const storage = await configureStorage({ dataRoot: this.dataRoot, ...(projectPath ? { projectPath } : {}), ...this.storageSettings, cacheRoot })
    return { storage }
  }
  async storageMigrate(targetRoot: string, projectPath?: string): Promise<{ from: string; to: string; bytes: number; files: number; storage: StorageStatus }> {
    if (!this.dataRoot) throw Object.assign(new Error('当前后端没有可写的数据目录，无法迁移构建缓存。'), { code: 'DATA_DIRECTORY_UNAVAILABLE' })
    const result = await migrateStorage({ dataRoot: this.dataRoot, ...(projectPath ? { projectPath } : {}), ...this.storageSettings, targetRoot })
    return { ...result, storage: withEnvPrecedenceWarning(await this.storageStatus(projectPath)) }
  }
  async storageClean(targetRoot?: string, projectPath?: string): Promise<{ removed: string[]; freedBytes: number; storage: StorageStatus }> {
    if (!this.dataRoot) throw Object.assign(new Error('当前后端没有可写的数据目录，无法清理构建缓存。'), { code: 'DATA_DIRECTORY_UNAVAILABLE' })
    const result = await cleanStorage({ dataRoot: this.dataRoot, ...(projectPath ? { projectPath } : {}), ...this.storageSettings, ...(targetRoot ? { targetRoot } : {}) })
    return { ...result, storage: await this.storageStatus(projectPath) }
  }
  async startGradle(projectPath: string, task: string, events?: RuntimeEvents, extraArgs: string[] = []): Promise<ChildProcess> {
    const project = inspectFabricProject(projectPath)
    if (!project.wrapperPath) throw Object.assign(new Error('gradlew.bat is required; this plugin never downloads Gradle'), { code: 'ENVIRONMENT_UNAVAILABLE' })
    const status = await this.status(projectPath)
    if (!status.java.ok) throw Object.assign(new Error(status.java.error), { code: 'ENVIRONMENT_UNAVAILABLE' })
    if (!/^[A-Za-z][A-Za-z0-9:.-]*$/.test(task) || extraArgs.some((value) => /[%!&|<>^\r\n]/.test(value))) throw Object.assign(new Error('Unsafe Gradle task arguments'), { code: 'INVALID_ARGUMENT' })
    const storage = status.storage
    if (storage) ensureStorageDirs(storage)
    if (storage) events?.onLog?.('gradle', `[modcrafting] Gradle 缓存：${storage.gradleUserHome}（${storageSourceLabel(storage.source)}）；临时目录：${storage.temporaryDirectory}${storage.warning ? `。${storage.warning}` : ''}\n`)
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : project.wrapperPath, process.platform === 'win32' ? ['/d', '/v:off', '/s', '/c', '.\\gradlew.bat', task, '--no-daemon', ...extraArgs] : [task, '--no-daemon', ...extraArgs], { cwd: project.path, windowsHide: true, shell: false, env: { ...process.env, JAVA_HOME: status.java.path, JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS || '', ...(storage ? { GRADLE_USER_HOME: storage.gradleUserHome, TEMP: storage.temporaryDirectory, TMP: storage.temporaryDirectory } : {}) } })
    child.stdout.on('data', (value) => events?.onLog?.('gradle', String(value)))
    child.stderr.on('data', (value) => events?.onLog?.('gradle', String(value)))
    return child
  }
}

export function inspectFabricProject(projectPath: string): FabricProject {
  const root = path.resolve(projectPath)
  const errors: string[] = []
  if (!existsSync(root) || !statSync(root).isDirectory()) errors.push('project path does not exist')
  const modJson = path.join(root, 'src', 'main', 'resources', 'fabric.mod.json')
  // Platform metadata decides which loader a project targets; everything downstream
  // (layout, knowledge lookup, capabilities) reads the same value.
  const modsToml = path.join(root, 'src', 'main', 'resources', 'META-INF', 'neoforge.mods.toml')
  const forgeToml = path.join(root, 'src', 'main', 'resources', 'META-INF', 'mods.toml')
  const wrapper = path.join(root, 'gradlew.bat')
  let loader: FabricProject['loader'] | undefined
  let modId: string | undefined
  if (existsSync(modJson)) {
    loader = 'fabric'
    try { const metadata = JSON.parse(readFileSync(modJson, 'utf8')); if (typeof metadata.id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(metadata.id)) errors.push('fabric.mod.json requires a valid mod id'); else modId = metadata.id } catch { errors.push('fabric.mod.json is invalid JSON') }
  } else if (existsSync(modsToml)) {
    loader = 'neoforge'
    try {
      const metadata = readFileSync(modsToml, 'utf8')
      modId = metadata.match(/^modId\s*=\s*"([a-z][a-z0-9_-]{1,63})"$/m)?.[1]
      if (!modId) errors.push('neoforge.mods.toml requires a valid modId')
    } catch { errors.push('neoforge.mods.toml is unreadable') }
  } else if (existsSync(forgeToml)) {
    loader = 'forge'
    try {
      const metadata = readFileSync(forgeToml, 'utf8')
      modId = metadata.match(/^modId\s*=\s*"([a-z][a-z0-9_-]{1,63})"$/m)?.[1]
      if (!modId) errors.push('mods.toml requires a valid modId')
    } catch { errors.push('mods.toml is unreadable') }
  } else errors.push('missing src/main/resources/fabric.mod.json')
  if (!existsSync(wrapper)) errors.push('missing gradlew.bat')
  let minecraftVersion: string | undefined
  try { const gradle = readFileSync(path.join(root, 'gradle.properties'), 'utf8'); minecraftVersion = gradle.match(/^minecraft_version=(.+)$/m)?.[1]?.trim() } catch { /* optional */ }
  return { path: root, valid: errors.length === 0, loader, modId, minecraftVersion, wrapperPath: existsSync(wrapper) ? wrapper : undefined, errors }
}

export interface ProjectDiagnostic { level: 'error' | 'warning'; code: string; path: string; message: string }

function relativeResourcePath(root: string, file: string): string { return path.relative(root, file).replace(/\\/g, '/') }
function jsonFilesUnder(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? jsonFilesUnder(file) : entry.isFile() && entry.name.endsWith('.json') ? [file] : []
  }).sort()
}
function parseJsonObject(file: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value: value as Record<string, unknown> } : { ok: false, error: '顶层必须是 JSON 对象' }
  } catch (cause) { return { ok: false, error: String(cause) } }
}
function collectModelReferences(value: unknown, output: string[]): void {
  if (Array.isArray(value)) { for (const item of value) collectModelReferences(item, output); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'model' && typeof child === 'string') output.push(child)
    else collectModelReferences(child, output)
  }
}
function localReference(reference: string, modId: string): { namespace: string; resource: string } | undefined {
  if (!reference || reference.startsWith('#')) return undefined
  const separator = reference.indexOf(':')
  const namespace = separator >= 0 ? reference.slice(0, separator) : modId
  const resource = separator >= 0 ? reference.slice(separator + 1) : reference
  if (!resource || namespace !== modId) return undefined
  return { namespace, resource }
}
function validateResourceReferences(root: string, resources: string, modId: string, diagnostics: ProjectDiagnostic[], layout: ResourceLayout): void {
  const assets = path.join(resources, 'assets', modId)
  const add = (level: 'error' | 'warning', code: string, file: string, message: string) => diagnostics.push({ level, code, path: relativeResourcePath(root, file), message })
  const modelsRoot = path.join(assets, 'models')
  const modelExists = (reference: string) => {
    const local = localReference(reference, modId)
    return !local || existsSync(path.join(modelsRoot, `${local.resource.replace(/\.json$/, '')}.json`))
  }
  const textureExists = (reference: string) => {
    const local = localReference(reference, modId)
    if (!local) return true
    const texture = local.resource.replace(/\.png$/i, '')
    return existsSync(path.join(assets, 'textures', `${texture}.png`))
  }
  for (const file of jsonFilesUnder(modelsRoot)) {
    const parsed = parseJsonObject(file)
    if ('error' in parsed) { add('error', 'INVALID_JSON', file, `模型 JSON 无法解析：${parsed.error}`); continue }
    const parent = parsed.value.parent
    if (typeof parent === 'string' && !parent.startsWith('builtin/') && !modelExists(parent)) add('error', 'MISSING_MODEL', file, `parent 引用的模型不存在（模型路径区分大小写）：${parent}`)
    const textures = parsed.value.textures
    if (textures && typeof textures === 'object' && !Array.isArray(textures)) {
      for (const [key, value] of Object.entries(textures as Record<string, unknown>)) {
        if (typeof value === 'string' && !value.startsWith('#') && !textureExists(value)) add('error', 'MISSING_TEXTURE', file, `纹理 "${key}" 引用的图片不存在：${value}（应为 assets/${modId}/textures/${localReference(value, modId)?.resource || value}.png）`)
      }
    }
    const relative = relativeResourcePath(modelsRoot, file)
    if (layout.itemModelDefinition === 'assets-items' && relative.startsWith('item/')) {
      const itemPath = relative.slice('item/'.length).replace(/\.json$/, '')
      const definition = path.join(assets, 'items', ...itemPath.split('/')) + '.json'
      if (!existsSync(definition)) add('error', 'MISSING_ITEM_MODEL_DEFINITION', file, `该版本需要 assets/${modId}/items/${itemPath}.json 指向这个物品模型；只有 models/item 文件时物品会显示紫黑占位。`)
    }
  }
  for (const file of layout.itemModelDefinition === 'assets-items' ? jsonFilesUnder(path.join(assets, 'items')) : []) {
    const parsed = parseJsonObject(file)
    if ('error' in parsed) { add('error', 'INVALID_JSON', file, `物品模型定义 JSON 无法解析：${parsed.error}`); continue }
    const references: string[] = []
    collectModelReferences(parsed.value, references)
    for (const reference of new Set(references)) if (!modelExists(reference)) add('error', 'MISSING_MODEL', file, `物品模型定义引用的模型不存在：${reference}`)
  }
  for (const file of jsonFilesUnder(path.join(assets, 'blockstates'))) {
    const parsed = parseJsonObject(file)
    if ('error' in parsed) { add('error', 'INVALID_JSON', file, `方块状态 JSON 无法解析：${parsed.error}`); continue }
    const references: string[] = []
    collectModelReferences(parsed.value, references)
    for (const reference of new Set(references)) if (!modelExists(reference)) add('error', 'MISSING_MODEL', file, `方块状态引用的模型不存在：${reference}`)
  }
  for (const name of ['en_us', 'zh_cn']) {
    const file = path.join(assets, 'lang', `${name}.json`)
    if (!existsSync(file)) continue
    const parsed = parseJsonObject(file)
    if ('error' in parsed) add('error', 'INVALID_JSON', file, `语言文件无法解析：${parsed.error}`)
  }
  const recipes = path.join(resources, 'data', modId, layout.recipeDir)
  for (const file of jsonFilesUnder(recipes)) {
    const parsed = parseJsonObject(file)
    if ('error' in parsed) add('error', 'INVALID_JSON', file, `配方 JSON 无法解析：${parsed.error}`)
    else if (typeof parsed.value.type !== 'string') add('error', 'INVALID_RECIPE', file, '配方缺少字符串 type；游戏不会加载这个文件。')
  }
  const wrongRecipeDir = path.join(resources, 'data', modId, layout.recipeDir === 'recipe' ? 'recipes' : 'recipe')
  if (existsSync(wrongRecipeDir)) add('warning', 'LEGACY_RECIPE_DIRECTORY', wrongRecipeDir, `该版本使用 ${layout.recipeDir} 目录；${path.basename(wrongRecipeDir)} 目录中的配方不会被加载。`)
}
function validateMixinConfiguration(root: string, resources: string, metadata: Record<string, unknown>, diagnostics: ProjectDiagnostic[]): void {
  const declared = metadata.mixins
  if (!Array.isArray(declared)) return
  for (const entry of declared) {
    const file = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).config === 'string' ? String((entry as Record<string, unknown>).config) : undefined
    if (!file) { diagnostics.push({ level: 'warning', code: 'INVALID_MIXIN_ENTRY', path: 'src/main/resources/fabric.mod.json', message: 'mixins 条目缺少 config 路径，无法检查。' }); continue }
    const target = path.join(resources, file)
    if (!existsSync(target)) { diagnostics.push({ level: 'error', code: 'MISSING_MIXIN_CONFIG', path: relativeResourcePath(root, target), message: 'fabric.mod.json 声明的 Mixin 配置不存在；游戏启动时会失败。' }); continue }
    const parsed = parseJsonObject(target)
    if ('error' in parsed) diagnostics.push({ level: 'error', code: 'INVALID_JSON', path: relativeResourcePath(root, target), message: `Mixin 配置无法解析：${parsed.error}` })
    else if (typeof parsed.value.package !== 'string' || !parsed.value.package) diagnostics.push({ level: 'warning', code: 'MIXIN_PACKAGE_MISSING', path: relativeResourcePath(root, target), message: 'Mixin 配置缺少 package；请确认类路径与方法签名。' })
  }
}

const VERSION_ID_RE = /^\d+\.\d+(?:\.\d+)?$/

/**
 * Validation follows the project's own version, so a 1.20.1 project is not
 * judged by 1.21.4 resource rules (no assets/<ns>/items/, plural recipes/).
 */
function resolveValidationLayout(minecraftVersion?: string): { layout: ResourceLayout; inMatrix: boolean; error?: string } {
  const registry = getRegistry()
  const fallback = deriveResourceLayout(FABRIC_TARGET.minecraft, registry)
  if (!minecraftVersion) return { layout: fallback, inMatrix: false }
  if (!VERSION_ID_RE.test(minecraftVersion)) {
    return { layout: fallback, inMatrix: false, error: `minecraft_version=${minecraftVersion} 不是有效的正式版号；写成 1.21.4 或 26.3 这样的格式。` }
  }
  if (!registry.has(minecraftVersion)) {
    return { layout: fallback, inMatrix: false, error: `minecraft_version=${minecraftVersion} 不在已同步的正式版清单里；运行 pnpm run versions:sync 后重试，或改用矩阵内的版本。` }
  }
  return { layout: deriveResourceLayout(minecraftVersion, registry), inMatrix: registry.milestones().includes(minecraftVersion) }
}

export function validateFabricProject(projectPath: string): { ok: boolean; project: FabricProject; checks: Record<string, boolean>; diagnostics: ProjectDiagnostic[] } {
  const project = inspectFabricProject(projectPath)
  const diagnostics: ProjectDiagnostic[] = []
  const resources = path.join(project.path, 'src', 'main', 'resources')
  const resolution = resolveValidationLayout(project.minecraftVersion)
  if (!project.minecraftVersion) diagnostics.push({ level: 'error', code: 'MINECRAFT_VERSION_MISSING', path: 'gradle.properties', message: '缺少 minecraft_version；请声明目标版本（例如 1.21.4 或 26.3）。' })
  else if (resolution.error) diagnostics.push({ level: 'error', code: 'INVALID_MINECRAFT_VERSION', path: 'gradle.properties', message: resolution.error })
  else if (!resolution.inMatrix) diagnostics.push({ level: 'warning', code: 'TARGET_NOT_IN_MATRIX', path: 'gradle.properties', message: `minecraft_version=${project.minecraftVersion} 可以校验，但不在发布矩阵内；需要参与多版本发布时把它加进 catalog 的 milestones。` })
  let metadata: Record<string, unknown> | undefined
  const metadataFile = path.join(resources, 'fabric.mod.json')
  if (existsSync(metadataFile)) {
    const parsed = parseJsonObject(metadataFile)
    if ('error' in parsed) diagnostics.push({ level: 'error', code: 'INVALID_JSON', path: 'src/main/resources/fabric.mod.json', message: `fabric.mod.json 无法解析：${parsed.error}` })
    else metadata = parsed.value
  }
  if (metadata) {
    const icon = metadata.icon
    if (typeof icon === 'string' && icon && !existsSync(path.join(resources, icon))) diagnostics.push({ level: 'warning', code: 'MISSING_ICON', path: `src/main/resources/${icon}`, message: 'fabric.mod.json 声明的图标文件不存在。' })
    const depends = metadata.depends
    if (depends && typeof depends === 'object' && !Array.isArray(depends)) {
      const minecraft = (depends as Record<string, unknown>).minecraft
      if (typeof minecraft === 'string' && !minecraft.includes(FABRIC_TARGET.minecraft)) diagnostics.push({ level: 'warning', code: 'MINECRAFT_DEPENDENCY_MISMATCH', path: 'src/main/resources/fabric.mod.json', message: `depends.minecraft=${minecraft} 与目标 ${FABRIC_TARGET.minecraft} 不一致。` })
    }
    if (project.modId) validateResourceReferences(project.path, resources, project.modId, diagnostics, resolution.layout)
    validateMixinConfiguration(project.path, resources, metadata, diagnostics)
  }
  const checks = {
    fabricModJson: Boolean(project.modId),
    wrapper: Boolean(project.wrapperPath),
    targetResolved: Boolean(project.minecraftVersion) && !resolution.error,
    resourceReferences: !diagnostics.some((diagnostic) => diagnostic.level === 'error')
  }
  return { ok: project.valid && Object.values(checks).every(Boolean), project, checks, diagnostics }
}

export interface ProjectWrapper { batch: string; properties: string; jarBase64: string }
export interface MaterializeVersions {
  minecraft: string
  loader: string
  api: string
  mappings: string
  mappingKind: 'yarn' | 'mojmap'
  loom: string
  gradle: string
  javaMajor: number
}

/**
 * The version tuple a project is written with.
 *
 * The build toolchain (Gradle + Loom) is part of the *product*, not part of the
 * target: one shipped toolchain must serve every Minecraft version, otherwise a
 * target silently means "a different build system". Only Minecraft, loader, API
 * and mappings vary per target.
 *
 * The pinned target additionally keeps the exact loader/API/mappings this repo
 * has built, so the default project's bytes never drift.
 *
 * Probed 2026-11-16: maven's newest Loom (1.19.4) refuses to run on our Gradle
 * 9.5.0 (`requires at least Gradle 9.8.0`), so following "latest plugin" per target
 * would break the build for reasons unrelated to Minecraft.
 */
export function materializeVersions(target: ResolvedTarget): MaterializeVersions {
  const pinned = target.loader === 'fabric' && target.minecraft === FABRIC_TARGET.minecraft
  // Three toolchains, each forced by an upstream constraint rather than preference:
  //  - shipped: Gradle 9.5.0 + Loom 1.17.12, targets up to 1.21.11;
  //  - 26.x: Loom 1.19.4 needs Gradle >= 9.8 (probed 2026-11-16);
  //  - forge: ForgeGradle 6 refuses Gradle >= 9.0 (probed 2026-11-19).
  const secondToolchain = target.loader === 'fabric' && target.release.javaTarget > 21
  const forgeToolchain = target.loader === 'forge'
  return {
    minecraft: target.minecraft,
    loader: pinned ? FABRIC_TARGET.loader : target.release.loaderVersion,
    api: pinned ? FABRIC_TARGET.fabricApi : target.release.apiVersion ?? '',
    mappings: pinned ? FABRIC_TARGET.yarn : target.release.mappings.version,
    mappingKind: pinned ? 'yarn' : target.release.mappings.kind === 'mojmap' ? 'mojmap' : 'yarn',
    loom: secondToolchain ? target.release.build?.pluginVersion ?? '1.19.4' : FABRIC_TARGET.loom,
    gradle: forgeToolchain ? '8.10.2' : secondToolchain ? '9.8.0' : FABRIC_TARGET.gradle,
    javaMajor: target.release.javaTarget
  }
}

/**
 * Write a complete project for any resolved target.
 *
 * The scaffold owns the canonical file shapes; this rewrites only the four version
 * values, so one template serves every target and the pinned scaffold never drifts.
 * Non-Fabric loaders are rejected until the Java dialect layer (P4) exists: a
 * NeoForge project with Yarn imports would not compile, and pretending otherwise
 * is worse than refusing.
 */
export async function materializeProject(input: { projectPath: string; modId: string; modName: string; target: ResolvedTarget; wrapper?: ProjectWrapper }): Promise<FabricProject> {
  // One source of truth: the capability table decides, not a local loader check.
  const capability = capabilitiesFor(input.target).createProject
  if (capability.state === 'blocked') throw new Error(`${capability.reason}；${capability.requirement ?? ''}`.trim())
  const root = path.resolve(input.projectPath)
  if (existsSync(root) && (await readdir(root)).length > 0) throw new Error('refusing to scaffold into a non-empty directory')
  if (input.target.loader === 'neoforge' || input.target.loader === 'forge') {
    const platform = input.target.loader === 'forge' ? forgeProjectFiles(input.target, input.modId, input.modName) : neoForgeProjectFiles(input.target, input.modId, input.modName)
    for (const file of platform.files) {
      const destination = path.join(root, ...file.path.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, file.content, 'utf8')
    }
    if (input.wrapper) {
      await mkdir(path.join(root, 'gradle', 'wrapper'), { recursive: true })
      await writeFile(path.join(root, 'gradlew.bat'), input.wrapper.batch, { flag: 'wx' })
      await writeFile(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'), input.wrapper.properties, { flag: 'wx' })
      await writeFile(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar'), Buffer.from(input.wrapper.jarBase64, 'base64'), { flag: 'wx' })
    }
    return inspectFabricProject(root)
  }
  // The scaffold owns the canonical Fabric file shapes; only the four version values are rewritten.
  const project = await scaffoldFabricProject(input.projectPath, input.modId, input.modName, input.wrapper)
  const fabricRoot = project.path, versions = materializeVersions(input.target)
  const properties = path.join(fabricRoot, 'gradle.properties')
  writeFileSync(properties, readFileSync(properties, 'utf8')
    .replace(/^minecraft_version=.*$/m, `minecraft_version=${versions.minecraft}`)
    .replace(/^yarn_mappings=.*$/m, `yarn_mappings=${versions.mappings}`)
    .replace(/^loader_version=.*$/m, `loader_version=${versions.loader}`)
    .replace(/^fabric_version=.*$/m, `fabric_version=${versions.api}`), 'utf8')
  const build = path.join(fabricRoot, 'build.gradle')
  const buildRewrite = readFileSync(build, 'utf8')
    .replace(/id 'fabric-loom' version '[^']+'/, `id 'fabric-loom' version '${versions.loom}'`)
    .replace(/com\.mojang:minecraft:[^"]+/, `com.mojang:minecraft:${versions.minecraft}`)
    .replace(/net\.fabricmc:fabric-loader:[^"]+/, `net.fabricmc:fabric-loader:${versions.loader}`)
    .replace(/net\.fabricmc\.fabric-api:fabric-api:[^"]+/, `net.fabricmc.fabric-api:fabric-api:${versions.api}`)
  // 26.x uses Mojang official mappings — yarn has no 26.x builds (maven-metadata,
  // probed 2026-11-16), so loom's official mappings API replaces the yarn coordinate.
  const buildFinal = versions.mappingKind === 'mojmap'
    ? buildRewrite.replace(/mappings "net\.fabricmc:yarn:[^"]+"/, 'mappings loom.officialMojangMappings()')
    : buildRewrite.replace(/net\.fabricmc:yarn:[^":]+:v2/, `net.fabricmc:yarn:${versions.mappings}:v2`)
  writeFileSync(build, buildFinal, 'utf8')
  const metadataFile = path.join(fabricRoot, 'src', 'main', 'resources', 'fabric.mod.json')
  const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, any>
  metadata.depends = { ...metadata.depends, fabricloader: `>=${versions.loader}`, minecraft: `~${versions.minecraft}`, java: `>=${versions.javaMajor}` }
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2), 'utf8')
  return inspectFabricProject(fabricRoot)
}

export async function scaffoldFabricProject(projectPath: string, modId: string, modName: string, wrapper?: ProjectWrapper): Promise<FabricProject> {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(modId)) throw new Error('modId must be lower-case and use [a-z0-9_-]')
  const root = path.resolve(projectPath)
  if (existsSync(root) && (await readdir(root)).length > 0) throw new Error('refusing to scaffold into a non-empty directory')
  await mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
  await writeFile(path.join(root, 'settings.gradle'), `pluginManagement { repositories { maven { url = 'https://maven.fabricmc.net/' }; gradlePluginPortal(); mavenCentral() } }\nrootProject.name = '${modId}'\n`, 'utf8')
  await writeFile(path.join(root, 'gradle.properties'), `minecraft_version=${FABRIC_TARGET.minecraft}\nyarn_mappings=${FABRIC_TARGET.yarn}\nloader_version=${FABRIC_TARGET.loader}\nfabric_version=${FABRIC_TARGET.fabricApi}\n`, 'utf8')
  await writeFile(path.join(root, 'build.gradle'), `plugins { id 'fabric-loom' version '${FABRIC_TARGET.loom}'; id 'maven-publish' }\nversion = '0.1.0'\ngroup = '${modId}'\nbase { archivesName = '${modId}' }\nrepositories { mavenCentral() }\ndependencies { minecraft "com.mojang:minecraft:${FABRIC_TARGET.minecraft}"; mappings "net.fabricmc:yarn:${FABRIC_TARGET.yarn}:v2"; modImplementation "net.fabricmc:fabric-loader:${FABRIC_TARGET.loader}"; modImplementation "net.fabricmc.fabric-api:fabric-api:${FABRIC_TARGET.fabricApi}" }\n`, 'utf8')
  await writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: modId, version: '0.1.0', name: modName, environment: '*', entrypoints: { main: [] }, depends: { fabricloader: `>=${FABRIC_TARGET.loader}`, minecraft: `~${FABRIC_TARGET.minecraft}`, java: '>=21', 'fabric-api': '*' } }, null, 2), 'utf8')
  await writeFile(path.join(root, '.gitignore'), '.modcrafting/\nrun/\n', 'utf8')
  if (wrapper) {
    await mkdir(path.join(root, 'gradle', 'wrapper'), { recursive: true })
    await writeFile(path.join(root, 'gradlew.bat'), wrapper.batch, { flag: 'wx' })
    await writeFile(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.properties'), wrapper.properties, { flag: 'wx' })
    await writeFile(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar'), Buffer.from(wrapper.jarBase64, 'base64'), { flag: 'wx' })
  }
  return inspectFabricProject(root)
}

export function discoveryPath(gameDirectory: string): string { return path.join(gameDirectory, 'modcrafting-bridge.json') }
export function readBridgeDiscovery(gameDirectory: string): BridgeDiscovery | null { try { const data = JSON.parse(readFileSync(discoveryPath(gameDirectory), 'utf8')); return typeof data.port === 'number' ? data : null } catch { return null } }
export function portIsListening(port: number): boolean {
  try {
    const command = process.platform === 'win32' ? 'netstat.exe' : 'sh'
    const args = process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-c', `(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -Eq '[:.]${port}[[:space:]]'`]
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 1500 })
    if (result.error) return true
    return process.platform === 'win32' ? new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(result.stdout || '') : result.status === 0
  } catch { return true }
}
export async function bridgeRequest(discovery: BridgeDiscovery, method: 'GET' | 'POST', apiPath: string, body?: Record<string, unknown>, timeoutMs = 10_000): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  if (!isAllowedBridgeApiPath(apiPath)) return { ok: false, status: 0, data: {}, error: 'bridge path is not allowed' }
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined
    const request = httpRequest({ host: '127.0.0.1', port: discovery.port, path: apiPath, method, timeout: timeoutMs, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}) } }, (response) => {
      let text = ''; response.on('data', (part) => { text += String(part) }); response.on('end', () => { let data: Record<string, unknown> = {}; try { data = JSON.parse(text) } catch { data = { text } }; resolve({ ok: (response.statusCode || 500) < 400 && data.ok !== false, status: response.statusCode || 0, data, error: data.error as string | undefined }) })
    })
    request.on('error', (error) => resolve({ ok: false, status: 0, data: {}, error: String(error) })); request.on('timeout', () => request.destroy(new Error('bridge timeout'))); if (payload) request.write(payload); request.end()
  })
}

export interface AssetResult { name: string; ok: boolean; path?: string; error?: string }
const PROXY = 'https://gh.xmly.dev/'
function proxy(url: string): string { return url.startsWith('https://github.com/') ? `${PROXY}${url}` : url }
async function download(url: string, destination: string): Promise<void> {
  const res = await fetch(url, { headers: { 'user-agent': 'ModCrafting Fabric plugin' } }); if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  await mkdir(path.dirname(destination), { recursive: true }); const temporary = `${destination}.download-${process.pid}`; await pipeline(res.body as never, createWriteStream(temporary)); await rm(destination, { force: true }); renameSync(temporary, destination)
}
async function extractZip(archive: string, destination: string): Promise<void> {
  const staging = `${destination}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // Relative paths avoid GNU tar on Windows treating drive letters as remote hosts.
  const cwd = path.dirname(archive)
  const result = await execCapture('tar', ['-xf', path.basename(archive), '-C', path.relative(cwd, staging).replace(/\\/g, '/')], cwd)
  if (result.code !== 0) { await rm(staging, { recursive: true, force: true }); throw new Error(`could not extract ${path.basename(archive)}: ${result.output.slice(-500)}`) }
  await rm(destination, { recursive: true, force: true })
  renameSync(staging, destination)
}
async function githubRelease(repo: string, prefix?: string): Promise<Record<string, unknown>> { const response = await fetch(`https://api.github.com/repos/${repo}/releases`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ModCrafting Fabric plugin' } }); if (!response.ok) throw new Error(`GitHub releases API: HTTP ${response.status}`); const releases = await response.json() as Record<string, unknown>[]; const release = releases.find((item) => !prefix || String(item.tag_name).startsWith(prefix)); if (!release) throw new Error(`no release matching ${prefix || 'latest'}`); return release }
export type DownloadableAsset = 'minecraft-data' | 'mc-wiki-zh' | 'mc-wiki-zh-index' | 'agent-knowledge'
/** Which Minecraft versions actually have published knowledge data. */
async function knowledgeVersions(repo: string): Promise<string[]> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ModCrafting Fabric plugin' } })
    if (!response.ok) return []
    const releases = await response.json() as Record<string, unknown>[]
    const versions = releases.map((item) => String(item.tag_name ?? '').match(/^knowledge-(\d+\.\d+(?:\.\d+)?)-/)?.[1]).filter((value): value is string => Boolean(value))
    return [...new Set(versions)]
  } catch { return [] }
}
export async function prepareAssets(paths: RuntimePaths, names?: DownloadableAsset[], options: { minecraft?: string } = {}): Promise<AssetResult[]> {
  // Only the directories this function writes; avoid scaffolding unrelated roots (e.g. logs/reports inside a project workspace).
  for (const directory of [paths.knowledgeRoot, paths.assetsRoot]) mkdirSync(directory, { recursive: true })
  const results: AssetResult[] = []
  const minecraft = options.minecraft?.trim() || FABRIC_TARGET.minecraft
  const plans = [{ repo: 'newstarbar/ModCrafting-knowledge-base', prefix: `knowledge-${minecraft}-`, names: ['minecraft-data.zip', 'mc-wiki-zh.zip', 'mc-wiki-zh-index.zip'], kind: 'knowledge' }, { repo: 'newstarbar/ModCrafting', names: ['agent-knowledge.zip'], kind: 'assets' }]
  for (const plan of plans) {
    const selected = plan.names.filter(name => !names || names.includes(name.replace(/\.zip$/, '') as DownloadableAsset))
    if (!selected.length) continue
    let assets: Record<string, unknown>[]
    try { const release = await githubRelease(plan.repo, plan.prefix); assets = Array.isArray(release.assets) ? release.assets as Record<string, unknown>[] : [] }
    catch (error) {
      // Only spend an extra request when a specific version was asked for and the
      // failure means "that release does not exist" — not on network errors.
      const explicit = Boolean(options.minecraft?.trim())
      const missingRelease = String(error).includes('no release matching')
      const available = plan.kind === 'knowledge' && explicit && missingRelease ? await knowledgeVersions(plan.repo) : []
      const message = available.length && !available.includes(minecraft)
        ? `${minecraft} 的知识数据尚未发布（已有 ${available.join(' / ')}）；不会用其他版本的数据冒充`
        : String(error)
      for (const name of selected) results.push({ name, ok: false, error: message })
      continue
    }
    for (const name of selected) {
      try {
        const asset = assets.find(item => item.name === name)
        if (typeof asset?.browser_download_url !== 'string') throw Error('release asset missing')
        const archive = path.join(paths.dataRoot, 'downloads', name)
        const destination = path.join(plan.kind === 'knowledge' ? paths.knowledgeRoot : paths.assetsRoot, name.replace(/\.zip$/i, ''))
        try { await download(proxy(asset.browser_download_url), archive) } catch { await download(asset.browser_download_url, archive) }
        await extractZip(archive, destination)
        const nested = path.join(destination, path.basename(destination))
        if (existsSync(nested)) { for (const entry of readdirSync(nested)) renameSync(path.join(nested, entry), path.join(destination, entry)); await rm(nested, { recursive: true, force: true }) }
        results.push({ name, ok: true, path: destination })
      } catch (error) { results.push({ name, ok: false, error: String(error) }) }
    }
  }
  return results
}

export interface KnowledgeIndexResolution { file: string; minecraft: string; exact: boolean; available: string[] }

/**
 * Knowledge data is published per Minecraft version, so a project must not read
 * another version's index without saying so. Resolution order:
 * exact version -> nearest available release (by catalog order) -> undefined.
 */
export function resolveKnowledgeIndex(knowledgeRoot: string, minecraft?: string): KnowledgeIndexResolution | undefined {
  const base = path.join(knowledgeRoot, 'minecraft-data')
  if (!existsSync(base)) return undefined
  const available = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(base, entry.name, 'index.json')))
    .map((entry) => entry.name)
  if (!available.length) return undefined
  const requested = minecraft?.trim()
  if (requested && available.includes(requested)) return { file: path.join(base, requested, 'index.json'), minecraft: requested, exact: true, available }
  const registry = getRegistry()
  const rank = new Map(registry.order.map((id, index) => [id, index]))
  const target = requested ? rank.get(requested) : undefined
  const chosen = target === undefined
    ? [...available].sort((left, right) => registry.compare(right, left))[0]
    : [...available].sort((left, right) => {
      const leftRank = rank.get(left), rightRank = rank.get(right)
      const distance = (value: number | undefined) => value === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(value - target)
      return distance(leftRank) - distance(rightRank) || (leftRank ?? 0) - (rightRank ?? 0)
    })[0]
  if (!chosen) return undefined
  // Nothing was requested, so the newest available index satisfies the request.
  return { file: path.join(base, chosen, 'index.json'), minecraft: chosen, exact: !requested, available }
}

export function lookupMinecraftData(
  paths: RuntimePaths,
  kind: 'block' | 'item' | 'entity' | 'enchantment' | 'recipe',
  query: string,
  options: { minecraft?: string; allowFallback?: boolean } = {}
): Record<string, unknown> {
  const resolution = resolveKnowledgeIndex(paths.knowledgeRoot, options.minecraft)
  if (!resolution) return { ok: false, code: 'ASSET_NOT_READY', assetReady: false, error: `minecraft-data unavailable under ${paths.knowledgeRoot}; run modcrafting_prepare_assets with names ["minecraft-data"]`, remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['minecraft-data'] } } }
  if (!resolution.exact && options.allowFallback !== true) {
    return {
      ok: false, code: 'KNOWLEDGE_VERSION_UNAVAILABLE', assetReady: false,
      requested: options.minecraft, availableVersions: resolution.available,
      error: `${options.minecraft ?? '该版本'} 的知识数据尚未发布（本地已有 ${resolution.available.join(' / ')}）。不会用其他版本的数据冒充，以免给出该版本不存在的物品。`,
      remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['minecraft-data'], minecraft: options.minecraft } }
    }
  }
  let index: Record<string, Record<string, unknown>>
  try { index = JSON.parse(readFileSync(resolution.file, 'utf8')) as Record<string, Record<string, unknown>> } catch { return { ok: false, code: 'ASSET_INVALID', assetReady: false, error: 'minecraft-data index is invalid; prepare the asset again', remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['minecraft-data'] } } } }
  const plural = kind === 'block' ? 'blocks' : kind === 'item' ? 'items' : kind === 'entity' ? 'entities' : kind === 'enchantment' ? 'enchantments' : 'recipes'; const byId = index[`${plural}ById`] || {}; const normalized = query.startsWith('minecraft:') ? query : `minecraft:${query}`; const direct = byId[normalized] || byId[query]; if (direct) return { ok: true, kind, result: direct, dataVersion: resolution.minecraft, exact: resolution.exact }; const aliases = [index[`${plural}ByEnName`] || {}, index[`${plural}ByZhName`] || {}]; for (const map of aliases) { const hit = map[query.toLowerCase()] || map[query]; if (typeof hit === 'string' && byId[hit]) return { ok: true, kind, result: byId[hit], dataVersion: resolution.minecraft, exact: resolution.exact } }; return { ok: false, kind, query, dataVersion: resolution.minecraft, exact: resolution.exact, error: `no ${kind} found for ${query}` }
}
export function searchFabricDocs(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> {
  const legacy = path.join(paths.knowledgeRoot, 'agent-knowledge', 'fabric')
  const root = existsSync(legacy) ? legacy : path.join(paths.assetsRoot, 'agent-knowledge', 'fabric')
  if (!existsSync(root)) return { ok: false, code: 'ASSET_NOT_READY', assetReady: false, query, hits: [], error: 'Fabric documentation is not downloaded; run modcrafting_prepare_assets with names ["agent-knowledge"]', remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['agent-knowledge'] } } }
  const needle = query.trim().toLowerCase()
  const terms = [...new Set(needle.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))]
  const ranked: Array<{ path: string; snippet: string; score: number; matchedTerms: string[] }> = []
  let searchedFiles = 0
  const count = (text: string, term: string) => { let total = 0, at = 0; while ((at = text.indexOf(term, at)) >= 0) { total++; at += term.length } return total }
  const walk = (directory: string) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      if (!entry.name.endsWith('.md')) continue
      searchedFiles++
      const content = readFileSync(file, 'utf8'), lower = content.toLowerCase()
      const matchedTerms = terms.filter((term) => lower.includes(term))
      const exact = Boolean(needle) && lower.includes(needle)
      if (!exact && !matchedTerms.length) continue
      const relative = path.relative(root, file).replace(/\\/g, '/')
      const score = (exact ? 100 : 0) + matchedTerms.length * 10 + matchedTerms.reduce((sum, term) => sum + Math.min(10, count(lower, term)), 0) + (matchedTerms.some((term) => relative.toLowerCase().includes(term)) ? 5 : 0)
      const anchor = exact ? lower.indexOf(needle) : lower.indexOf(matchedTerms[0])
      ranked.push({ path: relative, snippet: content.slice(Math.max(0, anchor - 180), anchor + 520), score, matchedTerms })
    }
  }
  walk(root)
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { ok: true, query, hits: ranked.slice(0, limit), assetReady: true, searchedFiles, terms, ...(ranked.length ? {} : { reason: '没有文档包含这些词；改用更短的英文/中文术语，或先准备 agent-knowledge。' }) }
}
export function searchWiki(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> {
  const file = path.join(paths.knowledgeRoot, 'mc-wiki-zh-index', 'chunks.json')
  if (!existsSync(file)) return { ok: false, code: 'ASSET_NOT_READY', assetReady: false, query, hits: [], error: `wiki index unavailable under ${paths.knowledgeRoot}; run modcrafting_prepare_assets with names ["mc-wiki-zh-index"]`, remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['mc-wiki-zh-index'] } } }
  let chunks: Record<string, unknown>[]
  try { chunks = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[] } catch { return { ok: false, code: 'ASSET_INVALID', assetReady: false, query, hits: [], error: 'wiki index is invalid; prepare the asset again', remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['mc-wiki-zh-index'] } } } }
  if (!Array.isArray(chunks)) return { ok: false, code: 'ASSET_INVALID', assetReady: false, query, hits: [], error: 'wiki index is invalid; prepare the asset again', remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['mc-wiki-zh-index'] } } }
  const needle = query.toLowerCase(); const hits = chunks.filter((item) => `${item.title || ''}\n${item.text || ''}`.toLowerCase().includes(needle)).slice(0, limit).map((item) => ({ title: item.title, category: item.category, standardId: item.standardId, snippet: String(item.text || '').slice(0, 700) })); return { ok: true, query, hits }
}

interface Job {
  id: string; kind: string; sessionId?: string; status: 'running' | 'completed' | 'failed' | 'stopped'; startedAt: string; finishedAt?: string
  output: string[]; child?: ChildProcess; result?: Record<string, unknown>; error?: string
}
function stopOwnedChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    // cmd launches Java descendants; terminate only this plugin-owned PID tree.
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => child.kill())
    killer.once('close', (code) => { if (code !== 0 && child.exitCode === null) child.kill() })
  } else child.kill()
}
export class JobManager {
  private jobs = new Map<string, Job>()
  private sequence = 0
  start(kind: string, work: (job: { output: string[]; setChild: (child: ChildProcess) => void; cancelled: () => boolean }) => Promise<Record<string, unknown>>, sessionId?: string): string {
    const id = `mc_${kind}_${Date.now().toString(36)}_${++this.sequence}`
    const job: Job = { id, kind, sessionId, status: 'running', startedAt: new Date().toISOString(), output: [] }
    this.jobs.set(id, job)
    void work({ output: job.output, setChild: (child) => { job.child = child; if (job.status === 'stopped') stopOwnedChild(child) }, cancelled: () => job.status === 'stopped' })
      .then((result) => { job.result = result; if (job.status !== 'stopped') job.status = 'completed'; job.finishedAt = new Date().toISOString() })
      .catch((error) => { if (job.status !== 'stopped') job.status = 'failed'; job.error = String(error); Object.assign(job, { code: typeof error?.code === 'string' ? error.code : 'JOB_FAILED' }); job.finishedAt = new Date().toISOString() })
    return id
  }
  status(id: string, sessionId?: string): Record<string, unknown> {
    const job = this.jobs.get(id)
    if (!job) return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found' }
    if (sessionId && job.sessionId !== sessionId) return { ok: false, code: 'JOB_NOT_OWNED', error: 'job belongs to another session' }
    const { child, ...state } = job
    return { ...structuredClone(state), output: job.output.slice(-300), pid: child?.pid }
  }
  stop(id: string, sessionId?: string): Record<string, unknown> { const job = this.jobs.get(id); if (!job) return { ok: false, code: 'JOB_NOT_FOUND', error: 'job not found' }; if (sessionId && job.sessionId !== sessionId) return { ok: false, code: 'JOB_NOT_OWNED', error: 'job belongs to another session' }; if (job.status === 'running') { if (job.child) stopOwnedChild(job.child); job.status = 'stopped'; job.finishedAt = new Date().toISOString() }; return { ok: true, id } }
  list(sessionId?: string): Record<string, unknown>[] { return [...this.jobs.values()].filter((job) => !sessionId || job.sessionId === sessionId).map((job) => this.status(job.id, sessionId)) }
  stopAll(): void { for (const id of this.jobs.keys()) this.stop(id) }
}

export async function writeGameTestReport(paths: RuntimePaths, id: string, payload: Record<string, unknown>, sessionId?: string): Promise<string> { ensureRuntimePaths(paths); const root = sessionId ? path.join(paths.reportsRoot, sessionId) : paths.reportsRoot; await mkdir(root, { recursive: true }); const target = path.join(root, `${id}.json`); await writeFile(target, JSON.stringify(payload, null, 2), 'utf8'); return target }
export function testVerdict(rows: Array<{ passed: boolean; unavailable?: boolean }>, visualOnly = false): GameTestVerdict { return acceptanceVerdict(rows, { visualOnly }) }
