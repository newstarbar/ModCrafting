import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { FABRIC_TARGET, GAME_TEST_WORLD, isAllowedBridgeApiPath, type GameTestVerdict } from './domain.ts'

export interface RuntimePaths { dataRoot: string; knowledgeRoot: string; assetsRoot: string; reportsRoot: string; logsRoot: string }
export interface RuntimeEvents { onLog?: (scope: string, line: string) => void; onState?: (scope: string, state: Record<string, unknown>) => void }
export interface EnvironmentStatus { ok: boolean; platform: string; node: string; java: { ok: boolean; version?: string; path?: string; error?: string }; gradleWrapper: boolean; target: typeof FABRIC_TARGET; remediation: string[] }
export interface FabricProject { path: string; valid: boolean; modId?: string; minecraftVersion?: string; wrapperPath?: string; errors: string[] }
export interface BridgeDiscovery { port: number; token?: string; apiVersions?: number[]; modVersion?: string }

export function createRuntimePaths(dataRoot: string): RuntimePaths {
  const root = path.resolve(dataRoot)
  return { dataRoot: root, knowledgeRoot: path.join(root, 'knowledge'), assetsRoot: path.join(root, 'assets'), reportsRoot: path.join(root, 'reports'), logsRoot: path.join(root, 'logs') }
}

export function ensureRuntimePaths(paths: RuntimePaths): void { for (const value of Object.values(paths)) mkdirSync(value, { recursive: true }) }

function execCapture(command: string, args: string[], cwd?: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false })
    let output = ''
    child.stdout.on('data', (value) => { output += String(value) })
    child.stderr.on('data', (value) => { output += String(value) })
    child.on('error', (error) => resolve({ code: -1, output: String(error) }))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

export class SystemToolchainProvider {
  async status(projectPath?: string): Promise<EnvironmentStatus> {
    const java = await execCapture('java', ['-version'])
    const match = java.output.match(/version\s+"([^"]+)"/)
    const javaOk = java.code === 0 && Boolean(match?.[1]?.startsWith('21.'))
    const project = projectPath ? inspectFabricProject(projectPath) : undefined
    const wrapper = Boolean(project?.wrapperPath)
    return { ok: javaOk && (!projectPath || wrapper), platform: process.platform, node: process.version, java: { ok: javaOk, version: match?.[1], error: javaOk ? undefined : 'JDK 21 is required on PATH' }, gradleWrapper: wrapper, target: FABRIC_TARGET, remediation: [ ...(javaOk ? [] : ['Install a JDK 21 and make java available on PATH.']), ...(projectPath && !wrapper ? ['Use a Fabric project that contains gradlew.bat.'] : []) ] }
  }
  async startGradle(projectPath: string, task: string, events?: RuntimeEvents, extraArgs: string[] = []): Promise<ChildProcess> {
    const project = inspectFabricProject(projectPath)
    if (!project.wrapperPath) throw new Error('gradlew.bat is required; this plugin never downloads Gradle')
    const status = await this.status(projectPath)
    if (!status.java.ok) throw new Error(status.java.error)
    const child = spawn(project.wrapperPath, [task, '--no-daemon', ...extraArgs], { cwd: project.path, windowsHide: true, shell: false, env: { ...process.env, JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS || '' } })
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
  try { modId = JSON.parse(readFileSync(modJson, 'utf8')).id } catch { if (existsSync(modJson)) errors.push('fabric.mod.json is invalid JSON') }
  if (!existsSync(wrapper)) errors.push('missing gradlew.bat')
  let minecraftVersion: string | undefined
  try { const gradle = readFileSync(path.join(root, 'gradle.properties'), 'utf8'); minecraftVersion = gradle.match(/^minecraft_version=(.+)$/m)?.[1]?.trim() } catch { /* optional */ }
  return { path: root, valid: errors.length === 0, modId, minecraftVersion, wrapperPath: existsSync(wrapper) ? wrapper : undefined, errors }
}

export function validateFabricProject(projectPath: string): { ok: boolean; project: FabricProject; checks: Record<string, boolean> } {
  const project = inspectFabricProject(projectPath)
  const checks = { fabricModJson: Boolean(project.modId), wrapper: Boolean(project.wrapperPath), minecraft1214: !project.minecraftVersion || project.minecraftVersion === FABRIC_TARGET.minecraft }
  return { ok: project.valid && checks.minecraft1214, project, checks }
}

export async function scaffoldFabricProject(projectPath: string, modId: string, modName: string): Promise<FabricProject> {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(modId)) throw new Error('modId must be lower-case and use [a-z0-9_-]')
  const root = path.resolve(projectPath)
  if (existsSync(root) && (await readdir(root)).length > 0) throw new Error('refusing to scaffold into a non-empty directory')
  await mkdir(path.join(root, 'src', 'main', 'resources'), { recursive: true })
  await writeFile(path.join(root, 'settings.gradle'), `pluginManagement { repositories { maven { url = 'https://maven.fabricmc.net/' }; gradlePluginPortal(); mavenCentral() } }\nrootProject.name = '${modId}'\n`, 'utf8')
  await writeFile(path.join(root, 'gradle.properties'), `minecraft_version=${FABRIC_TARGET.minecraft}\nyarn_mappings=${FABRIC_TARGET.yarn}\nloader_version=${FABRIC_TARGET.loader}\nfabric_version=${FABRIC_TARGET.fabricApi}\n`, 'utf8')
  await writeFile(path.join(root, 'build.gradle'), `plugins { id 'fabric-loom' version '${FABRIC_TARGET.loom}'; id 'maven-publish' }\nversion = '0.1.0'\ngroup = '${modId}'\nbase { archivesName = '${modId}' }\nrepositories { mavenCentral() }\ndependencies { minecraft "com.mojang:minecraft:${FABRIC_TARGET.minecraft}"; mappings "net.fabricmc:yarn:${FABRIC_TARGET.yarn}:v2"; modImplementation "net.fabricmc:fabric-loader:${FABRIC_TARGET.loader}"; modImplementation "net.fabricmc.fabric-api:fabric-api:${FABRIC_TARGET.fabricApi}" }\n`, 'utf8')
  await writeFile(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: modId, version: '${version}', name: modName, environment: '*', entrypoints: { main: [] }, depends: { fabricloader: `>=${FABRIC_TARGET.loader}`, minecraft: `~${FABRIC_TARGET.minecraft}`, 'fabric-api': '*' } }, null, 2), 'utf8')
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
export async function prepareAssets(paths: RuntimePaths): Promise<AssetResult[]> {
  ensureRuntimePaths(paths); const results: AssetResult[] = []
  const plans = [{ repo: 'newstarbar/ModCrafting-knowledge-base', prefix: `knowledge-${FABRIC_TARGET.minecraft}-`, names: ['minecraft-data.zip', 'mc-wiki-zh.zip', 'mc-wiki-zh-index.zip'], kind: 'knowledge' }, { repo: 'newstarbar/ModCrafting', names: ['base-mods.zip', 'agent-knowledge.zip'], kind: 'assets' }]
  for (const plan of plans) try { const release = await githubRelease(plan.repo, plan.prefix); const assets = Array.isArray(release.assets) ? release.assets as Record<string, unknown>[] : []; for (const name of plan.names) { const asset = assets.find((item) => item.name === name); if (!asset || typeof asset.browser_download_url !== 'string') { results.push({ name, ok: false, error: 'release asset missing' }); continue }; const archive = path.join(paths.dataRoot, 'downloads', name); const destination = path.join(plan.kind === 'knowledge' ? paths.knowledgeRoot : paths.assetsRoot, name.replace(/\.zip$/i, '')); try { await download(proxy(asset.browser_download_url), archive) } catch { await download(asset.browser_download_url, archive) }; await extractZip(archive, destination); const nested = path.join(destination, destination.endsWith('base-mods') ? '_base_mods' : path.basename(destination)); if (existsSync(nested)) { for (const entry of readdirSync(nested)) renameSync(path.join(nested, entry), path.join(destination, entry)); await rm(nested, { recursive: true, force: true }) }; results.push({ name, ok: true, path: destination }) } } catch (error) { results.push({ name: plan.repo, ok: false, error: String(error) }) }
  return results
}

export function lookupMinecraftData(paths: RuntimePaths, kind: 'block' | 'item' | 'entity' | 'enchantment' | 'recipe', query: string): Record<string, unknown> {
  const file = path.join(paths.knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft, 'index.json'); if (!existsSync(file)) return { ok: false, error: 'minecraft-data unavailable; run modcrafting_prepare_assets' }
  const index = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>; const plural = kind === 'block' ? 'blocks' : kind === 'item' ? 'items' : kind === 'entity' ? 'entities' : kind === 'enchantment' ? 'enchantments' : 'recipes'; const byId = index[`${plural}ById`] || {}; const normalized = query.startsWith('minecraft:') ? query : `minecraft:${query}`; const direct = byId[normalized] || byId[query]; if (direct) return { ok: true, kind, result: direct }; const aliases = [index[`${plural}ByEnName`] || {}, index[`${plural}ByZhName`] || {}]; for (const map of aliases) { const hit = map[query.toLowerCase()] || map[query]; if (typeof hit === 'string' && byId[hit]) return { ok: true, kind, result: byId[hit] } }; return { ok: false, error: `no ${kind} found for ${query}` }
}
export function searchFabricDocs(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> { const root = path.join(paths.knowledgeRoot, 'agent-knowledge', 'fabric'); const hits: Array<Record<string, string>> = []; const needle = query.toLowerCase(); const walk = (directory: string) => { if (!existsSync(directory) || hits.length >= limit) return; for (const entry of readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.md')) { const content = readFileSync(file, 'utf8'); const position = content.toLowerCase().indexOf(needle); if (position >= 0) hits.push({ path: path.relative(root, file).replace(/\\/g, '/'), snippet: content.slice(Math.max(0, position - 180), position + 500) }) } } }; walk(root); return { ok: true, query, hits, assetReady: existsSync(root) } }
export function searchWiki(paths: RuntimePaths, query: string, limit = 8): Record<string, unknown> { const file = path.join(paths.knowledgeRoot, 'mc-wiki-zh-index', 'chunks.json'); if (!existsSync(file)) return { ok: false, error: 'wiki index unavailable; run modcrafting_prepare_assets' }; const needle = query.toLowerCase(); const chunks = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[]; const hits = chunks.filter((item) => `${item.title || ''}\n${item.text || ''}`.toLowerCase().includes(needle)).slice(0, limit).map((item) => ({ title: item.title, category: item.category, standardId: item.standardId, snippet: String(item.text || '').slice(0, 700) })); return { ok: true, query, hits } }

export class JobManager {
  private jobs = new Map<string, { id: string; kind: string; status: 'running' | 'completed' | 'failed' | 'stopped'; startedAt: string; finishedAt?: string; output: string[]; child?: ChildProcess; result?: Record<string, unknown>; error?: string }>(); private sequence = 0
  start(kind: string, work: (job: { output: string[]; setChild: (child: ChildProcess) => void }) => Promise<Record<string, unknown>>): string { const id = `mc_${kind}_${Date.now().toString(36)}_${++this.sequence}`; const job = { id, kind, status: 'running' as const, startedAt: new Date().toISOString(), output: [] as string[] }; this.jobs.set(id, job); void work({ output: job.output, setChild: (child) => { job.child = child } }).then((result) => Object.assign(job, { status: 'completed' as const, finishedAt: new Date().toISOString(), result })).catch((error) => Object.assign(job, { status: 'failed' as const, finishedAt: new Date().toISOString(), error: String(error) })); return id }
  status(id: string): Record<string, unknown> { const job = this.jobs.get(id); return job ? { ...job, output: job.output.slice(-300), pid: job.child?.pid } : { ok: false, error: 'job not found' } }
  stop(id: string): Record<string, unknown> { const job = this.jobs.get(id); if (!job) return { ok: false, error: 'job not found' }; if (job.child && !job.child.killed) job.child.kill(); job.status = 'stopped'; job.finishedAt = new Date().toISOString(); return { ok: true, id } }
  stopAll(): void { for (const id of this.jobs.keys()) this.stop(id) }
}

export async function writeGameTestReport(paths: RuntimePaths, id: string, payload: Record<string, unknown>): Promise<string> { ensureRuntimePaths(paths); const target = path.join(paths.reportsRoot, `${id}.json`); await writeFile(target, JSON.stringify(payload, null, 2), 'utf8'); return target }
export function testVerdict(rows: Array<{ passed: boolean; unavailable?: boolean }>, visualOnly = false): GameTestVerdict { if (visualOnly || rows.some((row) => row.unavailable)) return 'INCONCLUSIVE'; return rows.length && rows.every((row) => row.passed) ? 'PASS' : 'FAIL' }
