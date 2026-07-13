import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as net from 'net'
import { detectOpenCode, resolveOpenCodeCommand } from './opencode-bridge.ts'

export interface OpenCodeServerState {
  running: boolean
  url?: string
  port?: number
  projectPath?: string
  version?: string
  error?: string
}

interface ActiveServer {
  proc: ChildProcess
  url: string
  port: number
  projectPath: string
  abort: AbortController
  // Optional @opencode-ai/sdk client when package is present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdkClient?: any
}

let active: ActiveServer | null = null
const bus = new EventEmitter()

export function getOpenCodeServerState(): OpenCodeServerState {
  if (!active) return { running: false }
  return {
    running: true,
    url: active.url,
    port: active.port,
    projectPath: active.projectPath
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 4096
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function waitForHealth(baseUrl: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`)
      if (res.ok) {
        const data = (await res.json()) as { healthy?: boolean; version?: string }
        if (data.healthy) return data.version || 'unknown'
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`OpenCode server did not become healthy within ${timeoutMs}ms`)
}

function spawnServe(port: number, projectPath: string, config?: Record<string, unknown>): ChildProcess {
  const command = resolveOpenCodeCommand()
  const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`]
  const env = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}),
    PWD: projectPath
  }
  return spawn(command, args, {
    cwd: projectPath,
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function tryCreateSdkClient(baseUrl: string): Promise<ActiveServer['sdkClient']> {
  try {
    const mod = await import('@opencode-ai/sdk')
    if (typeof mod.createOpencodeClient === 'function') {
      return mod.createOpencodeClient({ baseUrl })
    }
  } catch {
    // optional dependency may be missing; HTTP fallback remains
  }
  return undefined
}

export async function startOpenCodeServer(
  projectPath: string,
  config?: Record<string, unknown>
): Promise<OpenCodeServerState> {
  const detect = await detectOpenCode()
  if (!detect.installed) {
    return { running: false, error: detect.error || 'OpenCode not installed' }
  }

  if (active) {
    if (active.projectPath === projectPath) {
      return getOpenCodeServerState()
    }
    await stopOpenCodeServer()
  }

  const port = await pickFreePort()
  const url = `http://127.0.0.1:${port}`
  const proc = spawnServe(port, projectPath, config)
  const abort = new AbortController()

  active = { proc, url, port, projectPath, abort }

  proc.stdout?.on('data', (chunk: Buffer) => {
    bus.emit('log', chunk.toString())
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    bus.emit('log', chunk.toString())
  })
  proc.on('exit', (code) => {
    bus.emit('exit', code)
    if (active?.proc === proc) active = null
  })

  void subscribeEvents(url, abort.signal)

  try {
    const version = await waitForHealth(url)
    if (active) {
      active.sdkClient = await tryCreateSdkClient(url)
    }
    return { running: true, url, port, projectPath, version }
  } catch (err) {
    await stopOpenCodeServer()
    return {
      running: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function subscribeEvents(baseUrl: string, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/event`, {
      headers: { Accept: 'text/event-stream' },
      signal
    })
    if (!res.ok || !res.body) return

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const json = dataLine.slice(5).trim()
        if (!json) continue
        try {
          bus.emit('event', JSON.parse(json))
        } catch {
          bus.emit('event', { type: 'raw', properties: { raw: json } })
        }
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      bus.emit('error', err instanceof Error ? err.message : String(err))
    }
  }
}

export function onOpenCodeBusEvent(listener: (payload: unknown) => void): () => void {
  const handler = (payload: unknown) => listener(payload)
  bus.on('event', handler)
  bus.on('error', handler)
  return () => {
    bus.off('event', handler)
    bus.off('error', handler)
  }
}

export async function stopOpenCodeServer(): Promise<void> {
  if (!active) return
  const { proc, abort, url } = active
  abort.abort()
  active = null
  try {
    await fetch(`${url}/instance/dispose`, { method: 'POST' }).catch(() => {})
  } catch {
    // ignore
  }
  if (!proc.killed) {
    proc.kill()
  }
}

export async function opencodeFetch(
  method: string,
  apiPath: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  if (!active) return { ok: false, status: 0, error: 'OpenCode server not running' }
  try {
    const res = await fetch(`${active.url}${apiPath}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      // keep text
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : String(data) }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function createOpenCodeSession(title?: string): Promise<{ id?: string; error?: string }> {
  const client = active?.sdkClient
  if (client?.session?.create) {
    try {
      const result = await client.session.create({ title: title || 'ModCrafting' })
      const id = result?.data?.id || result?.id
      if (id) return { id }
    } catch (err) {
      bus.emit('log', `SDK session.create failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const res = await opencodeFetch('POST', '/session', { title: title || 'ModCrafting' })
  if (!res.ok) return { error: res.error || `HTTP ${res.status}` }
  const data = res.data as { id?: string } | null
  return { id: data?.id, error: data?.id ? undefined : 'missing session id' }
}

export async function promptOpenCodeSession(
  sessionId: string,
  text: string,
  options?: { agent?: string; noReply?: boolean }
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const client = active?.sdkClient
  if (client?.session?.prompt) {
    try {
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text }],
          agent: options?.agent || 'build',
          noReply: options?.noReply ?? false
        }
      })
      return { ok: true, data: result?.data ?? result }
    } catch (err) {
      bus.emit('log', `SDK session.prompt failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const res = await opencodeFetch('POST', `/session/${sessionId}/message`, {
    parts: [{ type: 'text', text }],
    agent: options?.agent || 'build',
    noReply: options?.noReply ?? false
  })
  return { ok: res.ok, data: res.data, error: res.error }
}

export async function abortOpenCodeSession(sessionId: string): Promise<boolean> {
  const client = active?.sdkClient
  if (client?.session?.abort) {
    try {
      await client.session.abort({ path: { id: sessionId } })
      return true
    } catch {
      // fall through
    }
  }
  const res = await opencodeFetch('POST', `/session/${sessionId}/abort`)
  return res.ok
}
