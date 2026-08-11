#!/usr/bin/env node
/** Development-only MCP facade for the authenticated ModCrafting automation bridge. */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runsRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ModCrafting Test Lab', 'runs')
const scenariosRoot = path.join(root, 'scripts', 'test', 'scenarios')

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

interface TestRun {
  id: string
  directory: string
  discovery: string
  profile: string
  artifacts: string
  child: ChildProcess
  bridge?: { host: string; port: number; token: string; runId: string }
}

let active: TestRun | null = null

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> }
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: message, ...extra }, null, 2) }], isError: true }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitForDiscovery(file: string, timeoutMs = 30_000): Promise<NonNullable<TestRun['bridge']>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed.host && parsed.port && parsed.token) return parsed
    } catch { /* bridge has not written discovery yet */ }
    await sleep(100)
  }
  throw new Error('automation_bridge_not_ready')
}

async function bridgeFetch(run: TestRun, pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!run.bridge) throw new Error('automation_not_launched')
  const response = await fetch(`http://${run.bridge.host}:${run.bridge.port}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${run.bridge.token}`, 'content-type': 'application/json', ...(init.headers || {}) }
  })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok || body.ok === false) throw new Error(String(body.error || `bridge_http_${response.status}`))
  return body
}

function createRun(): TestRun {
  const id = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  const directory = path.join(runsRoot, id)
  const artifacts = path.join(directory, 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(path.join(artifacts, 'run.json'), JSON.stringify({ runId: id, startedAt: new Date().toISOString(), status: 'running' }, null, 2), 'utf8')
  fs.writeFileSync(path.join(artifacts, 'provider-requests.redacted.jsonl'), '', 'utf8')
  return {
    id,
    directory,
    discovery: path.join(directory, 'automation-discovery.json'),
    profile: path.join(directory, 'profile'),
    artifacts,
    child: null as unknown as ChildProcess
  }
}

async function launch(visible = true, liveProvider = false): Promise<TestRun> {
  if (active) return active
  const run = createRun()
  const electron = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
    throw new Error('app_not_built: run npm run build first')
  }
  run.child = spawn(electron, ['.', '--automation', '--automation-profile', run.profile, '--automation-discovery', run.discovery, '--automation-artifacts', run.artifacts, ...(liveProvider ? ['--automation-live-provider'] : []), ...(visible ? [] : ['--automation-hidden'])], {
    cwd: root,
    windowsHide: !visible,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const log = fs.createWriteStream(path.join(run.artifacts, 'process.log'), { flags: 'a' })
  run.child.stdout?.pipe(log)
  run.child.stderr?.pipe(log)
  run.bridge = await waitForDiscovery(run.discovery)
  active = run
  return run
}

function copyWorkspace(sourcePath: string, run: TestRun): string {
  const source = path.resolve(sourcePath)
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('project_source_not_found')
  const destination = path.join(run.directory, 'workspace')
  if (!fs.existsSync(destination)) fs.cpSync(source, destination, { recursive: true, filter: (entry) => !entry.includes(`${path.sep}.gradle${path.sep}`) && !entry.includes(`${path.sep}run${path.sep}`) })
  const patchPath = path.join(run.artifacts, 'workspace.patch')
  if (!fs.existsSync(patchPath)) fs.writeFileSync(patchPath, '# Workspace patch is populated by scenario diff collection.\n', 'utf8')
  return destination
}

interface ScenarioFixture {
  id: string
  fixturePath: string
  prompt: string
  mode?: 'agent' | 'plan' | 'ask'
  assertions: Array<Record<string, unknown>>
  acceptanceContract?: Record<string, unknown>
  clarificationResponses?: string[]
  timeoutMs?: number
}

function loadScenarioFixture(value: string): ScenarioFixture {
  const candidate = value.endsWith('.json') ? path.resolve(value) : path.join(scenariosRoot, `${value}.json`)
  if (!candidate.startsWith(`${scenariosRoot}${path.sep}`)) throw new Error('scenario_must_be_under_test_lab_root')
  const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as ScenarioFixture
  if (!parsed.id || !parsed.fixturePath || !parsed.prompt || !Array.isArray(parsed.assertions)) throw new Error('invalid_scenario_fixture')
  return parsed
}

async function command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!active) throw new Error('automation_not_launched')
  const body = await bridgeFetch(active, '/v1/command', { method: 'POST', body: JSON.stringify({ method, params }) })
  return body.result as Record<string, unknown>
}

async function snapshot(): Promise<Record<string, unknown>> {
  if (!active) throw new Error('automation_not_launched')
  const body = await bridgeFetch(active, '/v1/snapshot')
  const value = body.snapshot as Record<string, unknown>
  const directory = path.join(active.artifacts, 'snapshots')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `snapshot-${Date.now()}.json`), JSON.stringify(value, null, 2), 'utf8')
  return value
}

async function waitFor(condition: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    last = await snapshot()
    const controller = ((last.chat as Record<string, unknown> | null)?.controller || {}) as Record<string, unknown>
    if (condition === 'idle' && controller.running === false) return { matched: true, snapshot: last }
    if (condition === 'turn_done' && controller.running === false && Array.isArray(controller.messages) && controller.messages.length > 0) return { matched: true, snapshot: last }
    await sleep(250)
  }
  return { matched: false, snapshot: last }
}

async function waitForScenarioCompletion(timeoutMs: number, clarificationResponses: string[] = []): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> = {}
  let responseIndex = 0
  while (Date.now() < deadline) {
    last = await snapshot()
    const chat = (last.chat || {}) as Record<string, unknown>
    const controller = (chat.controller || {}) as Record<string, unknown>
    const ui = (chat.ui || {}) as Record<string, unknown>
    const clarification = ui.clarification as Record<string, unknown> | null | undefined
    if (clarification) {
      const response = clarificationResponses[responseIndex]
      if (!response) return { matched: false, reason: 'scenario_clarification_unanswered', snapshot: last, clarification }
      responseIndex += 1
      await command('respond', { action: 'clarify', value: response })
      await sleep(100)
      continue
    }
    if (controller.running === false && Array.isArray(controller.messages) && controller.messages.length > 0) {
      return { matched: true, snapshot: last, clarificationResponsesUsed: responseIndex }
    }
    await sleep(250)
  }
  return { matched: false, reason: 'turn_timeout_or_environment_unavailable', snapshot: last }
}

async function stop(preserveArtifacts = true): Promise<Record<string, unknown>> {
  if (!active) return { stopped: false }
  const run = active
  try { await bridgeFetch(run, '/v1/shutdown', { method: 'POST', body: '{}' }) } catch { /* process may already have exited */ }
  if (!run.child.killed) run.child.kill()
  active = null
  return { stopped: true, runId: run.id, artifacts: preserveArtifacts ? run.artifacts : undefined }
}

function evaluateAssertions(events: Array<Record<string, unknown>>, currentSnapshot: Record<string, unknown>, assertions: Array<Record<string, unknown>>): { verdict: Verdict; assertions: Array<Record<string, unknown>> } {
  const results = assertions.map((assertion) => {
    const type = String(assertion.type || '')
    if (type === 'event_kind') {
      const found = events.some((entry) => (entry.event as Record<string, unknown>)?.kind === assertion.kind)
      return { ...assertion, passed: found }
    }
    if (type === 'tool_called') {
      const found = events.some((entry) => ((entry.event as Record<string, unknown>)?.tool as Record<string, unknown> | undefined)?.name === assertion.name)
      return { ...assertion, passed: found }
    }
    if (type === 'plan_step') {
      const controller = ((currentSnapshot.chat as Record<string, unknown> | null)?.controller || {}) as Record<string, unknown>
      const found = Array.isArray(controller.planSteps) && controller.planSteps.some((step: Record<string, unknown>) => step.id === assertion.id && (!assertion.status || step.status === assertion.status))
      return { ...assertion, passed: found }
    }
    return { ...assertion, passed: false, error: 'unknown_assertion' }
  })
  return { verdict: results.every((result) => result.passed) ? 'PASS' : 'FAIL', assertions: results }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'modcrafting-test-lab', version: '1.0.0' })
  server.registerTool('modcrafting_launch', { description: 'Launch an isolated ModCrafting automation instance.', inputSchema: z.object({ visible: z.boolean().default(true), liveProvider: z.boolean().default(false) }) }, async ({ visible, liveProvider }) => {
    try { const run = await launch(visible, liveProvider); return text({ ok: true, runId: run.id, artifacts: run.artifacts, liveProvider }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_configure_provider', { description: 'Configure an in-memory local replay provider for the isolated test app. This tool never accepts a real API key.', inputSchema: z.object({ endpoint: z.string().url(), model: z.string().min(1), providerId: z.string().min(1).default('automation-replay') }) }, async (params) => {
    try {
      const result = await command('configure_provider', { ...params, apiKey: 'test-key' })
      await sleep(50)
      return text({ ok: true, ...result })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_use_saved_provider', { description: 'Use the primary ModCrafting profile provider in an explicitly live-enabled isolated run. The API key never crosses MCP.', inputSchema: z.object({ providerId: z.string().min(1).optional() }) }, async (params) => {
    try { return text({ ok: true, ...(await command('use_saved_provider', params)) }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_open_project', { description: 'Copy a project into the active sandbox and open it in ModCrafting.', inputSchema: z.object({ sourcePath: z.string().min(1) }) }, async ({ sourcePath }) => {
    try { if (!active) throw new Error('automation_not_launched'); const projectPath = copyWorkspace(sourcePath, active); return text({ ok: true, ...(await command('open_project', { projectPath })), projectPath }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_send_turn', { description: 'Send a real user turn to the active Harness.', inputSchema: z.object({ text: z.string().min(1), mode: z.enum(['agent', 'plan', 'ask']).default('agent') }) }, async ({ text: prompt, mode }) => {
    try { return text({ ok: true, ...(await command('send_turn', { text: prompt, mode })) }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_wait', { description: 'Wait for the agent turn to finish or for the Harness to become idle.', inputSchema: z.object({ condition: z.enum(['turn_done', 'idle']).default('turn_done'), timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000) }) }, async ({ condition, timeoutMs }) => {
    try { return text({ ok: true, ...(await waitFor(condition, timeoutMs)) }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_snapshot', { description: 'Read sanitized application, Controller and plan state.', inputSchema: z.object({ screenshot: z.boolean().default(false) }) }, async ({ screenshot }) => {
    try {
      const state = await snapshot()
      const image = screenshot ? await command('screenshot') : undefined
      return text({ ok: true, snapshot: state, ...(image ? { screenshot: image } : {}) })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_respond', { description: 'Respond to an approval, clarification, or GUI layout request.', inputSchema: z.object({ requestId: z.string().min(1).optional(), action: z.enum(['approve', 'deny', 'clarify', 'gui_layout']), value: z.string().optional() }).refine((value) => value.action === 'clarify' || Boolean(value.requestId), 'requestId is required except for clarify') }, async (params) => {
    try { return text({ ok: true, ...(await command('respond', params)) }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_run_scenario', { description: 'Run a declarative Test Lab scenario or a legacy open/send/wait assertion set. Scenario fixtures are black-box inputs and are never loaded by production Harness code.', inputSchema: z.object({ scenario: z.string().min(1).optional(), sourcePath: z.string().min(1).optional(), text: z.string().min(1).optional(), assertions: z.array(z.object({ type: z.enum(['event_kind', 'tool_called', 'plan_step']), kind: z.string().optional(), name: z.string().optional(), id: z.string().optional(), status: z.string().optional() })).min(1).optional(), timeoutMs: z.number().int().min(1_000).max(3_600_000).optional() }).refine((value) => Boolean(value.scenario || (value.sourcePath && value.text && value.assertions)), 'scenario or sourcePath/text/assertions is required') }, async (input) => {
    try {
      const fixture = input.scenario ? loadScenarioFixture(input.scenario) : undefined
      const sourcePath = fixture ? path.resolve(root, fixture.fixturePath) : input.sourcePath!
      const prompt = fixture?.prompt || input.text!
      const assertions = fixture?.assertions || input.assertions!
      const timeoutMs = input.timeoutMs || fixture?.timeoutMs || 30_000
      const run = await launch(true)
      const projectPath = copyWorkspace(sourcePath, run)
      await command('open_project', { projectPath })
      await command('send_turn', { text: prompt, mode: fixture?.mode || 'agent' })
      const waited = await waitForScenarioCompletion(timeoutMs, fixture?.clarificationResponses || [])
      const eventBody = await bridgeFetch(run, '/v1/events?after=0')
      const evaluated = evaluateAssertions((eventBody.events || []) as Array<Record<string, unknown>>, waited.snapshot as Record<string, unknown>, assertions)
      const report = {
        runId: run.id,
        waited,
        ...evaluated,
        verdict: waited.matched ? evaluated.verdict : 'INCONCLUSIVE' as Verdict,
        ...(waited.matched ? {} : { reason: 'turn_timeout_or_environment_unavailable' }),
        ...(fixture?.acceptanceContract ? { acceptanceContract: fixture.acceptanceContract } : {}),
        ...(fixture ? { scenario: fixture.id } : {}),
        artifacts: run.artifacts
      }
      fs.writeFileSync(path.join(run.artifacts, 'run.json'), JSON.stringify(report, null, 2), 'utf8')
      return text(report)
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_get_report', { description: 'Return the active run artifact location and latest bridge events.', inputSchema: z.object({}) }, async () => {
    try { if (!active) throw new Error('automation_not_launched'); const events = await bridgeFetch(active, '/v1/events?after=0'); return text({ ok: true, runId: active.id, artifacts: active.artifacts, events }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_stop', { description: 'Stop the active isolated application and preserve its diagnostic artifacts.', inputSchema: z.object({ preserveArtifacts: z.boolean().default(true) }) }, async ({ preserveArtifacts }) => text(await stop(preserveArtifacts)))
  return server
}

if (process.argv.includes('--self-test')) {
  const server = buildServer()
  console.log(JSON.stringify({ ok: true, name: 'modcrafting-test-lab', tools: 11, server: Boolean(server) }))
} else {
  console.error('ModCrafting Test Lab MCP listening on stdio')
  const handle = serveStdio(() => buildServer())
  process.on('SIGINT', () => { void handle.close() })
}
