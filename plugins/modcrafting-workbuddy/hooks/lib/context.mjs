/**
 * Shared helpers for the WorkBuddy hooks.
 *
 * Two hard rules for every hook in this directory:
 *  1. Exit code 0, always. Exit code 2 blocks the host tool call, so an unexpected crash here
 *     would silently disable ModCrafting. Failures are swallowed, never escalated.
 *  2. Read-only unless explicitly stated. Nothing here may construct SessionRegistry: its
 *     constructor rewrites orphaned jobs, and a hook must never mutate runtime state.
 */
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Must resolve to exactly the directory the MCP server uses (see src/mcp-server.ts), otherwise
 * the hooks would read a different session store than the one the tools write.
 * `${CODEBUDDY_PLUGIN_DATA}` arrives as argv[2] because hosts substitute it in the command
 * string before spawning, and do not necessarily export it as an environment variable.
 */
export function dataRoot() {
  for (const candidate of [process.argv[2], process.env.MODCRAFTING_DATA, process.env.PLUGIN_DATA, process.env.CODEX_PLUGIN_DATA]) {
    if (typeof candidate === 'string' && candidate.trim() && path.isAbsolute(candidate)) return candidate
  }
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ModCrafting', 'fabric-plugin')
}

function parse(raw) {
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

/** Never blocks: settles on stdin end, on 4MB, or after `timeoutMs`. */
export function readPayload(timeoutMs = 900) {
  return new Promise((resolve) => {
    let raw = '', settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.off('end', done)
      try { process.stdin.pause() } catch { /* already closed */ }
      resolve(parse(raw))
    }
    const onData = (chunk) => { raw += chunk; if (raw.length > 4 * 1024 * 1024) done() }
    const timer = setTimeout(done, timeoutMs)
    if (process.stdin.isTTY) { done(); return }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.on('end', done)
    process.stdin.resume()
  })
}

/** Active session records, newest first. Purely read-only: no locks, no rewrites. */
export function activeSessions(root, limit = 40) {
  try {
    const directory = path.join(root, 'sessions')
    return readdirSync(directory)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .slice(0, limit)
      .map((name) => { try { return JSON.parse(readFileSync(path.join(directory, name), 'utf8')) } catch { return undefined } })
      .filter((record) => record && record.schemaVersion === 1 && record.status === 'active')
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  } catch { return [] }
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (cause) { return cause?.code === 'EPERM' }
}

/** Runs `work` and always terminates the hook with exit code 0. */
export function guarded(work) {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    try { process.stdin.pause(); process.stdin.destroy() } catch { /* already closed */ }
    process.exitCode = 0
  }
  process.on('uncaughtException', finish)
  process.on('unhandledRejection', finish)
  const timer = setTimeout(finish, 4000)
  timer.unref()
  Promise.resolve().then(work).then(() => { clearTimeout(timer); finish() }, () => { clearTimeout(timer); finish() })
}
