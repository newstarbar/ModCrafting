import { ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as iconv from 'iconv-lite'
import { isGradleHomeSeedReady, prepareBuild, purgeGradleEphemeralCaches } from './build-env'
import { resolveLaunchProjectPath } from './mc-launch-path'
import {
  clearBridgeDiscovery,
  readBridgeDiscovery,
  requestBridge,
  isAllowedBridgeApiPath,
  waitForBridgeDiscovery,
  type BridgeDiscovery
} from './mc-bridge-client'

const LOG_BUFFER_MAX_LINES = 500

const platformEncoding = process.platform === 'win32' ? 'gbk' : 'utf-8'

/** Break all symlinks and directory junctions inside a directory
 *  so fs.rmSync with recursive:true won't follow them to the target. */
function breakLinksInDir(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      try {
        fs.readlinkSync(path.join(dir, entry.name))
        fs.rmSync(path.join(dir, entry.name), { force: true })
      } catch { /* not a link or already gone */ }
    }
  } catch { /* dir missing */ }
}

/** Recursively delete a directory without following junctions or symlinks. */
function safeRmDirNoFollow(dir: string): void {
  if (!fs.existsSync(dir)) return
  try { fs.readlinkSync(dir); fs.rmSync(dir, { force: true }); return } catch { /* not a link */ }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name)
    try { fs.readlinkSync(child); fs.rmSync(child, { force: true }); continue } catch { /* not a link */ }
    if (entry.isDirectory()) safeRmDirNoFollow(child)
    else fs.rmSync(child, { force: true })
  }
  fs.rmdirSync(dir)
}

function decodeBuffer(buf: Buffer): string {
  return iconv.decode(buf, platformEncoding)
}

const CLIENT_STARTED_MARKERS = [
  'loading minecraft',
  'minecraft client started',
  'setting user:',
  'backend library: lwjgl',
  'lwjgl version',
  'openal initialized',
  'sound engine started',
  'reloading resourcemanager'
]

function isClientStarted(text: string): boolean {
  const lower = text.toLowerCase()
  return CLIENT_STARTED_MARKERS.some((m) => lower.includes(m))
}

function appendLog(instance: McInstance, text: string): void {
  const parts = text.split(/\r?\n/)
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part && i < parts.length - 1) {
      instance.logBuffer.push('')
      continue
    }
    if (!part) continue
    instance.logBuffer.push(part)
  }
  if (instance.logBuffer.length > LOG_BUFFER_MAX_LINES) {
    instance.logBuffer = instance.logBuffer.slice(-LOG_BUFFER_MAX_LINES)
  }
}

function updateLoadedMods(instance: McInstance, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([a-z0-9_.-]+)\s+\S+/i)
    if (!match) continue
    const id = match[1]
    if (!instance.readiness.loadedModIds.includes(id)) instance.readiness.loadedModIds.push(id)
  }
  instance.readiness.missingModIds = instance.readiness.expectedModIds.filter(
    (id) => !instance.readiness.loadedModIds.includes(id)
  )
  if (instance.readiness.loadedModIds.length > 0 && instance.readiness.phase === 'preparing') {
    instance.readiness.phase = 'loading'
  }
}

function markReadinessFailure(instance: McInstance, code: Exclude<RuntimeFailureCode, null>, message: string): void {
  instance.readiness.phase = 'error'
  instance.readiness.failureCode = code
  instance.readiness.failureMessage = message
  notifyInstanceState(instance.id)
}

/** Per-instance Gradle home so parallel runClient does not stop other instances' daemons. */
function buildInstanceGradleEnv(baseEnv: NodeJS.ProcessEnv, instanceId: string): NodeJS.ProcessEnv {
  const sharedHome = baseEnv.GRADLE_USER_HOME
  if (!sharedHome || typeof sharedHome !== 'string') {
    return { ...baseEnv }
  }

  const instanceHome = path.join(sharedHome, 'mc-instances', instanceId)
  fs.mkdirSync(instanceHome, { recursive: true })

  for (const dir of ['caches', 'wrapper', 'notifications']) {
    const src = path.join(sharedHome, dir)
    const dest = path.join(instanceHome, dir)
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      try {
        fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        // If junction fails, instance still gets an isolated daemon registry directory.
      }
    }
  }

  return { ...baseEnv, GRADLE_USER_HOME: instanceHome }
}

function instanceGameDirAbs(projectPath: string, instanceId: string): string {
  const safe = instanceId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(projectPath, 'run', safe)
}

function quoteGameDirArg(gameDirAbs: string): string {
  const normalized = gameDirAbs.replace(/\\/g, '/')
  return normalized.includes(' ') ? `"${normalized}"` : normalized
}

/** Ensure Chinese UI and skip the first-run accessibility welcome screen. */
function ensureGameOptions(gameDirAbs: string): void {
  const optionsPath = path.join(gameDirAbs, 'options.txt')
  const required: Record<string, string> = {
    lang: 'zh_cn',
    onboardAccessibility: 'false',
    narrator: '0'
  }

  if (!fs.existsSync(optionsPath)) {
    const content = Object.entries(required)
      .map(([k, v]) => `${k}:${v}`)
      .join('\n')
    fs.writeFileSync(optionsPath, `${content}\n`, 'utf-8')
    return
  }

  let content = fs.readFileSync(optionsPath, 'utf-8')
  for (const [key, value] of Object.entries(required)) {
    const re = new RegExp(`^${key}:.*$`, 'm')
    const line = `${key}:${value}`
    content = re.test(content) ? content.replace(re, line) : `${content.replace(/\s*$/, '')}\n${line}`
  }
  fs.writeFileSync(optionsPath, `${content.replace(/\s*$/, '')}\n`, 'utf-8')
}

type ExitReason = 'none' | 'normal' | 'crash' | 'manual' | 'start_failed'
type RuntimeFailureCode = 'base_mod_artifact_invalid' | 'runtime_mods_missing' | 'observer_bridge_unavailable' | 'observer_protocol_incompatible' | null

export interface McRuntimeReadiness {
  phase: 'preparing' | 'loading' | 'menu' | 'ready' | 'error'
  expectedModIds: string[]
  loadedModIds: string[]
  missingModIds: string[]
  bridgeReady: boolean
  bridgeApiVersions: number[]
  gameDir: string | null
  failureCode: RuntimeFailureCode
  failureMessage?: string
}

function readProjectModId(projectPath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectPath, 'src', 'main', 'resources', 'fabric.mod.json'), 'utf8')) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id : null
  } catch {
    return null
  }
}

function createReadiness(projectPath: string): McRuntimeReadiness {
  const projectId = readProjectModId(projectPath)
  const expectedModIds = [...(projectId ? [projectId] : []), 'modmenu', 'modcrafting_observer']
  return {
    phase: 'preparing',
    expectedModIds,
    loadedModIds: [],
    missingModIds: expectedModIds,
    bridgeReady: false,
    bridgeApiVersions: [],
    gameDir: null,
    failureCode: projectId ? null : 'runtime_mods_missing',
    failureMessage: projectId ? undefined : '无法从 fabric.mod.json 读取目标模组 ID。'
  }
}

interface McInstance {
  id: string
  name: string
  projectPath: string
  process: ChildProcess | null
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'
  startedAt: Date | null
  crashedAt: Date | null
  crashReportPath: string | null
  exitReason: ExitReason
  logBuffer: string[]
  gameDir: string | null
  bridge: BridgeDiscovery | null
  readiness: McRuntimeReadiness
}

const instances = new Map<string, McInstance>()
let instanceCounter = 0

function createInstanceRecord(projectPath: string, name?: string): McInstance {
  const id = `mc-${++instanceCounter}`
  const instance: McInstance = {
    id,
    name: name || `玩家 ${instanceCounter}`,
    projectPath,
    process: null,
    status: 'stopped',
    startedAt: null,
    crashedAt: null,
    crashReportPath: null,
    exitReason: 'none',
    logBuffer: [],
    gameDir: null,
    bridge: null,
    readiness: createReadiness(projectPath)
  }
  instances.set(id, instance)
  notifyInstanceState(id)
  return instance
}

export interface MinecraftWindowSize { width: number; height: number }

function normalizeWindowSize(value: unknown): MinecraftWindowSize | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const width = Number(record.width)
  const height = Number(record.height)
  return Number.isInteger(width) && Number.isInteger(height) && width >= 640 && width <= 4096 && height >= 480 && height <= 2160
    ? { width, height }
    : undefined
}

async function startInstance(id: string, windowSize?: MinecraftWindowSize): Promise<{ success: boolean; error?: string }> {
  const instance = instances.get(id)
  if (!instance) return { success: false, error: 'Instance not found' }
  if (instance.status === 'running' || instance.status === 'starting') {
    return { success: false, error: 'Instance is already running' }
  }

  const buildPrep = await prepareBuild(instance.projectPath)
  if (!buildPrep.ok) {
    instance.readiness = createReadiness(instance.projectPath)
    markReadinessFailure(instance, 'base_mod_artifact_invalid', buildPrep.error || '基础模组或构建环境未就绪。')
    return { success: false, error: buildPrep.error || '构建环境未就绪。' }
  }

  instance.status = 'starting'
  instance.startedAt = new Date()
  instance.crashedAt = null
  instance.crashReportPath = null
  instance.exitReason = 'none'
  instance.logBuffer = []
  instance.bridge = null
  instance.readiness = createReadiness(instance.projectPath)
  notifyInstanceState(id)

  let launchProjectPath: string
  try {
    launchProjectPath = resolveLaunchProjectPath(instance.projectPath)
  } catch (error) {
    instance.status = 'crashed'
    instance.exitReason = 'start_failed'
    const message = `无法创建 Windows ASCII 游戏启动路径：${error instanceof Error ? error.message : String(error)}`
    markReadinessFailure(instance, 'observer_bridge_unavailable', message)
    return { success: false, error: message }
  }

  const gradlew = path.join(launchProjectPath, 'gradlew.bat')
  const cmd = fs.existsSync(gradlew) ? gradlew : 'gradle'
  const offlineFlags = isGradleHomeSeedReady() ? '--offline' : '-Dorg.gradle.offline=false'
  const gameDirAbs = instanceGameDirAbs(launchProjectPath, id)
  instance.gameDir = gameDirAbs
  instance.readiness.gameDir = gameDirAbs
  fs.mkdirSync(path.join(gameDirAbs, 'mods'), { recursive: true })
  ensureGameOptions(gameDirAbs)
  clearBridgeDiscovery(gameDirAbs)

  const sharedGradleHome = buildPrep.env?.GRADLE_USER_HOME
  if (typeof sharedGradleHome === 'string') {
    try { purgeGradleEphemeralCaches(sharedGradleHome) } catch { /* locked files are harmless */ }
    const staleInstanceHome = path.join(sharedGradleHome, 'mc-instances', id)
    if (fs.existsSync(staleInstanceHome)) {
      try {
        safeRmDirNoFollow(staleInstanceHome)
      } catch {
        // continue with junction setup even if stale instance dir could not be removed
      }
    }
  }

  const instanceEnv = buildInstanceGradleEnv(buildPrep.env || process.env, id)
  const gameDirArg = quoteGameDirArg(gameDirAbs)
  const windowArgs = windowSize ? ` --width ${windowSize.width} --height ${windowSize.height}` : ''
  const fullCmd = `"${cmd}" ${offlineFlags} runClient --no-daemon --args="--gameDir ${gameDirArg}${windowArgs}"`

  try {
    const proc = spawn(fullCmd, {
      cwd: launchProjectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: instanceEnv
    })

    instance.process = proc

    const handleOutput = (text: string): void => {
      appendLog(instance, text)
      updateLoadedMods(instance, text)
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
      const payload = lines.length > 0 ? lines : [text]
      for (const line of payload) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('mc:log', id, line + '\n')
        })
      }
      if (instance.status === 'starting' && isClientStarted(text)) {
        instance.status = 'running'
        instance.readiness.phase = 'menu'
        notifyInstanceState(id)
        void attachBridgeWhenReady(instance, gameDirAbs)
      }
    }

    proc.stdout?.on('data', (data: Buffer) => handleOutput(decodeBuffer(data)))
    proc.stderr?.on('data', (data: Buffer) => handleOutput(decodeBuffer(data)))

    proc.on('exit', (code) => {
      const wasManual = instance.exitReason === 'manual'
      instance.process = null
      instance.startedAt = null
      instance.bridge = null

      if (wasManual) {
        instance.status = 'stopped'
        notifyInstanceState(id)
        return
      }

      if (code !== 0 && code !== null) {
        instance.status = 'crashed'
        instance.exitReason = 'crash'
        instance.crashedAt = new Date()

        const crashReportsDir = path.join(instanceGameDirAbs(instance.projectPath, id), 'crash-reports')
        if (fs.existsSync(crashReportsDir)) {
          const files = fs.readdirSync(crashReportsDir)
            .filter((f) => f.endsWith('.txt'))
            .sort()
            .reverse()
          if (files.length > 0) {
            instance.crashReportPath = path.join(crashReportsDir, files[0])
          }
        }

        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('mc:crashed', id, code, instance.crashReportPath)
        })
      } else {
        instance.status = 'stopped'
        instance.exitReason = 'normal'
      }

      notifyInstanceState(id)
      if (typeof sharedGradleHome === 'string') {
        try { purgeGradleEphemeralCaches(sharedGradleHome) } catch { /* locked files are harmless */ }
      }
    })

    proc.on('error', (err) => {
      instance.process = null
      instance.status = 'crashed'
      instance.exitReason = 'start_failed'
      instance.crashedAt = new Date()
      if (typeof sharedGradleHome === 'string') {
        try { purgeGradleEphemeralCaches(sharedGradleHome) } catch { /* locked files are harmless */ }
      }
      notifyInstanceState(id)
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('mc:crashed', id, -1, null)
        win.webContents.send('mc:log', id, `Error: ${err.message}\n`)
      })
    })

    return { success: true }
  } catch (err) {
    instance.status = 'crashed'
    instance.exitReason = 'start_failed'
    instance.crashedAt = new Date()
    notifyInstanceState(id)
    return { success: false, error: String(err) }
  }
}

function stopInstance(instance: McInstance): void {
  if (!instance.process) {
    instance.status = 'stopped'
    if (instance.exitReason === 'none') {
      instance.exitReason = 'manual'
    }
    notifyInstanceState(instance.id)
    return
  }

  instance.exitReason = 'manual'
  instance.status = 'stopping'
  notifyInstanceState(instance.id)

  const proc = instance.process
  const pid = proc.pid

  setTimeout(() => {
    if (!instance.process) return
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/PID', String(pid), '/F', '/T'])
      } catch { /* ignore */ }
    } else {
      instance.process.kill('SIGTERM')
    }
    instance.process = null
    instance.status = 'stopped'
    instance.startedAt = null
    notifyInstanceState(instance.id)
  }, 3000)
}

export function stopAllMcInstances(): void {
  for (const instance of instances.values()) {
    if (instance.status === 'running' || instance.status === 'starting' || instance.status === 'stopping') {
      stopInstance(instance)
    }
  }
}

export function setupMcRuntimeHandlers(): void {
  ipcMain.handle('mc:createInstance', async (_event, projectPath: string, name?: string) => {
    const instance = createInstanceRecord(projectPath, name)
    return { id: instance.id, name: instance.name, status: instance.status }
  })

  ipcMain.handle('mc:start', async (_event, id: string) => startInstance(id))

  ipcMain.handle('mc:startOrCreate', async (_event, projectPath: string, name?: string, requestedWindowSize?: unknown) => {
    const existing = Array.from(instances.values()).find(
      (i) => i.projectPath === projectPath && (i.status === 'stopped' || i.status === 'crashed')
    )
    const instance = existing || createInstanceRecord(projectPath, name)
    const result = await startInstance(instance.id, normalizeWindowSize(requestedWindowSize))
    return { ...result, id: instance.id }
  })

  ipcMain.handle('mc:stop', async (_event, id: string) => {
    const instance = instances.get(id)
    if (!instance) return { success: false, error: 'Instance not found' }
    stopInstance(instance)
    return { success: true }
  })

  ipcMain.handle('mc:stopAll', async () => {
    for (const instance of instances.values()) {
      if (instance.status === 'running' || instance.status === 'starting' || instance.status === 'stopping') {
        stopInstance(instance)
      }
    }
    return { success: true }
  })

  ipcMain.handle('mc:getInstance', async (_event, id: string) => {
    const instance = instances.get(id)
    if (!instance) return null
    return serializeInstance(instance)
  })

  ipcMain.handle('mc:listInstances', async () => {
    return Array.from(instances.values()).map(serializeInstance)
  })

  ipcMain.handle('mc:runtimeStatus', async (_event, instanceId?: string) => {
    const instance = resolveBridgeInstance(instanceId)
    if (!instance) return { ready: false, failureCode: 'observer_bridge_unavailable', error: '没有运行中的 Minecraft 实例。' }
    return { ...instance.readiness, instanceId: instance.id, status: instance.status }
  })

  ipcMain.handle('mc:getCrashReport', async (_event, crashReportPath: string) => {
    try {
      if (fs.existsSync(crashReportPath)) {
        const content = fs.readFileSync(crashReportPath, 'utf-8')
        return { success: true, content }
      }
      return { success: false, error: 'Crash report not found' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('mc:deleteInstance', async (_event, id: string) => {
    const instance = instances.get(id)
    if (instance?.process) {
      instance.exitReason = 'manual'
      if (process.platform === 'win32' && instance.process.pid) {
        spawn('taskkill', ['/PID', String(instance.process.pid), '/F', '/T'])
      } else {
        instance.process.kill()
      }
    }
    instances.delete(id)
    return { success: true }
  })

  ipcMain.handle('mc:bridgeStatus', async (_event, instanceId?: string) => {
    const instance = resolveBridgeInstance(instanceId)
    if (!instance) {
      return { ready: false, error: '没有运行中的游戏实例' }
    }
    if (!instance.bridge && instance.gameDir) {
      instance.bridge = readBridgeDiscovery(instance.gameDir)
    }
    return {
      ready: Boolean(instance.bridge),
      instanceId: instance.id,
      status: instance.status,
      port: instance.bridge?.port ?? null,
      modVersion: instance.bridge?.modVersion ?? null,
      gameDir: instance.gameDir,
      error: instance.bridge ? undefined : '观测桥尚未就绪（等待 modcrafting-bridge.json）'
    }
  })

  ipcMain.handle(
    'mc:bridgeCall',
    async (
      _event,
      payload: {
        instanceId?: string
        method?: 'GET' | 'POST'
        path: string
        body?: Record<string, unknown>
        timeoutMs?: number
      }
    ) => {
      const instance = resolveBridgeInstance(payload?.instanceId)
      if (!instance) {
        return {
          ok: false,
          status: 0,
          data: {},
          error: '没有运行中的游戏实例，请先 trigger_build({"task":"runClient"})'
        }
      }
      if (!instance.bridge) {
        if (instance.gameDir) {
          instance.bridge = readBridgeDiscovery(instance.gameDir)
        }
        if (!instance.bridge && instance.gameDir && instance.status === 'running') {
          instance.bridge = await waitForBridgeDiscovery(instance.gameDir, 15_000, 400)
        }
      }
      if (!instance.bridge) {
        return {
          ok: false,
          status: 0,
          data: {},
          error:
            '观测桥未就绪。确认 resources/_base_mods/modcrafting-observer.jar 已同步到项目 .modcrafting/base-mods/'
        }
      }
      const method = payload.method === 'POST' ? 'POST' : 'GET'
      const apiPath = String(payload.path || '')
      if (!isAllowedBridgeApiPath(apiPath)) {
        return { ok: false, status: 0, data: {}, error: '桥接路径必须以 /v1/ 或 /v2/ 开头。' }
      }
      const timeoutMs =
        typeof payload.timeoutMs === 'number'
          ? payload.timeoutMs
          : apiPath.includes('screenshot')
            ? 20_000
            : 10_000
      return requestBridge(instance.bridge, method, apiPath, payload.body, timeoutMs)
    }
  )
}

async function attachBridgeWhenReady(instance: McInstance, gameDirAbs: string): Promise<void> {
  const discovery = await waitForBridgeDiscovery(gameDirAbs, 90_000, 500)
  if (instances.get(instance.id) !== instance) return
  if (instance.status !== 'running' && instance.status !== 'starting') return
  if (!discovery) {
    markReadinessFailure(instance, 'observer_bridge_unavailable', 'Observer 未在 90 秒内创建桥接发现文件。')
    return
  }
  instance.bridge = discovery
  instance.readiness.bridgeApiVersions = discovery.apiVersions || []
  const capabilities = await requestBridge(discovery, 'GET', '/v2/capabilities', undefined, 10_000)
  if (!capabilities.ok || capabilities.data.protocolVersion !== 2) {
    markReadinessFailure(instance, 'observer_protocol_incompatible', capabilities.error || 'Observer 未提供 V2 capabilities。')
    return
  }
  instance.readiness.bridgeReady = true
  instance.readiness.bridgeApiVersions = [1, 2]
  if (instance.readiness.missingModIds.length > 0) {
    markReadinessFailure(instance, 'runtime_mods_missing', `Fabric 未加载必需模组: ${instance.readiness.missingModIds.join(', ')}`)
    return
  }
  instance.readiness.phase = 'ready'
  instance.readiness.failureCode = null
  instance.readiness.failureMessage = undefined
  notifyInstanceState(instance.id)
}

function resolveBridgeInstance(instanceId?: string): McInstance | null {
  if (instanceId) {
    return instances.get(instanceId) || null
  }
  const running = Array.from(instances.values()).filter(
    (i) => i.status === 'running' || i.status === 'starting'
  )
  if (running.length === 0) return null
  const withBridge = running.find((i) => i.bridge)
  if (withBridge) return withBridge
  return running.sort((a, b) => (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0))[0]
}

function serializeInstance(instance: McInstance): object {
  return {
    id: instance.id,
    name: instance.name,
    projectPath: instance.projectPath,
    status: instance.status,
    startedAt: instance.startedAt?.toISOString() || null,
    crashedAt: instance.crashedAt?.toISOString() || null,
    crashReportPath: instance.crashReportPath,
    exitReason: instance.exitReason,
    logLength: instance.logBuffer.reduce((acc, s) => acc + s.length, 0),
    gameDir: instance.gameDir,
    bridgeReady: Boolean(instance.bridge),
    bridgePort: instance.bridge?.port ?? null,
    readiness: instance.readiness,
    pid: instance.process?.pid ?? null
  }
}

function notifyInstanceState(id: string): void {
  const instance = instances.get(id)
  if (instance) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('mc:stateChanged', id, serializeInstance(instance))
    })
  }
}
