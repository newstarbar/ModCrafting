import { BrowserWindow, ipcMain } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { loadApiConfigFromUserData } from './api-config'

export interface AutomationOptions {
  enabled: boolean
  discoveryPath?: string
  artifactsPath?: string
  sourceUserDataPath?: string
  allowSavedProvider?: boolean
}

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

interface AutomationEvent {
  cursor: number
  timestamp: number
  runId: string
  event: Record<string, unknown>
}

let options: AutomationOptions = { enabled: false }
let server: http.Server | null = null
let token = ''
let port = 0
let cursor = 0
let runId = ''
let events: AutomationEvent[] = []
let rendererReady = false
const pending = new Map<string, PendingCommand>()

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function readAutomationOptions(sourceUserDataPath?: string): AutomationOptions {
  const enabled = process.argv.includes('--automation')
  return {
    enabled,
    discoveryPath: readArg('--automation-discovery'),
    artifactsPath: readArg('--automation-artifacts'),
    sourceUserDataPath,
    allowSavedProvider: process.argv.includes('--automation-live-provider')
  }
}

export function automationEnabled(): boolean {
  return options.enabled
}

function appendEvent(event: Record<string, unknown>): void {
  if (!options.enabled) return
  const entry: AutomationEvent = { cursor: ++cursor, timestamp: Date.now(), runId, event }
  events.push(entry)
  if (events.length > 2_000) events = events.slice(-2_000)
  if (options.artifactsPath) {
    try {
      fs.mkdirSync(options.artifactsPath, { recursive: true })
      fs.appendFileSync(path.join(options.artifactsPath, 'events.ndjson'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Diagnostics must not make the application unusable.
    }
  }
}

function writeDiscovery(): void {
  if (!options.discoveryPath) return
  const target = path.resolve(options.discoveryPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const payload = JSON.stringify({ version: 1, host: '127.0.0.1', port, token, runId, pid: process.pid })
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, payload, 'utf8')
  fs.renameSync(temp, target)
}

function clearDiscovery(): void {
  if (!options.discoveryPath) return
  try { fs.unlinkSync(path.resolve(options.discoveryPath)) } catch { /* already absent */ }
}

function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization || ''
  return header === `Bearer ${token}`
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new Error('invalid_json')) }
    })
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function waitForRenderer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  while (!rendererReady && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  if (!rendererReady) throw new Error('renderer_not_ready')
}

async function dispatch(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  await waitForRenderer(timeoutMs)
  const id = randomUUID()
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!window) return Promise.reject(new Error('renderer_unavailable'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('renderer_command_timeout'))
    }, Math.max(1_000, Math.min(timeoutMs, 120_000)))
    pending.set(id, { resolve, reject, timer })
    window.webContents.send('automation:command', { id, method, params })
  })
}

export function setupAutomationHandlers(): void {
  ipcMain.handle('automation:reply', (_event, payload: { id?: string; result?: Record<string, unknown>; error?: string }) => {
    const id = String(payload?.id || '')
    const item = pending.get(id)
    if (!item) return { ok: false, error: 'unknown_command' }
    pending.delete(id)
    clearTimeout(item.timer)
    if (payload.error) item.reject(new Error(payload.error))
    else item.resolve(payload.result || { ok: true })
    return { ok: true }
  })
  ipcMain.handle('automation:emit', (_event, event: Record<string, unknown>) => {
    if (event.type === 'renderer_ready') rendererReady = true
    appendEvent(event)
    return { ok: true, cursor }
  })
}

export function startAutomationServer(next: AutomationOptions): void {
  options = next
  if (!options.enabled || server) return
  token = randomBytes(32).toString('hex')
  rendererReady = false
  runId = `automation_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
  server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' })
      const pathname = (req.url || '/').split('?')[0]
      if (req.method === 'GET' && pathname === '/v1/capabilities') {
        const commands = ['configure_provider', 'configure_routing', 'open_project', 'send_turn', 'snapshot', 'cancel', 'respond', 'screenshot']
        if (options.allowSavedProvider) commands.push('use_saved_provider', 'use_saved_providers')
        return send(res, 200, { ok: true, version: 1, runId, commands })
      }
      if (req.method === 'GET' && pathname === '/v1/events') {
        const after = Number(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('after') || 0)
        return send(res, 200, { ok: true, runId, cursor, events: events.filter((entry) => entry.cursor > after) })
      }
      if (req.method === 'GET' && pathname === '/v1/snapshot') {
        const snapshot = await dispatch('snapshot', {}, 10_000)
        return send(res, 200, { ok: true, runId, cursor, snapshot })
      }
      if (req.method === 'POST' && pathname === '/v1/command') {
        const body = await readBody(req)
        const method = String(body.method || '')
        if (!['configure_provider', 'configure_routing', 'use_saved_provider', 'use_saved_providers', 'open_project', 'send_turn', 'snapshot', 'cancel', 'respond', 'screenshot'].includes(method)) {
          return send(res, 400, { ok: false, error: 'unsupported_command' })
        }
        if (method === 'use_saved_provider' || method === 'use_saved_providers') {
          if (!options.allowSavedProvider || !options.sourceUserDataPath) {
            return send(res, 403, { ok: false, error: 'saved_provider_not_enabled' })
          }
          const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
            ? body.params as Record<string, unknown> : {}
          const loaded = loadApiConfigFromUserData(options.sourceUserDataPath, String(params.providerId || '') || undefined)
          if (!loaded.success || !loaded.config) {
            return send(res, 409, { ok: false, error: loaded.error || 'saved_provider_unavailable' })
          }
          const result = await dispatch('configure_provider', loaded.config, Number(body.timeoutMs) || 30_000)
          appendEvent({ type: 'saved_provider_configured', providerId: loaded.config.providerId, model: loaded.config.model })
          return send(res, 200, { ok: true, runId, cursor, result })
        }
        if (method === 'screenshot') {
          const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
          if (!window || !options.artifactsPath) return send(res, 409, { ok: false, error: 'screenshot_unavailable' })
          const image = await window.webContents.capturePage()
          const dir = path.join(options.artifactsPath, 'screenshots')
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, `ui-${Date.now()}.png`)
          fs.writeFileSync(file, image.toPNG())
          appendEvent({ type: 'screenshot', path: file })
          return send(res, 200, { ok: true, runId, cursor, result: { path: file } })
        }
        const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
          ? body.params as Record<string, unknown> : {}
        const result = await dispatch(method, params, Number(body.timeoutMs) || 30_000)
        return send(res, 200, { ok: true, runId, cursor, result })
      }
      if (req.method === 'POST' && pathname === '/v1/shutdown') {
        send(res, 200, { ok: true })
        setTimeout(() => BrowserWindow.getAllWindows().forEach((window) => window.close()), 10)
        return
      }
      return send(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      return send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server?.address()
    if (address && typeof address === 'object') {
      port = address.port
      writeDiscovery()
      appendEvent({ type: 'bridge_ready', port })
    }
  })
}

export function stopAutomationServer(): void {
  for (const [id, item] of pending) {
    clearTimeout(item.timer)
    item.reject(new Error('automation_stopped'))
    pending.delete(id)
  }
  if (server) server.close()
  server = null
  clearDiscovery()
  port = 0
  token = ''
  rendererReady = false
}
