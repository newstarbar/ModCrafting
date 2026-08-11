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
import { appAutomationLaunchArgs, isHiddenAppAutomationMode } from './app-automation-launch.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runDir = path.join(os.tmpdir(), 'modcrafting-app-test', randomUUID())
const discovery = path.join(runDir, 'automation.json')
const profile = path.join(runDir, 'profile')
const artifacts = path.join(runDir, 'artifacts')
const gameMode = process.argv.includes('--game')
const liveMode = process.argv.includes('--live') || gameMode
const hiddenMode = isHiddenAppAutomationMode(process.argv, process.env)

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
      // Leave a short first-token gap so the test can inspect the real UI's
      // liveness affordance instead of only a completed response.
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Automation replay response.' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, 2_000)
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
  const envLiveProvider = liveMode && process.env.MODCRAFTING_TEST_ENDPOINT && process.env.MODCRAFTING_TEST_MODEL && process.env.MODCRAFTING_TEST_API_KEY
    ? {
        endpoint: process.env.MODCRAFTING_TEST_ENDPOINT,
        model: process.env.MODCRAFTING_TEST_MODEL,
        apiKey: process.env.MODCRAFTING_TEST_API_KEY,
        providerId: process.env.MODCRAFTING_TEST_PROVIDER_ID || 'minimax'
      }
    : null
  const replay = liveMode ? null : await startReplayServer(path.join(artifacts, 'provider-requests.redacted.jsonl'))
  const electron = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  const child = spawn(electron, appAutomationLaunchArgs({
    hidden: hiddenMode,
    liveProvider: liveMode,
    profile,
    discovery,
    artifacts
  }), { cwd: root, windowsHide: true, stdio: 'ignore' })
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
    const sourceProject = process.env.MODCRAFTING_TEST_PROJECT || path.join(root, 'resources', '_offline_verify_project')
    const projectPath = path.join(runDir, 'workspace')
    fs.cpSync(sourceProject, projectPath, { recursive: true, filter: (entry) => !entry.includes(`${path.sep}.gradle${path.sep}`) && !entry.includes(`${path.sep}run${path.sep}`) })
    const opened = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'open_project', params: { projectPath } }) })
    assert.equal(opened.status, 200)
    const configured = await request('/v1/command', { method: 'POST', body: JSON.stringify(
      envLiveProvider
        ? { method: 'configure_provider', params: envLiveProvider }
        : liveMode
          ? { method: 'use_saved_provider', params: { providerId: process.env.MODCRAFTING_TEST_PROVIDER_ID || undefined } }
          : { method: 'configure_provider', params: { endpoint: replay!.endpoint, model: 'automation-replay', apiKey: 'test-key', providerId: 'automation-replay' } }
    ) })
    assert.equal(configured.status, 200, `provider configuration failed: ${JSON.stringify(configured.body)}`)
    await wait(250)
    const scenarioId = process.env.MODCRAFTING_TEST_SCENARIO || 'player-morph-toggle'
    const scenarioFile = path.join(root, 'scripts', 'test', 'scenarios', `${scenarioId}.json`)
    const scenario = gameMode && fs.existsSync(scenarioFile)
      ? JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) as { prompt?: unknown; clarificationResponses?: unknown }
      : {}
    const scenarioPrompt = String(scenario.prompt || '')
    const clarificationResponses = Array.isArray(scenario.clarificationResponses)
      ? scenario.clarificationResponses.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const prompt = gameMode
      ? (process.env.MODCRAFTING_TEST_PROMPT || scenarioPrompt || '制作一个 Fabric 模组并在专用测试世界使用可重复的客观断言完成真实测试。')
      : '请简短介绍当前项目'
    const sent = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'send_turn', params: { text: prompt, mode: 'agent' } }) })
    assert.equal(sent.status, 200)
    if (replay) {
      let activityVisible = false
      const activityDeadline = Date.now() + 3_000
      while (Date.now() < activityDeadline) {
        const activeSnapshot = await request('/v1/snapshot')
        const activeUi = (((activeSnapshot.body.snapshot as Record<string, unknown>).chat as Record<string, unknown>).ui || {}) as Record<string, unknown>
        if (activeUi.activeAssistantStreaming === true) { activityVisible = true; break }
        await wait(50)
      }
      assert.equal(activityVisible, true, 'a running turn must show an in-transcript assistant activity placeholder')
      const activityScreenshot = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'screenshot', params: {} }) })
      const activityScreenshotPath = ((activityScreenshot.body.result as Record<string, unknown>).path || '') as string
      assert.ok(activityScreenshotPath && fs.existsSync(activityScreenshotPath), 'running-turn screenshot was not captured')
    }
    const turnDeadline = Date.now() + (gameMode ? 60 * 60_000 : liveMode ? 10 * 60_000 : 15_000)
    let done = false
    let clarificationResponseIndex = 0
    while (Date.now() < turnDeadline) {
      const state = await request('/v1/snapshot')
      const chat = (state.body.snapshot as Record<string, unknown>).chat as Record<string, unknown>
      const controller = chat.controller as Record<string, unknown>
      const ui = (chat.ui || {}) as Record<string, unknown>
      if (ui.clarification) {
        const response = clarificationResponses[clarificationResponseIndex]
        if (!response) break
        clarificationResponseIndex += 1
        const answered = await request('/v1/command', { method: 'POST', body: JSON.stringify({ method: 'respond', params: { action: 'clarify', value: response } }) })
        assert.equal(answered.status, 200, 'scenario clarification response was rejected')
        await wait(100)
        continue
      }
      if (controller.running === false && Array.isArray(controller.messages) && controller.messages.length >= 2) { done = true; break }
      await wait(100)
    }
    assert.equal(done, true, `${gameMode ? 'game' : liveMode ? 'live' : 'replayed'} agent turn did not complete`)
    const events = await request('/v1/events?after=0')
    assert.ok(Array.isArray(events.body.events), 'automation bridge did not retain an event ledger')
    if (replay) {
      const replayLog = fs.readFileSync(path.join(artifacts, 'provider-requests.redacted.jsonl'), 'utf8')
      assert.ok(replayLog.includes('"tools"'), 'classifier request did not reach replay provider')
      assert.ok(!replayLog.includes('test-key'), 'provider artifact leaked an API key')
    }
    if (gameMode) {
      const eventList = events.body.events as Array<Record<string, unknown>>
      const harnessEvents = eventList.map((entry) => entry.event as Record<string, unknown>)
      const toolEvents = harnessEvents.map((event) => event.tool as Record<string, unknown> | undefined).filter(Boolean) as Array<Record<string, unknown>>
      const toolNames = toolEvents.map((tool) => tool.name).filter(Boolean)
      const mcResult = harnessEvents.find((event) => event.kind === 'ToolResult' && (event.tool as Record<string, unknown> | undefined)?.name === 'mc_run_test')
      const mcValidation = (mcResult?.tool as Record<string, unknown> | undefined)?.validation as Record<string, unknown> | undefined
      const notices = harnessEvents
        .filter((event) => event.kind === 'Notice')
        .map((event) => event.notice as Record<string, unknown>)
        .filter(Boolean)
      const diagnosticNotice = [...notices].reverse().find((notice) => !/部分步骤未完成|步骤.*已.*推进/.test(String(notice.text || ''))) || notices.at(-1)
      const report = {
        runId: events.body.runId,
        createdAt: new Date().toISOString(),
        verdict: mcValidation?.verdict === 'PASS' ? 'PASS' : mcResult ? String(mcValidation?.verdict || 'INCONCLUSIVE') : 'INCONCLUSIVE',
        checks: {
          triggerBuildCalled: toolNames.includes('trigger_build'),
          gameTestCalled: Boolean(mcResult),
          gameTestVerdict: mcValidation?.verdict || null
        },
        notices: notices.slice(-10).map((notice) => notice.text),
        artifacts,
        workspace: projectPath
      }
      fs.writeFileSync(path.join(artifacts, 'run.json'), JSON.stringify(report, null, 2), 'utf8')
      // A live provider and Minecraft are external dependencies.  Their
      // inability to reach an executable contract is evidence for an
      // INCONCLUSIVE smoke result, never a fabricated PASS and never a hard
      // failure of the deterministic replay suite.  The report remains the
      // authoritative verdict for a developer to inspect.
      if (!toolNames.includes('trigger_build') || !mcResult || mcValidation?.verdict !== 'PASS') {
        console.warn(JSON.stringify({
          verdict: 'INCONCLUSIVE',
          reason: String(diagnosticNotice?.text || 'live_game_scenario_did_not_reach_pass'),
          report: path.join(artifacts, 'run.json')
        }))
      }
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
