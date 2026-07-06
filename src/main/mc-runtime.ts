import { ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as iconv from 'iconv-lite'
import { ensureJdkReady, isGradleHomeSeedReady, prepareBuild, purgeGradleEphemeralCaches } from './build-env'

const LOG_BUFFER_MAX_LINES = 500

const platformEncoding = process.platform === 'win32' ? 'gbk' : 'utf-8'

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
    logBuffer: []
  }
  instances.set(id, instance)
  notifyInstanceState(id)
  return instance
}

async function startInstance(id: string): Promise<{ success: boolean; error?: string }> {
  const instance = instances.get(id)
  if (!instance) return { success: false, error: 'Instance not found' }
  if (instance.status === 'running' || instance.status === 'starting') {
    return { success: false, error: 'Instance is already running' }
  }

  const buildPrep = await prepareBuild(instance.projectPath)
  if (!buildPrep.ok) {
    const jdkFallback = await ensureJdkReady()
    if (!jdkFallback.ok) {
      return { success: false, error: buildPrep.error || jdkFallback.error || 'JDK 未就绪' }
    }
  }

  instance.status = 'starting'
  instance.startedAt = new Date()
  instance.crashedAt = null
  instance.crashReportPath = null
  instance.exitReason = 'none'
  instance.logBuffer = []
  notifyInstanceState(id)

  const gradlew = path.join(instance.projectPath, 'gradlew.bat')
  const cmd = fs.existsSync(gradlew) ? gradlew : 'gradle'
  const offlineFlags = isGradleHomeSeedReady() ? '--offline' : '-Dorg.gradle.offline=false'
  const gameDirAbs = instanceGameDirAbs(instance.projectPath, id)
  fs.mkdirSync(path.join(gameDirAbs, 'mods'), { recursive: true })
  ensureGameOptions(gameDirAbs)

  const sharedGradleHome = buildPrep.env?.GRADLE_USER_HOME
  if (typeof sharedGradleHome === 'string') {
    purgeGradleEphemeralCaches(sharedGradleHome)
    const staleInstanceHome = path.join(sharedGradleHome, 'mc-instances', id)
    if (fs.existsSync(staleInstanceHome)) {
      try {
        fs.rmSync(staleInstanceHome, { recursive: true, force: true })
      } catch {
        // continue with junction setup even if stale instance dir could not be removed
      }
    }
  }

  const instanceEnv = buildInstanceGradleEnv(buildPrep.env || process.env, id)
  const gameDirArg = quoteGameDirArg(gameDirAbs)
  const fullCmd = `"${cmd}" ${offlineFlags} runClient --no-daemon --args="--gameDir ${gameDirArg}"`

  try {
    const proc = spawn(fullCmd, {
      cwd: instance.projectPath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: instanceEnv
    })

    instance.process = proc

    const handleOutput = (text: string): void => {
      appendLog(instance, text)
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
      const payload = lines.length > 0 ? lines : [text]
      for (const line of payload) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('mc:log', id, line + '\n')
        })
      }
      if (instance.status === 'starting' && isClientStarted(text)) {
        instance.status = 'running'
        notifyInstanceState(id)
      }
    }

    proc.stdout?.on('data', (data: Buffer) => handleOutput(decodeBuffer(data)))
    proc.stderr?.on('data', (data: Buffer) => handleOutput(decodeBuffer(data)))

    proc.on('exit', (code) => {
      const wasManual = instance.exitReason === 'manual'
      instance.process = null
      instance.startedAt = null

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
        purgeGradleEphemeralCaches(sharedGradleHome)
      }
    })

    proc.on('error', (err) => {
      instance.process = null
      instance.status = 'crashed'
      instance.exitReason = 'start_failed'
      instance.crashedAt = new Date()
      if (typeof sharedGradleHome === 'string') {
        purgeGradleEphemeralCaches(sharedGradleHome)
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

  ipcMain.handle('mc:startOrCreate', async (_event, projectPath: string, name?: string) => {
    const existing = Array.from(instances.values()).find(
      (i) => i.projectPath === projectPath && (i.status === 'stopped' || i.status === 'crashed')
    )
    const instance = existing || createInstanceRecord(projectPath, name)
    const result = await startInstance(instance.id)
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
    logLength: instance.logBuffer.reduce((acc, s) => acc + s.length, 0)
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
