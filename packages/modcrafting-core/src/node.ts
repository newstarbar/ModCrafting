import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { FABRIC_TARGET, GAME_TEST_WORLD, isAllowedBridgeApiPath, type GameTestVerdict } from './domain.ts'
import { acceptanceVerdict } from './acceptance.ts'
import type { RuntimePaths, RuntimeEvents, EnvironmentStatus, FabricProject } from './contracts.ts'
export type { RuntimePaths, RuntimeEvents, EnvironmentStatus, FabricProject } from './contracts.ts'

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

export class SystemToolchainProvider {
  private readonly dataRoot?: string
  constructor(dataRoot?: string) { this.dataRoot = dataRoot }
  async status(projectPath?: string): Promise<EnvironmentStatus> {
    const executable = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    const java = await execCapture(executable, ['-XshowSettings:properties', '-version'], undefined, 3000)
    const match = java.output.match(/version\s+"([^"]+)"/)
    const javaHome = java.output.match(/^\s*java.home\s*=\s*(.+)$/m)?.[1]?.trim()
    const javaOk = java.code === 0 && Boolean(match?.[1]?.startsWith('21.')) && Boolean(javaHome && existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')))
    const project = projectPath ? inspectFabricProject(projectPath) : undefined
    const wrapper = Boolean(project?.wrapperPath)
    return { ok: javaOk && (!projectPath || wrapper), platform: process.platform, node: process.version, java: { ok: javaOk, version: match?.[1], path: javaHome, error: javaOk ? undefined : '需要 JDK 21（含编译器）。请检查 JAVA_HOME；未设置时使用 PATH 中的 Java。' }, gradleWrapper: wrapper, target: FABRIC_TARGET, remediation: [ ...(javaOk ? [] : ['安装或选择 JDK 21，然后重新连接插件。']), ...(projectPath && !wrapper ? ['当前文件夹还不是完整模组工程；新建工程或选择已有工程。'] : []) ], storage: { gradleUserHome: process.env.GRADLE_USER_HOME || (this.dataRoot ? path.join(this.dataRoot, 'cache', 'gradle') : undefined), temporaryDirectory: this.dataRoot ? path.join(this.dataRoot, 'cache', 'tmp') : undefined } }
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

export function validateFabricProject(projectPath: string): { ok: boolean; project: FabricProject; checks: Record<string, boolean> } {
  const project = inspectFabricProject(projectPath)
  const checks = { fabricModJson: Boolean(project.modId), wrapper: Boolean(project.wrapperPath), minecraft1214: !project.minecraftVersion || project.minecraftVersion === FABRIC_TARGET.minecraft }
  return { ok: project.valid && Object.values(checks).every(Boolean), project, checks }
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
  const result = await execCapture('tar', ['-xf', archive, '-C', staging])
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
  const file = path.join(paths.knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft, 'index.json'); if (!existsSync(file)) return { ok: false, error: `minecraft-data unavailable under ${paths.knowledgeRoot}; run modcrafting_prepare_assets` }
  const index = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>; const plural = kind === 'block' ? 'blocks' : kind === 'item' ? 'items' : kind === 'entity' ? 'entities' : kind === 'enchantment' ? 'enchantments' : 'recipes'; const byId = index[`${plural}ById`] || {}; const normalized = query.startsWith('minecraft:') ? query : `minecraft:${query}`; const direct = byId[normalized] || byId[query]; if (direct) return { ok: true, kind, result: direct }; const aliases = [index[`${plural}ByEnName`] || {}, index[`${plural}ByZhName`] || {}]; for (const map of aliases) { const hit = map[query.toLowerCase()] || map[query]; if (typeof hit === 'string' && byId[hit]) return { ok: true, kind, result: byId[hit] } }; return { ok: false, error: `no ${kind} found for ${query}` }
}
export function searchFabricDocs(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> { const legacy = path.join(paths.knowledgeRoot, 'agent-knowledge', 'fabric'); const root = existsSync(legacy) ? legacy : path.join(paths.assetsRoot, 'agent-knowledge', 'fabric'); const hits: Array<Record<string, string>> = []; const needle = query.toLowerCase(); const walk = (directory: string) => { if (!existsSync(directory) || hits.length >= limit) return; for (const entry of readdirSync(directory, { withFileTypes: true })) { if (hits.length >= limit) break; const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.md')) { const content = readFileSync(file, 'utf8'); const position = content.toLowerCase().indexOf(needle); if (position >= 0) hits.push({ path: path.relative(root, file).replace(/\\/g, '/'), snippet: content.slice(Math.max(0, position - 180), position + 500) }) } } }; walk(root); return { ok: true, query, hits, assetReady: existsSync(root) } }
export function searchWiki(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> { const file = path.join(paths.knowledgeRoot, 'mc-wiki-zh-index', 'chunks.json'); if (!existsSync(file)) return { ok: false, error: `wiki index unavailable under ${paths.knowledgeRoot}; run modcrafting_prepare_assets` }; const needle = query.toLowerCase(); const chunks = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[]; const hits = chunks.filter((item) => `${item.title || ''}\n${item.text || ''}`.toLowerCase().includes(needle)).slice(0, limit).map((item) => ({ title: item.title, category: item.category, standardId: item.standardId, snippet: String(item.text || '').slice(0, 700) })); return { ok: true, query, hits } }

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
