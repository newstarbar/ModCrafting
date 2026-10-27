import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, statSync, lstatSync, copyFileSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { DEFAULT_TEST_PROFILE, FABRIC_TARGET, GAME_TEST_WORLD, testProfileSchema, validateGameTestSpec, type GameAction, type GameTestSpec, type TestProfile } from './domain.ts'
import { executeGameTest, SUPPORTED_GAME_ASSERTIONS } from './game-test.ts'
import { JobManager, SystemToolchainProvider, bridgeRequest, createRuntimePaths, discoveryPath, portIsListening, readBridgeDiscovery, prepareAssets, writeGameTestReport, type BridgeDiscovery, type DownloadableAsset } from './node.ts'
import { assertBuildId, prepareStudioInbox, readStudioDiscovery, readStudioOutbox, studioRequest, StudioError, type StudioDiscovery, type StudioOutbox, type StudioResult } from './building-studio.ts'
import type { RuntimePaths, CoreEnvironmentStatus, CoreCapabilities, LocalAssetStatus, GameInstance, GameRuntimeStatus, JobSnapshot, CoreFailure, BridgeResult, CoreRuntimeState, JavaCandidate, JavaStatus } from './contracts.ts'
import { SessionRegistry } from './sessions.ts'

export class CoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'CoreError'; this.code = code }
}
export const CORE_CAPABILITIES: CoreCapabilities = {
  contractVersion: 1, supportedAssertions: SUPPORTED_GAME_ASSERTIONS,
  unsupportedAssertions: ['hud_text', 'command_result', 'entity_exists:tag', 'trace_source'],
  entityQuery: { radius: 32, limit: 64, tagFilters: false },
  toolchain: { source: 'system', automaticDownload: false, scaffoldIncludesWrapper: false }
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : []
  })
}
export type SnapshotOptions = {
  radius?: number
  includeRecipes?: boolean
  includeTraces?: boolean
  traceLimit?: number
  includeBlocks?: boolean
  entityLimit?: number
  recipeLimit?: number
  full?: boolean
}
function stripItemFingerprints(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) stripItemFingerprints(item); return }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  delete record.componentFingerprint
  for (const item of Object.values(record)) stripItemFingerprints(item)
}
export function compactSnapshot(result: BridgeResult, options: SnapshotOptions): BridgeResult {
  if (!result.ok || options.full || !result.data || typeof result.data !== 'object') return result
  const data = { ...result.data }
  const omitted: Record<string, number> = {}
  const trim = (key: string, limit: number, fromEnd = false) => {
    const value = data[key]
    if (!Array.isArray(value)) return
    if (limit <= 0) { if (value.length) omitted[key] = value.length; data[key] = []; return }
    if (value.length <= limit) return
    omitted[key] = value.length - limit
    data[key] = fromEnd ? value.slice(value.length - limit) : value.slice(0, limit)
  }
  trim('entities', options.entityLimit ?? 16)
  trim('recipes', options.includeRecipes ? options.recipeLimit ?? 100 : 0)
  for (const key of ['hudTrace', 'renderTrace', 'combatTrace']) trim(key, options.includeTraces ? options.traceLimit ?? 20 : 0, true)
  if (!options.includeBlocks) { if (Array.isArray(data.blocks) && data.blocks.length) omitted.blocks = data.blocks.length; delete data.blocks }
  for (const key of ['player', 'serverPlayer', 'inventory', 'containerSlots', 'cursorStack', 'screen']) if (data[key]) stripItemFingerprints(data[key])
  data.compact = true
  data.omitted = omitted
  return { ...result, data }
}
function pidIsAlive(pid?: number): boolean {
  if (!Number.isInteger(pid) || !pid) return false
  try { process.kill(pid, 0); return true } catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM' }
}
function acquireFileLease(file: string, metadata: Record<string, unknown>, busyCode: string, busyMessage: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true })
  const token = randomUUID(), recovery = `${file}.recovery`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ ...metadata, token, pid: process.pid }), 'utf8') } finally { closeSync(fd) }
      return () => {
        try {
          const current = JSON.parse(readFileSync(file, 'utf8')) as { token?: string }
          if (current.token === token) unlinkSync(file)
        } catch { /* lock was already removed or recovered */ }
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      let fd: number
      try { fd = openSync(recovery, 'wx', 0o600) }
      catch { throw new CoreError(busyCode, busyMessage) }
      let stale = false
      try {
        let owner: { pid?: number } | undefined
        try { owner = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number } } catch { /* fail closed */ }
        if (!owner) throw new CoreError(busyCode, busyMessage)
        if (pidIsAlive(owner.pid)) throw new CoreError(busyCode, busyMessage)
        stale = true
        try { unlinkSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } finally {
        closeSync(fd)
        try { unlinkSync(recovery) } catch { /* recovery lock cleanup */ }
      }
      if (!stale) throw new CoreError(busyCode, busyMessage)
    }
  }
  throw new CoreError(busyCode, busyMessage)
}
export type BundledObserver = { jarBase64: string; sha256: string; version: string; protocol: 2 }
export type BundledBuilder = { jarBase64: string; sha256: string; version: string; protocol: 1 }
export type ToolchainProvider = Pick<SystemToolchainProvider, 'status' | 'startGradle'> & {
  preflight?: (projectPath?: string) => JavaStatus
  scanJavas?: () => Promise<JavaCandidate[]>
  configureJava?: (javaHome: string) => Promise<{ configPath: string; javaHome: string; version?: string }>
  clearJava?: () => { configPath?: string; removed: boolean }
  readJavaConfig?: () => { path?: string; javaHome?: string; error?: string }
}
/** Companion artifact receipt produced by product:stage, also used by the standalone Bench. */
export function loadBundledObserver(directory: string): BundledObserver {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const observer = { ...receipt, jarBase64: readFileSync(path.join(directory, 'modcrafting-observer.jar')).toString('base64') } as BundledObserver
  observerBytes(observer)
  return observer
}
export function loadBundledBuilder(directory: string): BundledBuilder {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const builder = { ...receipt, jarBase64: readFileSync(path.join(directory, 'modcrafting-builder.jar')).toString('base64') } as BundledBuilder
  builderBytes(builder)
  return builder
}
function observerBytes(observer?: BundledObserver): Buffer {
  if (!observer) throw new CoreError('OBSERVER_UPDATE_REQUIRED', '插件缺少配套的游戏测试组件，请更新完整插件包；重新下载旧资源无法修复。')
  const bytes = Buffer.from(observer.jarBase64, 'base64')
  if (observer.protocol !== 2 || createHash('sha256').update(bytes).digest('hex') !== observer.sha256) throw new CoreError('OBSERVER_UPDATE_REQUIRED', '游戏测试组件校验失败，请重新安装完整插件包。')
  return bytes
}
function builderBytes(builder?: BundledBuilder): Buffer {
  if (!builder) throw new CoreError('BUILDER_UPDATE_REQUIRED', '插件缺少建筑工作室组件，请更新完整插件包。')
  const bytes = Buffer.from(builder.jarBase64, 'base64')
  if (builder.protocol !== 1 || createHash('sha256').update(bytes).digest('hex') !== builder.sha256) throw new CoreError('BUILDER_UPDATE_REQUIRED', '建筑工作室组件校验失败，请重新安装完整插件包。')
  return bytes
}
export function localAssetStatus(paths: RuntimePaths, observer?: BundledObserver): LocalAssetStatus[] {
  const docs = path.join(paths.knowledgeRoot, 'agent-knowledge', 'fabric')
  const checks = [
    { name: 'minecraft-data', path: path.join(paths.knowledgeRoot, 'minecraft-data', FABRIC_TARGET.minecraft, 'index.json'), kind: 'object' },
    { name: 'mc-wiki-zh', path: path.join(paths.knowledgeRoot, 'mc-wiki-zh'), kind: 'directory' },
    { name: 'mc-wiki-zh-index', path: path.join(paths.knowledgeRoot, 'mc-wiki-zh-index', 'chunks.json'), kind: 'array' },
    { name: 'fabric-docs', path: existsSync(docs) ? docs : path.join(paths.assetsRoot, 'agent-knowledge', 'fabric'), kind: 'markdown' },
    { name: 'base-mods', path: path.join(paths.assetsRoot, 'base-mods'), kind: 'observer' }
  ]
  return checks.map((check) => {
    const withRemediation = (row: LocalAssetStatus): LocalAssetStatus => {
      if (row.status === 'present') return row
      const assetName = check.name === 'fabric-docs' ? 'agent-knowledge' : check.name
      return {
        ...row,
        remediation: check.name === 'base-mods'
          ? '游戏测试组件随完整插件包提供；请重新安装当前版本的完整插件，不能通过资源下载修复。'
          : `调用 modcrafting_prepare_assets({ names: ["${assetName}"] }) 下载或修复这项知识资源。`
      }
    }
    if (check.kind === 'observer') {
      try { observerBytes(observer); return { name: check.name, path: `bundled:observer/${observer!.version}`, status: 'present' as const } }
      catch (cause) { return withRemediation({ name: check.name, path: check.path, status: existsSync(check.path) ? 'invalid' as const : 'missing' as const, error: String(cause) }) }
    }
    if (!existsSync(check.path)) return withRemediation({ name: check.name, path: check.path, status: 'missing' })
    try {
      if (check.kind === 'object' || check.kind === 'array') {
        const value = JSON.parse(readFileSync(check.path, 'utf8'))
        if (check.kind === 'array' ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid JSON shape')
      } else {
        const files = filesUnder(check.path).filter((file) => statSync(file).size > 0)
        if (!files.some((file) => check.kind === 'observer' ? /modcrafting-observer.*\.jar$/i.test(path.basename(file)) : check.kind === 'markdown' ? file.endsWith('.md') : true)) throw Error('Required resource files are missing')
      }
      return { name: check.name, path: check.path, status: 'present' }
    } catch { return withRemediation({ name: check.name, path: check.path, status: 'invalid', error: 'Local resource layout is invalid; prepare assets explicitly' }) }
  })
}

export function resolveProjectPath(value: string): string {
  const root = path.resolve(value)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new CoreError('PROJECT_UNAVAILABLE', 'projectPath does not exist or is not a directory')
  return root
}

/** Knowledge assets follow the workspace (.modcrafting inside it) when a project is known; the backend data root otherwise. */
export function projectRuntimePaths(paths: RuntimePaths, projectPath?: string): RuntimePaths {
  if (!projectPath) return paths
  return createRuntimePaths(path.join(path.resolve(projectPath), '.modcrafting'))
}
const waitForChild = (child: ChildProcess) => new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (value) => resolve(value ?? -1)) })

/** One owner of build/game/test jobs, reusable by MCP, Bench and optional views. */
export class FabricRuntime {
  private jobs = new JobManager()
  private instances = new Map<string, GameInstance>()
  private sequence = 0
  private compatibilitySessionId?: string
  private preparations = new Map<string, ReturnType<typeof prepareAssets>>()
  private preparationState = new Map<string, { phase: string; blockedReason?: string; screen?: Record<string, unknown> }>()
  private buildQueues = new Map<string, Promise<void>>()
  private toolchainProvider: ToolchainProvider
  private sessions: SessionRegistry
  private observer?: BundledObserver
  private builder?: BundledBuilder
  private scaffoldIncludesWrapper: boolean
  readonly paths: RuntimePaths
  readonly version: string
  get backendId(): string { return this.sessions.backendId }
  constructor(options: { paths: RuntimePaths; version: string; observer?: BundledObserver; builder?: BundledBuilder; scaffoldIncludesWrapper?: boolean; toolchain?: ToolchainProvider }) {
    this.paths = options.paths; this.version = options.version; this.observer = options.observer; this.builder = options.builder; this.scaffoldIncludesWrapper = Boolean(options.scaffoldIncludesWrapper); this.toolchainProvider = options.toolchain ?? new SystemToolchainProvider(options.paths.dataRoot)
    this.sessions = new SessionRegistry(options.paths.dataRoot)
  }
  studioInfo() {
    return this.builder ? { bundled: true, version: this.builder.version, protocol: this.builder.protocol } : { bundled: false }
  }
  createSession(input: { name?: string; projectPath?: string } = {}) {
    return this.sessions.create({ ...input, projectPath: input.projectPath ? resolveProjectPath(input.projectPath) : undefined })
  }
  readSession(sessionId: string) { return this.sessions.read(sessionId) }
  resumeSession(sessionId: string) {
    const session = this.sessions.resume(sessionId)
    for (const instance of session.instances) this.instances.set(instance.instanceId, instance)
    return session
  }
  updateSession(sessionId: string, changes: { name?: string; projectPath?: string; phase?: string; currentModule?: string; recommendedModules?: string[] }) {
    const { projectPath, ...metadata } = changes
    if (projectPath) this.sessions.bindProject(sessionId, resolveProjectPath(projectPath))
    return this.sessions.update(sessionId, metadata)
  }
  endSession(sessionId: string) {
    const session = this.sessions.assertOwned(sessionId)
    for (const job of this.jobs.list(sessionId) as JobSnapshot[]) this.jobs.stop(job.id, sessionId)
    this.syncSession(sessionId)
    return this.sessions.end(sessionId)
  }
  getTestProfile(sessionId: string, projectPath?: string): TestProfile {
    const session = this.session(sessionId)
    if (projectPath) this.sessions.bindProject(sessionId, resolveProjectPath(projectPath))
    if (session.profile) return testProfileSchema.parse(session.profile)
    const root = projectPath ? resolveProjectPath(projectPath) : session.projectPath
    if (root) {
      const file = path.join(root, '.modcrafting', 'test-profile.json')
      if (existsSync(file)) {
        try { return testProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) }
        catch (cause) { throw new CoreError('TEST_PROFILE_INVALID', `工程默认测试配置无法读取：${String(cause)}`) }
      }
    }
    return structuredClone(DEFAULT_TEST_PROFILE)
  }
  setTestProfile(sessionId: string, raw: unknown, options: { projectPath?: string; saveAsProjectDefault?: boolean } = {}) {
    const session = this.session(sessionId)
    if (options.projectPath) this.sessions.bindProject(sessionId, resolveProjectPath(options.projectPath))
    const profile = testProfileSchema.parse(raw)
    const root = options.projectPath ? resolveProjectPath(options.projectPath) : session.projectPath
    if (options.saveAsProjectDefault && !root) throw new CoreError('PROJECT_REQUIRED', '先在会话中打开工程，才能保存为此工程默认配置。')
    if (options.saveAsProjectDefault) {
      const directory = path.join(root, '.modcrafting')
      mkdirSync(directory, { recursive: true })
      writeFileSync(path.join(directory, 'test-profile.json'), JSON.stringify(profile, null, 2), 'utf8')
    }
    this.sessions.update(sessionId, { profile: profile as unknown as Record<string, unknown> })
    return { ok: true, sessionId, profile, savedAsProjectDefault: Boolean(options.saveAsProjectDefault) }
  }
  async environmentStatus(projectPath?: string): Promise<CoreEnvironmentStatus> {
    const scoped = projectRuntimePaths(this.paths, projectPath)
    const status = await this.toolchainProvider.status(projectPath)
    const assets = localAssetStatus(scoped, this.observer)
    const missingAssets = assets.filter((asset) => asset.status !== 'present' && asset.name !== 'base-mods')
    return {
      ...status,
      remediation: [...status.remediation, ...missingAssets.map((asset) => asset.remediation).filter((value): value is string => Boolean(value))],
      contractVersion: 1, paths: scoped, assets,
      capabilities: { ...CORE_CAPABILITIES, toolchain: { ...CORE_CAPABILITIES.toolchain, scaffoldIncludesWrapper: this.scaffoldIncludesWrapper } }
    }
  }
  async toolchain(request: { action: 'read' | 'scan' | 'write' | 'clear'; javaHome?: string; projectPath?: string }) {
    const provider = this.toolchainProvider
    if (request.action === 'scan') {
      if (!provider.scanJavas) throw new CoreError('ENVIRONMENT_UNAVAILABLE', '当前测试后端不支持 JDK 扫描。')
      return { ok: true, action: 'scan', config: provider.readJavaConfig?.(), candidates: await provider.scanJavas() }
    }
    if (request.action === 'write') {
      if (!request.javaHome) throw new CoreError('INVALID_ARGUMENT', '写入工具链配置时需要 javaHome 绝对路径。')
      if (!provider.configureJava) throw new CoreError('ENVIRONMENT_UNAVAILABLE', '当前测试后端不支持工具链配置。')
      const configured = await provider.configureJava(request.javaHome)
      const status = await provider.status(request.projectPath ? resolveProjectPath(request.projectPath) : undefined)
      return { ok: status.java.ok, action: 'write', ...configured, java: status.java }
    }
    if (request.action === 'clear') {
      if (!provider.clearJava) throw new CoreError('ENVIRONMENT_UNAVAILABLE', '当前测试后端不支持工具链配置。')
      const cleared = provider.clearJava()
      const status = await provider.status(request.projectPath ? resolveProjectPath(request.projectPath) : undefined)
      return { ok: status.java.ok, action: 'clear', ...cleared, java: status.java }
    }
    const status = await provider.status(request.projectPath ? resolveProjectPath(request.projectPath) : undefined)
    return { ok: status.java.ok, action: 'read', config: provider.readJavaConfig?.(), java: status.java, candidates: status.java.candidates }
  }
  async prepareAssets(names: DownloadableAsset[] = ['minecraft-data', 'mc-wiki-zh', 'mc-wiki-zh-index', 'agent-knowledge'], projectPath?: string) {
    if (projectPath) resolveProjectPath(projectPath)
    const scoped = projectRuntimePaths(this.paths, projectPath)
    // Serialize overlapping selections because extraction uses PID-based staging directories.
    const key = `${scoped.dataRoot}|${[...new Set(names)].sort().join(',')}`
    const present = localAssetStatus(scoped, this.observer)
    const needed = [...new Set(names)].filter(name => present.find(row => row.name === (name === 'agent-knowledge' ? 'fabric-docs' : name))?.status !== 'present')
    let work = this.preparations.get(key)
    if (!work) {
      const previous = Promise.allSettled([...this.preparations.values()])
      work = previous.then(() => prepareAssets(scoped, needed))
      this.preparations.set(key, work)
    }
    try {
      const assets = await work
      const localAssets = localAssetStatus(scoped, this.observer)
      const ready = names.every(name => localAssets.find(row => row.name === (name === 'agent-knowledge' ? 'fabric-docs' : name))?.status === 'present')
      return { ok: ready && assets.every(asset => asset.ok), assets, dataRoot: scoped.dataRoot, localAssets }
    } finally { if (this.preparations.get(key) === work) this.preparations.delete(key) }
  }
  startBuild(projectPath: string, task = 'build', requestedSessionId?: string) {
    if (!/^[A-Za-z][A-Za-z0-9:.-]*$/.test(task)) throw new CoreError('INVALID_ARGUMENT', 'Invalid Gradle task')
    const root = resolveProjectPath(projectPath)
    this.toolchainProvider.preflight?.(root)
    const sessionId = this.sessionId(requestedSessionId)
    this.sessions.bindProject(sessionId, root)
    this.sessions.update(sessionId, { phase: '正在构建', currentModule: 'build', recommendedModules: ['build'] })
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    const jobId = this.jobs.start('build', async (job) => {
      const previous = this.buildQueues.get(key) || Promise.resolve()
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const queued = previous.catch(() => {}).then(() => held)
      this.buildQueues.set(key, queued)
      await previous.catch(() => {})
      let releaseProject: (() => void) | undefined
      try {
        if (job.cancelled()) return { ok: false, task, code: 'CANCELLED' }
        const leaseFile = path.join(this.paths.dataRoot, 'project-leases', `${createHash('sha256').update(key).digest('hex')}.build.lock`)
        while (!releaseProject && !job.cancelled()) {
          try { releaseProject = acquireFileLease(leaseFile, { projectPath: root, sessionId, operation: 'build' }, 'PROJECT_BUSY', '另一个 ModCrafting 后端正在构建这个工程，当前任务已排队。') }
          catch (cause) { if (!(cause instanceof CoreError) || cause.code !== 'PROJECT_BUSY') throw cause; await delay(500) }
        }
        if (job.cancelled()) return { ok: false, task, code: 'CANCELLED' }
        const child = await this.toolchainProvider.startGradle(root, task, { onLog: (_, line) => job.output.push(line) })
        job.setChild(child); const code = await waitForChild(child)
        if (job.cancelled()) return { ok: false, task, exitCode: code, code: 'CANCELLED' }
        if (code !== 0) throw new CoreError('BUILD_FAILED', `Gradle ${task} exited ${code}`)
        return { ok: true, task, exitCode: code }
      } finally { releaseProject?.(); release(); if (this.buildQueues.get(key) === queued) this.buildQueues.delete(key) }
    }, sessionId)
    this.syncSession(sessionId)
    return { ok: true, jobId }
  }
  runClient(projectPath: string, gameDirectory?: string, requestedSessionId?: string, requestedProfile?: unknown) {
    const sessionId = this.sessionId(requestedSessionId), root = resolveProjectPath(projectPath)
    this.sessions.bindProject(sessionId, root)
    const profile = requestedProfile ? testProfileSchema.parse(requestedProfile) : this.getTestProfile(sessionId, root)
    if (requestedProfile) this.sessions.update(sessionId, { profile: profile as unknown as Record<string, unknown> })
    const gameDir = path.resolve(gameDirectory || path.join(root, 'run', 'modcrafting-fabric', 'sessions', sessionId))
    const sessionGameRoot = path.resolve(root, 'run', 'modcrafting-fabric', 'sessions', sessionId)
    const relativeGameDir = path.relative(sessionGameRoot, gameDir)
    if (requestedSessionId && (relativeGameDir === '..' || relativeGameDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeGameDir))) {
      throw new CoreError('GAME_DIRECTORY_OUTSIDE_SESSION', '游戏目录必须位于当前会话专用目录内，避免实例和存档串到其他会话。')
    }
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if ([...this.instances.values()].some((current) => {
      const job = this.jobs.status(current.jobId, current.sessionId)
      const active = 'status' in job && (job.status === 'running' || job.status === 'stopped' && !job.result && !job.error)
      if (!active) return false
      if (current.sessionId === sessionId) throw new CoreError('SESSION_GAME_BUSY', '当前会话已有游戏正在运行或关闭，请等待它结束后再启动。')
      if (key(current.projectPath) === key(root)) throw new CoreError('PROJECT_BUSY', '这个工程正被另一个任务会话的游戏占用。请先在原会话结束游戏，避免互相影响。')
      return key(current.gameDirectory) === key(gameDir)
    })) throw new CoreError('INSTANCE_CONFLICT', '这个会话的测试游戏仍在运行或正在关闭。')
    const existingDiscovery = readBridgeDiscovery(gameDir)
    if (existingDiscovery) {
      if (portIsListening(existingDiscovery.port)) throw new CoreError('INSTANCE_CONFLICT', `这个测试目录中仍有可响应的 Minecraft 实例（端口 ${existingDiscovery.port}）。请在原会话停止它后再启动。`)
      const stalePath = `${discoveryPath(gameDir)}.stale-${Date.now()}`
      try { renameSync(discoveryPath(gameDir), stalePath) }
      catch (cause) { throw new CoreError('BRIDGE_STALE_CLEANUP_FAILED', `Minecraft 实例已退出，但残留桥接标记无法隔离：${String(cause)}。请检查测试目录权限，不要直接删除整个会话目录。`) }
    }
    // Fail on a missing/incompatible bundled bridge before claiming the project lease.
    const bytes = observerBytes(this.observer)
    const builder = this.builder ? builderBytes(this.builder) : undefined
    const conflicts = filesUnder(path.join(gameDir, 'mods')).filter((file) => /modcrafting-observer.*\.jar$/i.test(path.basename(file)) && path.basename(file) !== 'modcrafting-observer.jar')
    if (conflicts.length) throw new CoreError('OBSERVER_CONFLICT', '游戏目录里有另一份测试组件。请选择新的测试目录，保留原目录供检查。')
    const builderConflicts = builder ? filesUnder(path.join(gameDir, 'mods')).filter((file) => /modcrafting-builder.*\.jar$/i.test(path.basename(file)) && path.basename(file) !== 'modcrafting-builder.jar') : []
    if (builderConflicts.length) throw new CoreError('BUILDER_CONFLICT', '游戏目录里有另一份建筑工作室组件。请选择新的测试目录，保留原目录供检查。')
    this.toolchainProvider.preflight?.(root)
    const gameLeasePath = path.join(this.paths.dataRoot, 'project-leases', `${createHash('sha256').update(key(root)).digest('hex')}.game.lock`)
    const releaseGameLease = acquireFileLease(gameLeasePath, { projectPath: root, sessionId, operation: 'game' }, 'PROJECT_BUSY', '这个工程已在另一个任务会话中运行游戏。请先结束原会话的 Minecraft。')
    try {
    mkdirSync(gameDir, { recursive: true })
    this.prepareWorldCopy(gameDir, sessionId, profile)
    this.writeGameOptions(gameDir, profile)
    // Use the component built with this plugin. A historical release cache is not a compatibility contract.
    mkdirSync(path.join(gameDir, 'mods'), { recursive: true })
    writeFileSync(path.join(gameDir, 'mods', 'modcrafting-observer.jar'), bytes)
    if (builder) writeFileSync(path.join(gameDir, 'mods', 'modcrafting-builder.jar'), builder)
    const gameArgs = `--args=--gameDir \"${gameDir.replace(/\\/g, '/')}\" --width=${profile.window.width} --height=${profile.window.height}`
    const jobId = this.jobs.start('minecraft', async (job) => {
      try {
        const child = await this.toolchainProvider.startGradle(root, 'runClient', { onLog: (_, line) => job.output.push(line) }, [gameArgs])
        job.setChild(child); const code = await waitForChild(child)
        if (job.cancelled()) return { exitCode: code, code: 'CANCELLED' }
        if (code !== 0) throw new CoreError('CLIENT_FAILED', `Minecraft runClient exited ${code}`)
        return { exitCode: code }
      } finally { releaseGameLease() }
    }, sessionId)
    const instanceId = `instance_${Date.now().toString(36)}_${++this.sequence}`
    const instance: GameInstance = { instanceId, sessionId, projectPath: root, gameDirectory: gameDir, jobId, profile: profile as unknown as Record<string, unknown> }
    this.instances.set(instanceId, instance)
    this.preparationState.set(instanceId, { phase: 'starting_client' })
    this.sessions.update(sessionId, { phase: '正在准备测试游戏', currentModule: 'game', recommendedModules: ['game', 'tests'] })
    const preparationJobId = this.jobs.start('minecraft_prepare', async (job) => this.prepareInstance(instance, profile, job), sessionId)
    instance.preparationJobId = preparationJobId
    this.syncSession(sessionId)
    return { ok: true, instanceId, jobId, preparationJobId, gameDirectory: gameDir, sessionId, profile }
    } catch (cause) { releaseGameLease(); throw cause }
  }
  private studioDiscovery(current: GameInstance): StudioDiscovery {
    const job = this.jobStatus(current.jobId, current.sessionId)
    if (!('status' in job) || job.status !== 'running') throw new CoreError('BUILDER_UNAVAILABLE', 'Minecraft instance is not running')
    const discovery = readStudioDiscovery(current.gameDirectory)
    if (!discovery) throw new CoreError('BUILDER_UNAVAILABLE', '建筑工作室组件尚未就绪；等待游戏进入测试世界，或使用包含 builder 组件的完整插件包。')
    if (discovery.protocol !== 1) throw new CoreError('BUILDER_UPDATE_REQUIRED', '建筑工作室组件版本不匹配，请停止并用新版插件重启游戏。')
    return discovery
  }
  private async withStudio<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (cause) { if (cause instanceof StudioError) throw new CoreError(cause.code, cause.message); throw cause }
  }
  private async requireGameReady(current: GameInstance, sessionId: string): Promise<void> {
    const status = await this.runtimeStatus(current.instanceId, sessionId)
    if (!status.canRunTests) throw new CoreError('GAME_NOT_READY', status.message || '游戏尚未进入测试世界。')
  }
  async studioStatus(id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    return studioRequest(this.studioDiscovery(current), 'GET', '/v1/studio/status', undefined, 15_000)
  }
  async studioOpen(input: { buildId: string; structurePath: string; force?: boolean }, id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    await this.requireGameReady(current, sessionId)
    return this.withStudio(async () => {
      assertBuildId(input.buildId)
      const discovery = this.studioDiscovery(current)
      prepareStudioInbox(current.gameDirectory, input.buildId, input.structurePath)
      return studioRequest(discovery, 'POST', '/v1/studio/open', { buildId: input.buildId, force: Boolean(input.force) })
    })
  }
  async studioCommit(buildId: string, id?: string, requestedSessionId?: string): Promise<StudioResult & { outbox?: StudioOutbox | null }> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    return this.withStudio(async () => {
      assertBuildId(buildId)
      const discovery = this.studioDiscovery(current)
      const result = await studioRequest(discovery, 'POST', '/v1/studio/commit', { buildId })
      return result.ok ? { ...result, outbox: readStudioOutbox(current.gameDirectory, buildId) } : result
    })
  }
  async studioApply(input: { buildId: string; structurePath?: string; x: number; y: number; z: number; force?: boolean; teleport?: boolean }, id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    await this.requireGameReady(current, sessionId)
    return this.withStudio(async () => {
      assertBuildId(input.buildId)
      const discovery = this.studioDiscovery(current)
      if (input.structurePath) prepareStudioInbox(current.gameDirectory, input.buildId, input.structurePath)
      return studioRequest(discovery, 'POST', '/v1/studio/apply', { buildId: input.buildId, x: input.x, y: input.y, z: input.z, force: Boolean(input.force), teleport: input.teleport !== false })
    })
  }
  async studioUndo(token?: string, id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    return this.withStudio(async () => studioRequest(this.studioDiscovery(current), 'POST', '/v1/studio/undo', token ? { token } : {}))
  }
  async studioExit(id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    return this.withStudio(async () => studioRequest(this.studioDiscovery(current), 'POST', '/v1/studio/exit', {}))
  }
  async studioClear(buildId?: string, force = false, id?: string, requestedSessionId?: string): Promise<StudioResult> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId)
    return this.withStudio(async () => {
      if (buildId) assertBuildId(buildId)
      return studioRequest(this.studioDiscovery(current), 'POST', '/v1/studio/clear', { buildId, force })
    })
  }
  private instance(id: string | undefined, sessionId: string): GameInstance {
    const sessionInstances = [...this.instances.values()].filter((value) => value.sessionId === sessionId)
    const value = id ? this.instances.get(id) : sessionInstances.at(-1)
    if (!value || value.sessionId !== sessionId) throw new CoreError('INSTANCE_UNAVAILABLE', '当前任务会话没有可用的 Minecraft 实例。')
    return value
  }
  private discovery(current: GameInstance): BridgeDiscovery {
    const job = this.jobStatus(current.jobId, current.sessionId)
    if (!('status' in job) || job.status !== 'running') throw new CoreError('OBSERVER_UNAVAILABLE', 'Minecraft instance is not running')
    const discovery = readBridgeDiscovery(current.gameDirectory)
    if (!discovery) throw new CoreError('OBSERVER_UNAVAILABLE', 'Observer bridge is not ready; wait for minecraft_runtime_status')
    if (discovery.apiVersions && !discovery.apiVersions.includes(2)) throw new CoreError('OBSERVER_UPDATE_REQUIRED', '当前游戏仍在使用旧测试组件，请停止并用新版插件重新启动游戏。不要尝试旧接口。')
    return discovery
  }
  private async readyDiscovery(current: GameInstance): Promise<BridgeDiscovery> {
    const discovery = this.discovery(current)
    const capabilities = await bridgeRequest(discovery, 'GET', '/v2/capabilities')
    if (!capabilities.ok || capabilities.data.protocolVersion !== 2) throw new CoreError(capabilities.status === 404 ? 'OBSERVER_UPDATE_REQUIRED' : 'OBSERVER_UNAVAILABLE', capabilities.status === 404 ? '游戏测试组件版本不匹配，请停止并用新版插件重新启动。不要探测旧接口。' : '游戏测试连接尚未就绪，请先查看启动状态。')
    return discovery
  }
  async runtimeStatus(id?: string, requestedSessionId?: string): Promise<GameRuntimeStatus> {
    const sessionId = this.sessionId(requestedSessionId), current = this.instance(id, sessionId), job = this.jobStatus(current.jobId, sessionId)
    const discovery = 'status' in job && job.status === 'running' ? readBridgeDiscovery(current.gameDirectory) : null
    const capabilities = discovery ? await bridgeRequest(discovery, 'GET', '/v2/capabilities') : undefined
    const bridgeReady = Boolean(capabilities?.ok && capabilities.data.protocolVersion === 2)
    const incompatible = capabilities?.status === 404 || discovery?.apiVersions && !discovery.apiVersions.includes(2)
    let prep = this.preparationState.get(current.instanceId) || { phase: bridgeReady ? 'checking_world' : 'waiting_bridge' }
    if (bridgeReady && discovery) {
      const status = await bridgeRequest(discovery, 'GET', '/v2/test-preparation')
      if (status.ok && typeof status.data.phase === 'string') {
        prep = { phase: status.data.phase, blockedReason: typeof status.data.blockedReason === 'string' ? status.data.blockedReason : undefined, screen: status.data.screen && typeof status.data.screen === 'object' ? status.data.screen as Record<string, unknown> : undefined }
        this.preparationState.set(current.instanceId, prep)
      }
    }
    const preparationJob = current.preparationJobId ? this.jobStatus(current.preparationJobId, sessionId) : undefined
    const canRunTests = bridgeReady && prep.phase === 'test_ready'
    return { ok: true, ...current, job, bridgeReady, canRunTests, preparation: { ...prep, ...(preparationJob ? { job: preparationJob } : {}) }, capabilities: capabilities?.data, ...(!canRunTests ? { code: incompatible ? 'OBSERVER_UPDATE_REQUIRED' : prep.phase === 'failed' ? 'GAME_PREPARATION_FAILED' : 'GAME_NOT_READY', message: incompatible ? '游戏测试组件版本不匹配，请停止并用新版插件重启游戏。' : prep.blockedReason || '游戏仍在准备中；进入专用测试世界后才会运行测试。' } : {}) }
  }
  stopClient(id?: string, requestedSessionId?: string) { const sessionId = this.sessionId(requestedSessionId); return this.stopJob(this.instance(id, sessionId).jobId, sessionId) }
  async snapshot(id?: string, spec?: GameTestSpec, requestedSessionId?: string, options?: SnapshotOptions): Promise<BridgeResult> {
    const sessionId = this.sessionId(requestedSessionId)
    const value = await this.snapshotFor(this.instance(id, sessionId), spec, options)
    return options ? compactSnapshot(value, options) : value
  }
  async entityQuery(query: { type?: string; name?: string; tag?: string; team?: string; radius?: number; limit?: number }, id?: string, requestedSessionId?: string): Promise<BridgeResult> {
    const radius = Math.min(64, Math.max(1, query.radius ?? 32)), limit = Math.min(64, Math.max(1, query.limit ?? 32))
    const snapshot = await this.snapshot(id, undefined, requestedSessionId, { radius, includeRecipes: false, includeTraces: false, includeBlocks: false, entityLimit: 64 })
    if (!snapshot.ok) return snapshot
    const rows = Array.isArray(snapshot.data.entities) ? snapshot.data.entities as Record<string, unknown>[] : []
    const wantedType = query.type ? (query.type.includes(':') ? query.type : `minecraft:${query.type}`) : undefined
    const name = query.name?.toLowerCase()
    const filtered = rows.filter((row) => (!wantedType || row.type === wantedType) && (!name || String(row.name || '').toLowerCase().includes(name)) && (!query.tag || (Array.isArray(row.tags) && row.tags.includes(query.tag))) && (!query.team || row.team === query.team))
    return { ok: true, status: snapshot.status, data: { ok: true, radius, total: rows.length, entities: filtered.slice(0, limit) } }
  }
  async widgets(id?: string, requestedSessionId?: string): Promise<BridgeResult> {
    const snapshot = await this.snapshot(id, undefined, requestedSessionId, { radius: 1, includeRecipes: false, includeTraces: false, includeBlocks: false, entityLimit: 1 })
    if (!snapshot.ok) return snapshot
    const data = snapshot.data
    return { ok: true, status: snapshot.status, data: { ok: true, screen: data.screen, widgets: data.widgets, containerSlots: data.containerSlots, containerHandlerType: data.containerHandlerType, cursorStack: data.cursorStack } }
  }
  async entityNbt(selector: string, path: string, id?: string, requestedSessionId?: string): Promise<BridgeResult> {
    if (!/^@[a-z](?:\[[^\]\n]+\])?$/.test(selector)) throw new CoreError('INVALID_ARGUMENT', 'selector 必须是一个 Minecraft 实体选择器，例如 @e[tag=test,limit=1]。')
    if (!/^[A-Za-z0-9_.:\[\]"'-]+$/.test(path)) throw new CoreError('INVALID_ARGUMENT', 'path 必须是单个 NBT 路径，不能包含空格或命令分隔符。')
    return this.command(`data get entity ${selector} ${path}`, id, requestedSessionId)
  }
  private async snapshotFor(current: GameInstance, spec?: GameTestSpec, options?: SnapshotOptions): Promise<BridgeResult> {
    const full = !options || options.full === true
    const blocks = full || options?.includeBlocks ? (spec?.assertions.filter((value) => value.type === 'block_equals').map(({ x, y, z }) => ({ x, y, z })) || [{ x: 0, y: 100, z: 4 }]) : []
    return bridgeRequest(await this.readyDiscovery(current), 'POST', '/v2/snapshot', {
      blocks,
      entityRadius: full ? 32 : options?.radius ?? 16,
      includeRecipes: full || options?.includeRecipes === true,
      includeTraces: full || options?.includeTraces === true,
      traceLimit: full ? 0 : options?.traceLimit ?? 20
    })
  }
  async command(command: string, id?: string, requestedSessionId?: string) { const sessionId = this.sessionId(requestedSessionId); return bridgeRequest(await this.readyDiscovery(this.instance(id, sessionId)), 'POST', '/v2/command', { command }) }
  async input(action: string, args?: Record<string, unknown>, id?: string, requestedSessionId?: string) { const sessionId = this.sessionId(requestedSessionId); return bridgeRequest(await this.readyDiscovery(this.instance(id, sessionId)), 'POST', '/v1/input', { ...(args || {}), action }) }
  async screenshot(id?: string, requestedSessionId?: string) { const sessionId = this.sessionId(requestedSessionId); return bridgeRequest(await this.readyDiscovery(this.instance(id, sessionId)), 'GET', '/v1/screenshot') }
  private async action(current: GameInstance, action: GameAction) {
    if (action.type === 'wait') { await new Promise((resolve) => setTimeout(resolve, action.ms)); return { ok: true, data: {} } }
    const discovery = await this.readyDiscovery(current)
    if (action.type === 'input') return bridgeRequest(discovery, 'POST', '/v1/input', { ...(action.args || {}), action: action.action })
    const call = await bridgeRequest(discovery, 'POST', '/v2/command', { command: action.command })
    return { ok: call.ok && call.data.executed === true, data: call.data }
  }
  startTest(raw: unknown, id?: string, requestedSessionId?: string) {
    const parsed = validateGameTestSpec(raw)
    if ('error' in parsed) throw new CoreError(parsed.code, parsed.error)
    const sessionId = this.sessionId(requestedSessionId)
    const current = this.instance(id, sessionId)
    const jobId = this.jobs.start('game_test', async (job) => {
      const blocked = await this.waitForTestReady(current, job.cancelled)
      if (blocked) {
        const result = this.blockedTestResult(parsed.spec, blocked, job.cancelled())
        const reportPath = await writeGameTestReport(this.paths, `${Date.now().toString(36)}-${parsed.spec.id}`, { ...result, spec: parsed.spec, sessionId, instanceId: current.instanceId, gameDirectory: current.gameDirectory, createdAt: new Date().toISOString() }, sessionId)
        return { ...result, reportPath }
      }
      const report = await executeGameTest(parsed.spec, {
        snapshot: (spec) => this.snapshotFor(current, spec), action: (action) => this.action(current, action), cancelled: job.cancelled
      }, this.version)
      const reportPath = await writeGameTestReport(this.paths, `${Date.now().toString(36)}-${parsed.spec.id}`, { ...report, spec: parsed.spec, sessionId, instanceId: current.instanceId, gameDirectory: current.gameDirectory, createdAt: new Date().toISOString() }, sessionId)
      return { ...report, reportPath }
    }, sessionId)
    this.sessions.update(sessionId, { phase: '正在验证游戏效果', currentModule: 'tests', recommendedModules: ['tests'] })
    this.syncSession(sessionId)
    return { ok: true, jobId, scenarioId: parsed.spec.id }
  }
  jobStatus(id: string, requestedSessionId?: string): JobSnapshot | CoreFailure {
    if (requestedSessionId) {
      const storedSession = this.sessions.read(requestedSessionId)
      if (storedSession.status === 'ended') return storedSession.jobs.find((row) => row.id === id) || { ok: false, code: 'JOB_NOT_FOUND', error: '这个已结束任务中没有该作业。' }
    }
    const sessionId = this.sessionId(requestedSessionId)
    const value = this.jobs.status(id, sessionId)
    if ('status' in value) { this.syncSession(sessionId); return value as JobSnapshot }
    if (value.code === 'JOB_NOT_OWNED') return { ok: false, code: 'JOB_NOT_OWNED', error: '这个任务属于其他会话。' }
    const saved = this.sessions.read(sessionId).jobs.find((row) => row.id === id)
    return saved || value as CoreFailure
  }
  state(requestedSessionId?: string): CoreRuntimeState {
    const stored = requestedSessionId ? this.sessions.read(requestedSessionId) : undefined
    const sessionId = stored?.status === 'ended' ? stored.sessionId : this.sessionId(requestedSessionId)
    if (stored?.status !== 'ended') this.syncSession(sessionId)
    const session = this.sessions.read(sessionId)
    const live = session.status === 'ended' ? [] : this.jobs.list(sessionId) as JobSnapshot[]
    const byId = new Map(session.jobs.map((job) => [job.id, job]))
    for (const job of live) byId.set(job.id, job)
    const instances = new Map(session.instances.map((instance) => [instance.instanceId, instance]))
    for (const instance of this.instances.values()) if (instance.sessionId === sessionId) instances.set(instance.instanceId, { ...instance })
    return { contractVersion: 1, backendId: this.sessions.backendId, sessionId, sessions: this.sessions.list(), jobs: [...byId.values()], instances: [...instances.values()] }
  }
  stopJob(id: string, requestedSessionId?: string) {
    const sessionId = this.sessionId(requestedSessionId), value = this.jobs.stop(id, sessionId)
    if (value.code === 'JOB_NOT_OWNED') throw new CoreError('JOB_NOT_OWNED', '不能停止其他任务会话的作业。')
    this.syncSession(sessionId)
    return value
  }
  close(): void {
    this.jobs.stopAll()
    for (const session of this.sessions.list()) {
      try { this.sessions.assertOwned(session.sessionId); this.syncSession(session.sessionId) } catch { /* another backend owns this session */ }
    }
    this.sessions.close()
  }

  private session(requestedSessionId?: string) {
    const sessionId = this.sessionId(requestedSessionId)
    return this.sessions.assertOwned(sessionId)
  }
  private sessionId(requestedSessionId?: string): string {
    if (requestedSessionId) {
      try { this.sessions.assertOwned(requestedSessionId); return requestedSessionId }
      catch (cause) { throw new CoreError((cause as { code?: string }).code || 'SESSION_NOT_OWNED', String(cause)) }
    }
    if (!this.compatibilitySessionId) this.compatibilitySessionId = this.sessions.create({ name: '兼容任务' }).sessionId
    return this.compatibilitySessionId
  }
  private syncSession(sessionId: string): void {
    try {
      const jobs = this.jobs.list(sessionId) as JobSnapshot[]
      const instances = [...this.instances.values()].filter((value) => value.sessionId === sessionId)
      this.sessions.sync(sessionId, jobs, instances)
    } catch { /* session may have ended while a job was settling */ }
  }
  private prepareWorldCopy(gameDir: string, sessionId: string, profile: TestProfile): void {
    const saves = path.join(gameDir, 'saves'), target = path.join(saves, GAME_TEST_WORLD), markerPath = path.join(target, '.modcrafting-owner.json')
    mkdirSync(saves, { recursive: true })
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) throw new CoreError('WORLD_PATH_UNSAFE', '测试地图目录是链接，已停止以保护其他存档。')
      if (!existsSync(path.join(target, 'level.dat'))) throw new CoreError('WORLD_INVALID', '测试地图目录存在，但缺少 level.dat。')
      let marker: Record<string, unknown> = {}
      try { marker = JSON.parse(readFileSync(markerPath, 'utf8')) } catch { /* checked below */ }
      if (marker.sessionId !== sessionId) throw new CoreError('WORLD_OWNERSHIP_MISMATCH', '此目录不是当前会话创建的测试地图。请使用新的测试目录，不会覆盖现有地图。')
      return
    }
    if (profile.map.source === 'save_copy') {
      const source = profile.map.sourcePath!
      if (!path.isAbsolute(source)) throw new CoreError('SAVE_SOURCE_INVALID', '复制存档时必须提供绝对路径。')
      const info = lstatSync(source)
      if (!info.isDirectory() || info.isSymbolicLink() || !existsSync(path.join(source, 'level.dat'))) throw new CoreError('SAVE_SOURCE_INVALID', '存档来源必须是包含 level.dat 的普通目录。')
      copyDirectoryNoLinks(source, target)
      writeFileSync(markerPath, JSON.stringify({ sessionId, worldName: GAME_TEST_WORLD, copiedFrom: source, createdAt: new Date().toISOString() }, null, 2), 'utf8')
    }
  }
  private writeGameOptions(gameDir: string, profile: TestProfile): void {
    const file = path.join(gameDir, 'options.txt')
    const values: Record<string, string> = {
      lang: profile.language, onboardAccessibility: 'false', narrator: '0', fullscreen: 'false',
      overrideWidth: String(profile.window.width), overrideHeight: String(profile.window.height),
      renderDistance: String(profile.renderDistance), maxFps: String(profile.maxFps),
      soundCategory_master: String(profile.volumePercent / 100), pauseOnLostFocus: 'false'
    }
    let lines: string[] = []
    try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) } catch { /* first launch */ }
    const written = new Set<string>(), next: string[] = []
    for (const line of lines) {
      const key = line.slice(0, line.indexOf(':'))
      if (Object.hasOwn(values, key)) { if (!written.has(key)) next.push(`${key}:${values[key]}`); written.add(key) }
      else next.push(line)
    }
    for (const [key, value] of Object.entries(values)) if (!written.has(key)) next.push(`${key}:${value}`)
    writeFileSync(file, `${next.join('\n')}\n`, 'utf8')
  }
  private async prepareInstance(instance: GameInstance, profile: TestProfile, job: { output: string[]; cancelled: () => boolean }) {
    const sessionId = instance.sessionId!, deadline = Date.now() + 300_000
    let requested = false, lastPhase = ''
    const fail = (phase: string, reason: string, screen?: Record<string, unknown>, recoveryAction?: string): never => {
      const detail = { phase, blockedReason: reason, screen, recoveryAction }
      this.preparationState.set(instance.instanceId, { phase: 'failed', blockedReason: reason, screen })
      this.sessions.update(sessionId, { phase: '游戏准备未完成：' + reason, currentModule: 'game' })
      throw Object.assign(new CoreError('GAME_PREPARATION_FAILED', `${phase}: ${reason}${screen ? `（当前界面：${screen.simpleName || screen.className || screen.kind || '未知'}）` : ''}${recoveryAction ? `；建议：${recoveryAction}` : ''}`), { preparation: detail })
    }
    while (Date.now() < deadline) {
      if (job.cancelled()) return { ok: false, code: 'CANCELLED', phase: this.preparationState.get(instance.instanceId)?.phase || 'cancelled' }
      const gameJob = this.jobs.status(instance.jobId, sessionId)
      if (!('status' in gameJob) || gameJob.status !== 'running') fail('start_client', 'Minecraft 客户端已退出，尚未进入测试世界。', undefined, '查看启动日志后再决定是否重新启动。')
      const discovery = readBridgeDiscovery(instance.gameDirectory)
      if (!discovery) { this.setPreparationPhase(instance, 'waiting_bridge', job.output); await delay(1000); continue }
      const capabilities = await bridgeRequest(discovery, 'GET', '/v2/capabilities')
      if (!capabilities.ok || capabilities.data.protocolVersion !== 2) fail('waiting_bridge', '游戏测试组件没有通过 V2 握手。', undefined, '更新完整插件包后重新启动这个会话。')
      if (!requested) {
        const started = await bridgeRequest(discovery, 'POST', '/v2/test-preparation', { sessionId, profile, worldName: GAME_TEST_WORLD })
        if (!started.ok) fail('prepare_world', started.error || String(started.data.error || 'Observer 拒绝准备测试世界。'), undefined, '检查游戏启动日志和测试目录权限。')
        requested = true
      }
      const response = await bridgeRequest(discovery, 'GET', '/v2/test-preparation')
      if (!response.ok) fail('prepare_world', response.error || '无法读取游戏准备状态。', undefined, '检查 Observer V2 连接。')
      const phase = String(response.data.phase || 'unknown_screen')
      const screen = response.data.screen && typeof response.data.screen === 'object' ? response.data.screen as Record<string, unknown> : undefined
      const reason = typeof response.data.blockedReason === 'string' ? response.data.blockedReason : undefined
      this.preparationState.set(instance.instanceId, { phase, blockedReason: reason, screen })
      if (phase !== lastPhase) {
        job.output.push(`游戏准备：${phase}${reason ? ` · ${reason}` : ''}`)
        this.sessions.update(sessionId, { phase: phase === 'test_ready' ? '测试世界已就绪' : `正在准备测试游戏：${phase}`, currentModule: phase === 'test_ready' ? 'tests' : 'game', recommendedModules: phase === 'test_ready' ? ['tests'] : ['game'] })
        lastPhase = phase
      }
      if (response.data.ready === true && phase === 'test_ready') return { ok: true, phase, sessionId, profileSnapshot: profile }
      if (response.data.failed === true || phase === 'failed' || phase === 'unknown_screen') fail(phase, reason || '游戏停在无法识别的界面。', screen, typeof response.data.recoveryAction === 'string' ? response.data.recoveryAction : '保留当前游戏画面和日志，检查后在同一会话中继续。')
      await delay(1000)
    }
    fail(this.preparationState.get(instance.instanceId)?.phase || 'timeout', '准备测试世界超过 300 秒。', this.preparationState.get(instance.instanceId)?.screen, '检查游戏日志和当前界面；不要重复启动客户端。')
  }
  private setPreparationPhase(instance: GameInstance, phase: string, output: string[]): void {
    if (this.preparationState.get(instance.instanceId)?.phase === phase) return
    this.preparationState.set(instance.instanceId, { phase })
    output.push(`游戏准备：${phase}`)
  }
  private async waitForTestReady(instance: GameInstance, cancelled: () => boolean): Promise<{ phase: string; reason: string; screen?: Record<string, unknown>; recoveryAction?: string } | undefined> {
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline) {
      if (cancelled()) return { phase: 'cancelled', reason: '测试请求已取消。', recoveryAction: '确认是否需要在同一会话重新发起测试。' }
      const job = this.jobs.status(instance.jobId, instance.sessionId)
      if (!('status' in job) || job.status !== 'running') return { phase: 'start_client', reason: 'Minecraft 客户端已退出。', recoveryAction: '查看启动任务日志；不要自动重复启动。' }
      const status = await this.runtimeStatus(instance.instanceId, instance.sessionId)
      if (status.canRunTests) return undefined
      if (status.preparation.phase === 'failed') return { phase: status.preparation.phase, reason: status.preparation.blockedReason || status.message || '游戏准备失败。', screen: status.preparation.screen, recoveryAction: '按准备状态中的建议排查后，在当前会话继续。' }
      await delay(1000)
    }
    const current = this.preparationState.get(instance.instanceId)
    return { phase: current?.phase || 'timeout', reason: '等待游戏进入测试世界超过 300 秒。', screen: current?.screen, recoveryAction: '检查游戏画面和启动日志；不要通过反复重启解决。' }
  }
  private blockedTestResult(spec: GameTestSpec, blocked: { phase: string; reason: string; screen?: Record<string, unknown>; recoveryAction?: string }, cancelled: boolean) {
    const code = cancelled ? 'ENVIRONMENT_UNAVAILABLE' : 'ENVIRONMENT_UNAVAILABLE'
    const reason = `${blocked.phase}: ${blocked.reason}${blocked.recoveryAction ? ` 建议：${blocked.recoveryAction}` : ''}`
    const cleanup = { attempted: false, completed: 0, failed: false, reason: 'Skipped: test world was not ready; no game actions were run' }
    const report = { verdict: 'INCONCLUSIVE' as const, code, reason, scenarioId: spec.id, version: this.version, evidenceSource: 'Observer V2 /v2/snapshot', supportedAssertions: SUPPORTED_GAME_ASSERTIONS, evidence: [], snapshots: [], cleanup, preparation: blocked }
    return { ...report, acceptance: { reportVersion: 1, producer: 'core', execution: 'live', scenarioId: spec.id, engineVersion: this.version, minecraftVersion: FABRIC_TARGET.minecraft, evidenceSource: report.evidenceSource, verdict: report.verdict, legacyVerdict: report.verdict, code, reason, evidence: [], snapshots: [], cleanup: { status: 'skipped', completed: 0 } } }
  }
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function copyDirectoryNoLinks(source: string, destination: string): void {
  const info = lstatSync(source)
  if (info.isSymbolicLink()) throw new CoreError('SAVE_SOURCE_UNSAFE', '存档含有符号链接或目录联接，拒绝复制。')
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source)) copyDirectoryNoLinks(path.join(source, entry), path.join(destination, entry))
  } else if (info.isFile()) copyFileSync(source, destination)
  else throw new CoreError('SAVE_SOURCE_UNSAFE', '存档中存在不支持的文件类型，拒绝复制。')
}
