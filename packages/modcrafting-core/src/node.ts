import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { FABRIC_TARGET, GAME_TEST_WORLD, isAllowedBridgeApiPath, type GameTestVerdict } from './domain.ts'
import { acceptanceVerdict } from './acceptance.ts'
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
  private cachedJava?: { key: string; value: JavaStatus; at: number }
  constructor(dataRoot?: string) { this.dataRoot = dataRoot }

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
    const remediation: string[] = []
    if (!java.ok) {
      remediation.push('安装或选择 JDK 21（必须包含 javac）。')
      remediation.push('调用 modcrafting_toolchain（action="write", javaHome="C:\\\\path\\\\to\\\\jdk-21"）可立即切换工具链，无需重启 Qoder。')
      remediation.push('也可以设置 MODCRAFTING_JAVA_HOME；修改系统 JAVA_HOME 后必须完全退出并重启 Qoder，仅重新连接 MCP 不会刷新宿主环境变量。')
    }
    if (projectPath && !wrapper) remediation.push('当前文件夹还不是完整模组工程；新建工程或选择已有工程。')
    return {
      ok: java.ok && (!projectPath || wrapper), platform: process.platform, node: process.version, java,
      gradleWrapper: wrapper, target: FABRIC_TARGET, remediation,
      storage: { gradleUserHome: process.env.GRADLE_USER_HOME || (this.dataRoot ? path.join(this.dataRoot, 'cache', 'gradle') : undefined), temporaryDirectory: this.dataRoot ? path.join(this.dataRoot, 'cache', 'tmp') : undefined }
    }
  }
  async startGradle(projectPath: string, task: string, events?: RuntimeEvents, extraArgs: string[] = []): Promise<ChildProcess> {
    const project = inspectFabricProject(projectPath)
    if (!project.wrapperPath) throw Object.assign(new Error('gradlew.bat is required; this plugin never downloads Gradle'), { code: 'ENVIRONMENT_UNAVAILABLE' })
    const status = await this.status(projectPath)
    if (!status.java.ok) throw Object.assign(new Error(status.java.error), { code: 'ENVIRONMENT_UNAVAILABLE' })
    if (!/^[A-Za-z][A-Za-z0-9:.-]*$/.test(task) || extraArgs.some((value) => /[%!&|<>^\r\n]/.test(value))) throw Object.assign(new Error('Unsafe Gradle task arguments'), { code: 'INVALID_ARGUMENT' })
    const storage = status.storage
    for (const directory of [storage?.gradleUserHome, storage?.temporaryDirectory]) if (directory) mkdirSync(directory, { recursive: true })
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : project.wrapperPath, process.platform === 'win32' ? ['/d', '/v:off', '/s', '/c', '.\\gradlew.bat', task, '--no-daemon', ...extraArgs] : [task, '--no-daemon', ...extraArgs], { cwd: project.path, windowsHide: true, shell: false, env: { ...process.env, JAVA_HOME: status.java.path, JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS || '', ...(storage?.gradleUserHome ? { GRADLE_USER_HOME: storage.gradleUserHome } : {}), ...(storage?.temporaryDirectory ? { TEMP: storage.temporaryDirectory, TMP: storage.temporaryDirectory } : {}) } })
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
  const wrapper = path.join(root, 'gradlew.bat')
  if (!existsSync(modJson)) errors.push('missing src/main/resources/fabric.mod.json')
  let modId: string | undefined
  try { const metadata = JSON.parse(readFileSync(modJson, 'utf8')); if (typeof metadata.id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(metadata.id)) errors.push('fabric.mod.json requires a valid mod id'); else modId = metadata.id } catch { if (existsSync(modJson)) errors.push('fabric.mod.json is invalid JSON') }
  if (!existsSync(wrapper)) errors.push('missing gradlew.bat')
  let minecraftVersion: string | undefined
  try { const gradle = readFileSync(path.join(root, 'gradle.properties'), 'utf8'); minecraftVersion = gradle.match(/^minecraft_version=(.+)$/m)?.[1]?.trim() } catch { /* optional */ }
  return { path: root, valid: errors.length === 0, modId, minecraftVersion, wrapperPath: existsSync(wrapper) ? wrapper : undefined, errors }
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
function validateResourceReferences(root: string, resources: string, modId: string, diagnostics: ProjectDiagnostic[]): void {
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
    if (typeof parent === 'string' && !parent.startsWith('builtin/') && !modelExists(parent)) add('error', 'MISSING_MODEL', file, `parent 引用的模型不存在（1.21.4 模型路径区分大小写）：${parent}`)
    const textures = parsed.value.textures
    if (textures && typeof textures === 'object' && !Array.isArray(textures)) {
      for (const [key, value] of Object.entries(textures as Record<string, unknown>)) {
        if (typeof value === 'string' && !value.startsWith('#') && !textureExists(value)) add('error', 'MISSING_TEXTURE', file, `纹理 "${key}" 引用的图片不存在：${value}（应为 assets/${modId}/textures/${localReference(value, modId)?.resource || value}.png）`)
      }
    }
    const relative = relativeResourcePath(modelsRoot, file)
    if (relative.startsWith('item/')) {
      const itemPath = relative.slice('item/'.length).replace(/\.json$/, '')
      const definition = path.join(assets, 'items', ...itemPath.split('/')) + '.json'
      if (!existsSync(definition)) add('error', 'MISSING_ITEM_MODEL_DEFINITION', file, `1.21.4 需要 assets/${modId}/items/${itemPath}.json 指向这个物品模型；只有 models/item 文件时物品会显示紫黑占位。`)
    }
  }
  for (const file of jsonFilesUnder(path.join(assets, 'items'))) {
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
  const recipes = path.join(resources, 'data', modId, 'recipe')
  for (const file of jsonFilesUnder(recipes)) {
    const parsed = parseJsonObject(file)
    if ('error' in parsed) add('error', 'INVALID_JSON', file, `配方 JSON 无法解析：${parsed.error}`)
    else if (typeof parsed.value.type !== 'string') add('error', 'INVALID_RECIPE', file, '配方缺少字符串 type；1.21.4 不会加载这个文件。')
  }
  const legacyRecipes = path.join(resources, 'data', modId, 'recipes')
  if (existsSync(legacyRecipes)) add('warning', 'LEGACY_RECIPE_DIRECTORY', legacyRecipes, '1.21.4 使用单数 recipe 目录；recipes 目录中的配方不会被加载。')
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

export function validateFabricProject(projectPath: string): { ok: boolean; project: FabricProject; checks: Record<string, boolean>; diagnostics: ProjectDiagnostic[] } {
  const project = inspectFabricProject(projectPath)
  const diagnostics: ProjectDiagnostic[] = []
  const resources = path.join(project.path, 'src', 'main', 'resources')
  if (!project.minecraftVersion) diagnostics.push({ level: 'error', code: 'MINECRAFT_VERSION_MISSING', path: 'gradle.properties', message: '缺少 minecraft_version；目标固定为 1.21.4。' })
  else if (project.minecraftVersion !== FABRIC_TARGET.minecraft) diagnostics.push({ level: 'error', code: 'MINECRAFT_VERSION_MISMATCH', path: 'gradle.properties', message: `当前 minecraft_version=${project.minecraftVersion}，本插件只构建 1.21.4。` })
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
    if (project.modId) validateResourceReferences(project.path, resources, project.modId, diagnostics)
    validateMixinConfiguration(project.path, resources, metadata, diagnostics)
  }
  const checks = {
    fabricModJson: Boolean(project.modId),
    wrapper: Boolean(project.wrapperPath),
    minecraft1214: project.minecraftVersion === FABRIC_TARGET.minecraft,
    resourceReferences: !diagnostics.some((diagnostic) => diagnostic.level === 'error')
  }
  return { ok: project.valid && Object.values(checks).every(Boolean), project, checks, diagnostics }
}

export interface ProjectWrapper { batch: string; properties: string; jarBase64: string }
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
export async function prepareAssets(paths: RuntimePaths, names?: DownloadableAsset[]): Promise<AssetResult[]> {
  // Only the directories this function writes; avoid scaffolding unrelated roots (e.g. logs/reports inside a project workspace).
  for (const directory of [paths.knowledgeRoot, paths.assetsRoot]) mkdirSync(directory, { recursive: true })
  const results: AssetResult[] = []
  const plans = [{ repo: 'newstarbar/ModCrafting-knowledge-base', prefix: `knowledge-${FABRIC_TARGET.minecraft}-`, names: ['minecraft-data.zip', 'mc-wiki-zh.zip', 'mc-wiki-zh-index.zip'], kind: 'knowledge' }, { repo: 'newstarbar/ModCrafting', names: ['agent-knowledge.zip'], kind: 'assets' }]
  for (const plan of plans) {
    const selected = plan.names.filter(name => !names || names.includes(name.replace(/\.zip$/, '') as DownloadableAsset))
    if (!selected.length) continue
    let assets: Record<string, unknown>[]
    try { const release = await githubRelease(plan.repo, plan.prefix); assets = Array.isArray(release.assets) ? release.assets as Record<string, unknown>[] : [] }
    catch (error) { for (const name of selected) results.push({ name, ok: false, error: String(error) }); continue }
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

export function lookupMinecraftData(paths: RuntimePaths, kind: 'block' | 'item' | 'entity' | 'enchantment' | 'recipe', query: string): Record<string, unknown> {
  const file = path.join(paths.knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft, 'index.json')
  if (!existsSync(file)) return { ok: false, code: 'ASSET_NOT_READY', assetReady: false, error: `minecraft-data unavailable under ${paths.knowledgeRoot}; run modcrafting_prepare_assets with names ["minecraft-data"]`, remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['minecraft-data'] } } }
  let index: Record<string, Record<string, unknown>>
  try { index = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>> } catch { return { ok: false, code: 'ASSET_INVALID', assetReady: false, error: 'minecraft-data index is invalid; prepare the asset again', remediation: { tool: 'modcrafting_prepare_assets', arguments: { names: ['minecraft-data'] } } } }
  const plural = kind === 'block' ? 'blocks' : kind === 'item' ? 'items' : kind === 'entity' ? 'entities' : kind === 'enchantment' ? 'enchantments' : 'recipes'; const byId = index[`${plural}ById`] || {}; const normalized = query.startsWith('minecraft:') ? query : `minecraft:${query}`; const direct = byId[normalized] || byId[query]; if (direct) return { ok: true, kind, result: direct }; const aliases = [index[`${plural}ByEnName`] || {}, index[`${plural}ByZhName`] || {}]; for (const map of aliases) { const hit = map[query.toLowerCase()] || map[query]; if (typeof hit === 'string' && byId[hit]) return { ok: true, kind, result: byId[hit] } }; return { ok: false, kind, query, error: `no ${kind} found for ${query}` }
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
