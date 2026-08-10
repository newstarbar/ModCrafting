#!/usr/bin/env node
/** Minimal real-Electron regression for the local automation bridge. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runDir = path.join(os.tmpdir(), 'modcrafting-app-test', randomUUID())
const discovery = path.join(runDir, 'automation.json')
const profile = path.join(runDir, 'profile')
const artifacts = path.join(runDir, 'artifacts')
const liveMode = process.argv.includes('--live')

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const classifierResult = {
  intent: 'chat',
  isInGameVerifyRequest: false,
  skipFormalPlan: false,
  isUserSymptom: false,
  isSymptomResolved: false,
  isErrorReport: false,
  isGuiFeatureSymptom: false,
  verifyTarget: null,
  rationale: 'automation replay'
}

/** A local OpenAI-compatible server used to exercise the real classifier + stream path. */
async function startReplayServer(logFile: string): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      requests.push({ method: req.method, url: req.url, hasAuthorization: Boolean(req.headers.authorization), body: payload })
      fs.writeFileSync(logFile, JSON.stringify(requests, null, 2), 'utf8')
      if (Array.isArray(payload.tools)) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'classification', type: 'function', function: { name: 'classify_user_turn', arguments: JSON.stringify(classifierResult) } }] } }] }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Automation replay response.' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

async function main(): Promise<void> {
  assert.ok(fs.existsSync(path.join(root, 'out', 'main', 'index.js')), 'run npm run build before npm run test:app')
  fs.mkdirSync(artifacts, { recursive: true })
  const liveProvider = liveMode
    ? {
        endpoint: process.env.MODCRAFTING_TEST_ENDPOINT || '',
        model: process.env.MODCRAFTING_TEST_MODEL || '',
        apiKey: process.env.MODCRAFTING_TEST_API_KEY || '',
        providerId: process.env.MODCRAFTING_TEST_PROVIDER_ID || 'minimax'
      }
    : null
  if (liveProvider) {
    assert.ok(liveProvider.endpoint && liveProvider.model && liveProvider.apiKey, 'test:app:live requires MODCRAFTING_TEST_ENDPOINT, MODCRAFTING_TEST_MODEL and MODCRAFTING_TEST_API_KEY')
  }
  const replay = liveProvider ? null : await startReplayServer(path.join(artifacts, 'provider-requests.redacted.jsonl'))
  const electron = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  const child = spawn(electron, ['.', '--automation', '--automation-hidden', '--automation-profile', profile, '--automation-discovery', discovery, '--automation-artifacts', artifacts], { cwd: root, windowsHide: true, stdio: 'ignore' })
  try {
    const deadline = Date.now() + 30_000
    let bridge: { host: string; port: number; token: string } | null = null
    while (Date.now() < deadline) {
      try { bridge = JSON.parse(fs.readFileSync(discovery, 'utf8')) } catch { await wait(100) }
      if (bridge?.token) break
    }
    assert.ok(bridge?.token, 'automation discovery was not written')
    const unauthorized = await fetch(`http://${bridge!.host}:${bridge!.port}/v1/capabilities`)
    assert.equal(unauthorized.status, 401, 'automation endpoints must require the per-run bearer token')
    const request = async (pathname: string, init: RequestInit = {}) => {
      const res = await fetch(`http://${bridge!.host}:${bridge!.port}${pathname}`, { ...init, headers: { Authorization: `Bearer ${bridge!.token}`, 'content-type': 'application/json' } })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    const capabilities = await request('/v1/capabilities')
    assert.equal(capabilities.status, 200)
    assert.equal(capabilities.body.ok, true)
    const projectPath = path.join(root, 'resources', '_offline_verify_project')
    const opened = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'open_project', params: { projectPath } }) })
    assert.equal(opened.status, 200)
    const configured = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'configure_provider', params: liveProvider || { endpoint: replay!.endpoint, model: 'automation-replay', apiKey: 'test-key', providerId: 'automation-replay' } }) })
    assert.equal(configured.status, 200)
    await wait(250)
    const sent = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'send_turn', params: { text: '请简短介绍当前项目', mode: 'agent' } }) })
    assert.equal(sent.status, 200)
    const turnDeadline = Date.now() + 15_000
    let done = false
    while (Date.now() < turnDeadline) {
      const state = await request('/v1/snapshot')
      const controller = ((state.body.snapshot as Record<string, unknown>).chat as Record<string, unknown>).controller as Record<string, unknown>
      if (controller.running === false && Array.isArray(controller.messages) && controller.messages.length >= 2) { done = true; break }
      await wait(100)
    }
    assert.equal(done, true, 'replayed chat turn did not complete')
    const events = await request('/v1/events?after=0')
    assert.ok(Array.isArray(events.body.events), 'automation bridge did not retain an event ledger')
    if (replay) {
      const replayLog = fs.readFileSync(path.join(artifacts, 'provider-requests.redacted.jsonl'), 'utf8')
      assert.ok(replayLog.includes('"tools"'), 'classifier request did not reach replay provider')
      assert.ok(!replayLog.includes('test-key'), 'provider artifact leaked an API key')
    }
    const snap = await request('/v1/snapshot')
    assert.equal(snap.status, 200)
    assert.equal((snap.body.snapshot as Record<string, unknown>).app && true, true)
    console.log(JSON.stringify({ ok: true, artifacts }))
  } finally {
    child.kill()
    await replay?.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
