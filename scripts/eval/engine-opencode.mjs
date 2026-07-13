/**
 * Drive OpenCode via `opencode serve` + HTTP for headless eval.
 */
import { spawn } from 'child_process'
import net from 'net'

function resolveOpenCodeBin() {
  return process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
}

function pickFreePort() {
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

async function waitHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`)
      if (res.ok) {
        const data = await res.json()
        if (data.healthy) return data.version || 'ok'
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`OpenCode server unhealthy after ${timeoutMs}ms`)
}

async function api(baseUrl, method, apiPath, body) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep text
  }
  if (!res.ok) {
    throw new Error(
      `OpenCode ${method} ${apiPath} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`
    )
  }
  return data
}

function buildConfigContent(env) {
  // OpenCode Zen free tier (see https://opencode.ai/docs/zen/)
  const DEFAULT_MODEL = 'opencode/deepseek-v4-flash-free'
  const model = env.OPENCODE_MODEL || env.MODCRAFTING_EVAL_MODEL || DEFAULT_MODEL
  return {
    $schema: 'https://opencode.ai/config.json',
    model
  }
}

/**
 * @param {{ projectDir: string, prompt: string, agent?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv }} opts
 */
export async function runOpenCodeTask(opts) {
  const env = { ...process.env, ...(opts.env || {}) }
  const bin = resolveOpenCodeBin()
  const port = await pickFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const config = buildConfigContent(env)
  const timeoutMs = opts.timeoutMs || 600_000

  const proc = spawn(bin, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    cwd: opts.projectDir,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      // Common provider env aliases — OpenCode / providers often read these
      OPENAI_API_KEY: env.OPENAI_API_KEY || env.OPENCODE_API_KEY || env.MODCRAFTING_EVAL_API_KEY || env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
      PWD: opts.projectDir
    },
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let logs = ''
  proc.stdout?.on('data', (d) => { logs += d.toString() })
  proc.stderr?.on('data', (d) => { logs += d.toString() })

  const started = Date.now()
  let agentOutput = ''
  let error

  try {
    await waitHealth(baseUrl)
    const session = await api(baseUrl, 'POST', '/session', { title: `eval-${Date.now()}` })
    const sessionId = session.id
    if (!sessionId) throw new Error('session create missing id')

    const agent = opts.agent || 'build'
    const result = await Promise.race([
      api(baseUrl, 'POST', `/session/${sessionId}/message`, {
        parts: [{ type: 'text', text: opts.prompt }],
        agent,
        noReply: false
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`prompt timeout ${timeoutMs}ms`)), timeoutMs)
      )
    ])

    agentOutput = extractText(result)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await fetch(`${baseUrl}/instance/dispose`, { method: 'POST' }).catch(() => {})
    } catch {
      // ignore
    }
    if (!proc.killed) proc.kill()
  }

  return {
    ok: !error,
    error,
    agentOutput,
    durationMs: Date.now() - started,
    logs: logs.slice(-4000)
  }
}

function extractText(result) {
  if (!result) return ''
  if (typeof result === 'string') return result
  const parts = []
  const seen = new WeakSet()
  const walk = (node) => {
    if (!node) return
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node.text === 'string') parts.push(node.text)
    if (typeof node.content === 'string') parts.push(node.content)
    for (const v of Object.values(node)) walk(v)
  }
  walk(result)
  return parts.join('\n').slice(0, 50_000)
}

export async function detectOpenCodeCli() {
  const bin = resolveOpenCodeBin()
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--version'], {
      shell: process.platform === 'win32',
      windowsHide: true
    })
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.stderr?.on('data', (d) => { out += d.toString() })
    proc.on('error', (err) => resolve({ installed: false, error: String(err) }))
    proc.on('close', (code) => {
      resolve({
        installed: code === 0,
        version: out.trim().split('\n')[0],
        error: code === 0 ? undefined : out.trim()
      })
    })
  })
}
