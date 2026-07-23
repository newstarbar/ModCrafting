import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'

export const BRIDGE_DISCOVERY_FILE = 'modcrafting-bridge.json'

export interface BridgeDiscovery {
  version: number
  port: number
  token: string
  modVersion?: string
}

export interface BridgeCallResult {
  ok: boolean
  status: number
  data: Record<string, unknown>
  error?: string
}

export function bridgeDiscoveryPath(gameDirAbs: string): string {
  return path.join(gameDirAbs, BRIDGE_DISCOVERY_FILE)
}

export function clearBridgeDiscovery(gameDirAbs: string): void {
  try {
    fs.unlinkSync(bridgeDiscoveryPath(gameDirAbs))
  } catch {
    // ignore missing
  }
}

export function readBridgeDiscovery(gameDirAbs: string): BridgeDiscovery | null {
  const file = bridgeDiscoveryPath(gameDirAbs)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BridgeDiscovery>
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      port: parsed.port,
      token: parsed.token,
      modVersion: typeof parsed.modVersion === 'string' ? parsed.modVersion : undefined
    }
  } catch {
    return null
  }
}

/** Poll until discovery file appears or timeout. */
export async function waitForBridgeDiscovery(
  gameDirAbs: string,
  timeoutMs = 90_000,
  intervalMs = 500
): Promise<BridgeDiscovery | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const discovery = readBridgeDiscovery(gameDirAbs)
    if (discovery) return discovery
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return readBridgeDiscovery(gameDirAbs)
}

export async function requestBridge(
  discovery: BridgeDiscovery,
  method: 'GET' | 'POST',
  apiPath: string,
  body?: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<BridgeCallResult> {
  const pathWithQuery = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  const payload = body ? JSON.stringify(body) : undefined

  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: discovery.port,
        path: pathWithQuery,
        method,
        headers: {
          Authorization: `Bearer ${discovery.token}`,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) }
            : {})
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          let data: Record<string, unknown> = {}
          try {
            data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
          } catch {
            data = { ok: false, code: 'BAD_JSON', error: text.slice(0, 500) }
          }
          const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300 && data.ok !== false
          resolve({
            ok,
            status: res.statusCode || 0,
            data,
            error: ok ? undefined : String(data.error || data.code || `HTTP ${res.statusCode}`)
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, data: {}, error: `桥接请求超时（${timeoutMs}ms）` })
    })
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, data: {}, error: `桥接连接失败: ${err.message}` })
    })

    if (payload) req.write(payload)
    req.end()
  })
}
