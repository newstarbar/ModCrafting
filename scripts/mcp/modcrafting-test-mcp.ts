#!/usr/bin/env node
/** Development-only MCP facade for the authenticated ModCrafting automation bridge. */
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateAppGameTestContract, type AppGameTestContract } from '../test/app-game-test-contract.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const runsRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ModCrafting Test Lab', 'runs')
const scenariosRoot = path.join(root, 'scripts', 'test', 'scenarios')

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

const SUITE_MODEL = 'MiniMax-M3'
const SUITE_PROVIDER = 'minimax'
const SUITE_TASKS = [
  '在当前 Fabric 1.21.4 项目中实现玩家按 G 键在物理宽高均为原值 50% 的小型形态与原形态之间切换且 UUID 不变；请自行完成源码、构建、启动，并自主设计带命名检查点和客观 Observer V2 关系断言的实机测试，失败后自行修复直至 PASS。',
  '在同一项目和同一会话中新增 FPS 风格击杀信息 HUD：仅玩家归因击杀时在右上角按已批准布局显示包含攻击者与唯一受害者标识的信息约五秒，非玩家击杀不得显示；累计回归阶段一，自行构建、启动、设计客观 Observer V2 测试并修复直至 PASS。',
  '在同一项目和同一会话中新增死亡重生后恢复约 60 秒前的位置、生命、饥饿、饱和度、完整物品栏及选中槽；累计回归前两阶段，使用随机 P/A/C 状态、真实 61 秒等待及跨 Minecraft 重启的两次独立完整 PASS，自行构建、启动、测试并修复直至 PASS。'
] as const
const SUITE_STAGE_IDS = ['morph_toggle_v1', 'kill_feed_hud_v1', 'death_rewind_combined_v1'] as const

type SuiteStageId = typeof SUITE_STAGE_IDS[number]
interface SuiteStageState {
  id: SuiteStageId
  fixture: string
  eventCursor: number
  taskMessageHash?: string
  verdict?: Verdict
  evaluatedAt?: string
  reportPath?: string
  minecraftProcessIds?: string[]
  observerSessionIds?: string[]
  windowFingerprints?: string[]
}
interface SuiteState {
  version: 1
  model: { providerId: string; modelId: string }
  sourcePath: string
  workspacePath: string
  startedAt: string
  currentStage: number
  taskMessages: Array<{ stage: number; sha256: string; text: string }>
  stages: SuiteStageState[]
  terminalReason?: string
  processIds: number[]
  observerSessionIds: string[]
  sourceHash?: string
  baseModHash?: string
  workspaceHash?: string
  observerCapabilities?: Record<string, unknown>
}

interface TestRun {
  id: string
  directory: string
  discovery: string
  profile: string
  artifacts: string
  child: ChildProcess
  bridge?: { host: string; port: number; token: string; runId: string }
  suite?: SuiteState
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

function suitePath(run: TestRun): string { return path.join(run.directory, 'suite.json') }

function saveSuite(run: TestRun): void {
  if (!run.suite) return
  fs.writeFileSync(suitePath(run), JSON.stringify(run.suite, null, 2), 'utf8')
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hashDirectory(directory: string): string {
  const digest = createHash('sha256')
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.gradle' || entry.name === 'run' || entry.name === 'build' || entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        digest.update(path.relative(directory, full).replaceAll(path.sep, '/'))
        digest.update(fs.readFileSync(full))
      }
    }
  }
  walk(directory)
  return digest.digest('hex')
}

function hashFile(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  } catch {
    return undefined
  }
}

function suiteStageIndex(value: string): number {
  const index = SUITE_STAGE_IDS.indexOf(value as SuiteStageId)
  return index
}

function suiteStage(run: TestRun, stageId: string): SuiteStageState {
  if (!run.suite) throw new Error('suite_not_started')
  const index = suiteStageIndex(stageId)
  if (index < 0) throw new Error('unknown_suite_stage')
  if (index !== run.suite.currentStage) throw new Error(`suite_stage_not_current:${stageId}`)
  return run.suite.stages[index]
}

async function eventCursor(run: TestRun): Promise<number> {
  const body = await bridgeFetch(run, '/v1/events?after=0')
  return Number(body.cursor || 0)
}

function eventObjects(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(body.events) ? body.events as Array<Record<string, unknown>> : []
}

function hasForbiddenSuiteEvidence(events: Array<Record<string, unknown>>): string | undefined {
  let modelInvocationCount = 0
  for (const entry of events) {
    const event = (entry.event || entry) as Record<string, unknown>
    if (event.kind === 'ClarificationNeeded') return 'game_test_clarification_forbidden'
    const tool = (event.tool || {}) as Record<string, unknown>
    const source = String(tool.source || 'core')
    if (source !== 'core') return `tool_source_forbidden:${source}`
    const invocation = (event.modelInvocation || {}) as Record<string, unknown>
    if (event.kind === 'ModelInvocation' || event.modelInvocation) modelInvocationCount++
    if ((event.kind === 'ModelInvocation' || event.modelInvocation) && (invocation.providerId !== SUITE_PROVIDER || invocation.modelId !== SUITE_MODEL)) {
      return `model_not_allowed:${String(invocation.providerId)}/${String(invocation.modelId)}`
    }
    if (event.kind === 'Collaboration' && event.collaboration) {
      const collaboration = event.collaboration as Record<string, unknown>
      if (collaboration.providerId !== SUITE_PROVIDER || collaboration.modelId !== SUITE_MODEL) return `model_not_allowed:${String(collaboration.providerId)}/${String(collaboration.modelId)}`
    }
  }
  if (modelInvocationCount === 0) return 'model_audit_missing'
  return undefined
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

async function waitForScenarioCompletion(timeoutMs: number, clarificationResponses: string[] = [], suiteStrict = false): Promise<Record<string, unknown>> {
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
      if (suiteStrict) return { matched: false, reason: 'game_test_clarification_forbidden', snapshot: last, clarification }
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

function suiteFixtureForStage(stageId: SuiteStageId): ScenarioFixture {
  const names: Record<SuiteStageId, string> = {
    morph_toggle_v1: 'player-morph-toggle',
    kill_feed_hud_v1: 'kill-feed-hud',
    death_rewind_combined_v1: 'complete-project-minimax'
  }
  return loadScenarioFixture(names[stageId])
}

function writeStageReport(run: TestRun, stage: SuiteStageState, report: Record<string, unknown>): string {
  const directoryNames: Record<SuiteStageId, string> = {
    morph_toggle_v1: '01-morph',
    kill_feed_hud_v1: '02-kill-feed',
    death_rewind_combined_v1: '03-death-rewind'
  }
  const directory = path.join(run.directory, 'stages', directoryNames[stage.id])
  fs.mkdirSync(directory, { recursive: true })
  const reportPath = path.join(directory, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  stage.reportPath = reportPath
  stage.evaluatedAt = new Date().toISOString()
  saveSuite(run)
  return reportPath
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'modcrafting-test-lab', version: '1.0.0' })
  server.registerTool('modcrafting_suite_start', {
    description: 'Start the persistent three-stage Luna Test Lab Suite. Copies the Fabric fixture once, launches one visible Electron session, and pins every model role to minimax/MiniMax-M3.',
    inputSchema: z.object({ sourcePath: z.string().min(1).optional(), providerId: z.string().min(1).default(SUITE_PROVIDER), model: z.string().min(1).default(SUITE_MODEL), visible: z.boolean().default(true) })
  }, async ({ sourcePath, providerId, model, visible }) => {
    try {
      if (active) throw new Error('automation_already_launched')
      if (providerId !== SUITE_PROVIDER || model !== SUITE_MODEL) throw new Error('suite_requires_minimax_MiniMax-M3')
      const run = await launch(visible, true)
      const source = path.resolve(sourcePath || path.join(root, 'resources', '_offline_verify_project'))
      const projectPath = copyWorkspace(source, run)
      await command('open_project', { projectPath })
      const providerResult = await command('use_saved_provider', { providerId })
      const configuredModel = String(providerResult.model || '')
      if (configuredModel && configuredModel !== model) throw new Error(`suite_saved_provider_model_mismatch:${configuredModel}`)
      await command('configure_routing', { config: {
        version: 1,
        onboardingCompleted: true,
        defaultSelection: { mode: 'fixed', strategyId: 'single', taskTemplateId: 'auto', model: { providerId, modelId: model } },
        hardLimits: { maxReadonlyConcurrency: 1, maxDelegations: 1, maxExpertRepairHandoffs: 1 },
        presets: []
      } })
      const capabilities = await command('snapshot', {})
      const sourceHash = hashDirectory(source)
      const baseModHash = hashFile(path.join(root, 'resources', '_base_mods', 'modcrafting-observer.jar'))
      const workspaceHash = hashDirectory(projectPath)
      const suite: SuiteState = {
        version: 1,
        model: { providerId, modelId: model },
        sourcePath: source,
        workspacePath: projectPath,
        startedAt: new Date().toISOString(),
        currentStage: 0,
        taskMessages: [],
        stages: SUITE_STAGE_IDS.map((id) => ({ id, fixture: id === 'morph_toggle_v1' ? 'player-morph-toggle' : id === 'kill_feed_hud_v1' ? 'kill-feed-hud' : 'complete-project-minimax', eventCursor: 0 })),
        processIds: run.child.pid ? [run.child.pid] : [],
        observerSessionIds: [],
        sourceHash,
        ...(baseModHash ? { baseModHash } : {}),
        workspaceHash,
        observerCapabilities: capabilities
      }
      run.suite = suite
      saveSuite(run)
      fs.writeFileSync(path.join(run.artifacts, 'suite-start.json'), JSON.stringify({ suite, sourceHash, baseModHash, workspaceHash, capabilities, provider: { providerId, modelId: model } }, null, 2), 'utf8')
      return text({ ok: true, runId: run.id, workspace: projectPath, artifacts: run.artifacts, currentStage: SUITE_STAGE_IDS[0], providerId, model, processId: run.child.pid })
    } catch (error) {
      if (active && !active.suite) await stop(true)
      return fail(error instanceof Error ? error.message : String(error))
    }
  })
  server.registerTool('modcrafting_launch', { description: 'Launch an isolated ModCrafting automation instance.', inputSchema: z.object({ visible: z.boolean().default(true), liveProvider: z.boolean().default(false) }) }, async ({ visible, liveProvider }) => {
    try { const run = await launch(visible, liveProvider); return text({ ok: true, runId: run.id, artifacts: run.artifacts, liveProvider }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_configure_provider', { description: 'Configure an in-memory local replay provider for the isolated test app. This tool never accepts a real API key.', inputSchema: z.object({ endpoint: z.string().url(), model: z.string().min(1), providerId: z.string().min(1).default('automation-replay') }) }, async (params) => {
    try {
      if (active?.suite) throw new Error('persistent_suite_provider_is_immutable')
      const result = await command('configure_provider', { ...params, apiKey: 'test-key' })
      await sleep(50)
      return text({ ok: true, ...result })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_use_saved_provider', { description: 'Use the primary ModCrafting profile provider in an explicitly live-enabled isolated run. The API key never crosses MCP.', inputSchema: z.object({ providerId: z.string().min(1).optional() }) }, async (params) => {
    try { if (active?.suite) throw new Error('persistent_suite_provider_is_immutable'); return text({ ok: true, ...(await command('use_saved_provider', params)) }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_open_project', { description: 'Copy a project into the active sandbox and open it in ModCrafting.', inputSchema: z.object({ sourcePath: z.string().min(1) }) }, async ({ sourcePath }) => {
    try { if (!active) throw new Error('automation_not_launched'); if (active.suite) throw new Error('persistent_suite_workspace_is_immutable'); const projectPath = copyWorkspace(sourcePath, active); return text({ ok: true, ...(await command('open_project', { projectPath })), projectPath }) } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_send_turn', { description: 'Send a real user turn to the active Harness.', inputSchema: z.object({ text: z.string().min(1), mode: z.enum(['agent', 'plan', 'ask']).default('agent') }) }, async ({ text: prompt, mode }) => {
    try {
      if (active?.suite) {
        const suite = active.suite
        if (suite.terminalReason) throw new Error(`suite_terminal:${suite.terminalReason}`)
        const stage = suite.stages[suite.currentStage]
        const expected = SUITE_TASKS[suite.currentStage]
        if (!stage || prompt !== expected || mode !== 'agent') {
          suite.terminalReason = 'unexpected_task_message_or_mode'
          saveSuite(active)
          throw new Error('suite_accepts_only_the_fixed_current_stage_task')
        }
        if (suite.taskMessages.some((entry) => entry.stage === suite.currentStage)) throw new Error('current_stage_task_already_sent')
        stage.eventCursor = await eventCursor(active)
        const messageHash = hashText(prompt)
        stage.taskMessageHash = messageHash
        suite.taskMessages.push({ stage: suite.currentStage, sha256: messageHash, text: prompt })
        saveSuite(active)
      }
      return text({ ok: true, ...(await command('send_turn', { text: prompt, mode })) })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_wait', { description: 'Wait for the agent turn to finish or for the Harness to become idle.', inputSchema: z.object({ condition: z.enum(['turn_done', 'idle']).default('turn_done'), timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000) }) }, async ({ condition, timeoutMs }) => {
    try {
      const result = active?.suite && condition === 'turn_done'
        ? await waitForScenarioCompletion(timeoutMs, [], true)
        : await waitFor(condition, timeoutMs)
      if (active?.suite && result.reason === 'game_test_clarification_forbidden') {
        active.suite.terminalReason = 'game_test_clarification_forbidden'
        saveSuite(active)
      }
      return text({ ok: true, ...result })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_snapshot', { description: 'Read sanitized application, Controller and plan state.', inputSchema: z.object({ screenshot: z.boolean().default(false) }) }, async ({ screenshot }) => {
    try {
      const state = await snapshot()
      const image = screenshot ? await command('screenshot') : undefined
      return text({ ok: true, snapshot: state, ...(image ? { screenshot: image } : {}) })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_respond', { description: 'Respond to an approval, clarification, or GUI layout request.', inputSchema: z.object({ requestId: z.string().min(1).optional(), action: z.enum(['approve', 'deny', 'clarify', 'gui_layout']), value: z.string().optional() }).refine((value) => value.action === 'clarify' || Boolean(value.requestId), 'requestId is required except for clarify') }, async (params) => {
    try {
      if (active?.suite) {
        if (params.action === 'clarify') {
          active.suite.terminalReason = 'game_test_clarification_forbidden'
          saveSuite(active)
          throw new Error('suite_does_not_accept_clarification_responses')
        }
        if (params.action !== 'gui_layout') {
          active.suite.terminalReason = 'unexpected_suite_response'
          saveSuite(active)
          throw new Error('suite_accepts_only_HUD_layout_approval')
        }
        if (params.action === 'gui_layout' && active.suite.currentStage !== 1) throw new Error('HUD_layout_approval_is_only_allowed_in_stage_2')
      }
      return text({ ok: true, ...(await command('respond', params)) })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_suite_evaluate_stage', {
    description: 'Evaluate only the current persistent Suite stage using fresh events after its task cursor. A stage advances only on PASS; any clarification, non-core tool, non-MiniMax model, stale scenario, or missing contract evidence is INCONCLUSIVE.',
    inputSchema: z.object({ stage: z.enum(SUITE_STAGE_IDS), timeoutMs: z.number().int().min(1_000).max(3_600_000).default(30_000) })
  }, async ({ stage: stageId, timeoutMs }) => {
    try {
      if (!active?.suite) throw new Error('suite_not_started')
      const run = active
      const stage = suiteStage(run, stageId)
      const expectedTask = SUITE_TASKS[run.suite.currentStage]
      const taskRecord = run.suite.taskMessages.find((entry) => entry.stage === run.suite.currentStage)
      if (!stage.taskMessageHash || !taskRecord || taskRecord.sha256 !== stage.taskMessageHash || taskRecord.text !== expectedTask) {
        run.suite.terminalReason = 'stage_task_message_missing_or_mismatched'
        saveSuite(run)
        return text({ ok: true, runId: run.id, stage: stageId, stageIndex: run.suite.currentStage, verdict: 'INCONCLUSIVE' as Verdict, reason: 'stage_task_message_missing_or_mismatched', taskMessageHash: stage.taskMessageHash })
      }
      const fixture = suiteFixtureForStage(stageId)
      const waited = await waitForScenarioCompletion(timeoutMs, [], true)
      const eventBody = await bridgeFetch(run, `/v1/events?after=${stage.eventCursor}`)
      const entries = eventObjects(eventBody)
      const harnessEvents = entries.map((entry) => (entry.event || entry) as Record<string, unknown>)
      const forbidden = hasForbiddenSuiteEvidence(entries)
      const currentSnapshot = waited.snapshot as Record<string, unknown>
      const controller = (((currentSnapshot.chat || {}) as Record<string, unknown>).controller || {}) as Record<string, unknown>
      const contractResult = evaluateAppGameTestContract(harnessEvents, fixture.gameTestContract as AppGameTestContract)
      const currentUi = (((currentSnapshot.chat || {}) as Record<string, unknown>).ui || {}) as Record<string, unknown>
      const clarifying = forbidden === 'game_test_clarification_forbidden' || Boolean(currentUi.clarification)
      const passValidations = harnessEvents
        .filter((event) => event.kind === 'ToolResult' && String(((event.tool || {}) as Record<string, unknown>).name || '') === 'mc_run_test')
        .map((event) => ((event.tool || {}) as Record<string, unknown>).validation as Record<string, unknown> | undefined)
        .filter((validation): validation is Record<string, unknown> => Boolean(validation && validation.verdict === 'PASS' && validation.diagnosticReplay !== true))
      const minecraftProcessIds = [...new Set(passValidations.map((validation) => String(validation.minecraftProcessId || validation.instanceId || '')).filter(Boolean))]
      const observerSessionIds = [...new Set(passValidations.map((validation) => String(validation.observerSessionId || '')).filter(Boolean))]
      const windowFingerprints = [...new Set(passValidations.map((validation) => String(validation.windowFingerprint || '')).filter(Boolean))]
      const priorMinecraftProcessIds = run.suite.stages.slice(0, run.suite.currentStage).flatMap((candidate) => candidate.minecraftProcessIds || [])
      const stageFreshnessError = run.suite.currentStage > 0
        ? (minecraftProcessIds.length === 0
          ? 'stage_minecraft_process_unproven'
          : minecraftProcessIds.some((processId) => priorMinecraftProcessIds.includes(processId))
            ? 'stage_requires_new_minecraft_process'
            : undefined)
        : undefined
      const passed = waited.matched && controller.running === false && !clarifying && !forbidden && !stageFreshnessError && contractResult.passed
      const reason = passed ? undefined : forbidden || stageFreshnessError || (!waited.matched ? String(waited.reason || 'stage_turn_not_complete') : contractResult.details.join('; ') || 'stage_contract_failed')
      const report: Record<string, unknown> = {
        suiteRunId: run.id,
        stage: stageId,
        stageIndex: run.suite.currentStage,
        eventCursorBefore: stage.eventCursor,
        eventCursorAfter: Number(eventBody.cursor || stage.eventCursor),
        taskMessageHash: stage.taskMessageHash,
        waited,
        contract: fixture.gameTestContract,
        contractResult,
        minecraftProcessIds,
        observerSessionIds,
        windowFingerprints,
        stageFreshnessError,
        forbiddenEvidence: forbidden,
        verdict: passed ? 'PASS' : 'INCONCLUSIVE' as Verdict,
        ...(reason ? { reason } : {}),
        model: run.suite.model,
        events: harnessEvents
      }
      const reportPath = writeStageReport(run, stage, report)
      stage.verdict = passed ? 'PASS' : 'INCONCLUSIVE'
      stage.minecraftProcessIds = minecraftProcessIds
      stage.observerSessionIds = observerSessionIds
      stage.windowFingerprints = windowFingerprints
      if (passed) {
        run.suite.currentStage += 1
        const validations = harnessEvents
          .filter((event) => event.kind === 'ToolResult')
          .map((event) => ((event.tool || {}) as Record<string, unknown>).validation as Record<string, unknown> | undefined)
          .filter(Boolean) as Array<Record<string, unknown>>
        for (const validation of validations) {
          if (typeof validation.observerSessionId === 'string' && validation.observerSessionId) run.suite.observerSessionIds.push(validation.observerSessionId)
        }
      } else if (reason) {
        run.suite.terminalReason = reason
      }
      saveSuite(run)
      fs.writeFileSync(path.join(run.artifacts, 'run.json'), JSON.stringify({ ...report, stageReport: reportPath, suite: run.suite }, null, 2), 'utf8')
      return text({ ok: true, ...report, stageReport: reportPath, nextStage: run.suite.currentStage < SUITE_STAGE_IDS.length ? SUITE_STAGE_IDS[run.suite.currentStage] : null })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_suite_get_report', { description: 'Return the persistent Suite summary, stage reports, task hashes, model audit and artifacts.', inputSchema: z.object({}) }, async () => {
    try {
      if (!active?.suite) throw new Error('suite_not_started')
      const events = await bridgeFetch(active, '/v1/events?after=0')
      const reports = active.suite.stages.filter((stage) => stage.reportPath).map((stage) => JSON.parse(fs.readFileSync(stage.reportPath!, 'utf8')))
      return text({ ok: true, runId: active.id, artifacts: active.artifacts, suite: active.suite, reports, eventCursor: events.cursor, processIds: active.suite.processIds })
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  })
  server.registerTool('modcrafting_run_scenario', { description: 'Run a declarative Test Lab scenario or a legacy open/send/wait assertion set. Scenario fixtures are black-box inputs and are never loaded by production Harness code.', inputSchema: z.object({ scenario: z.string().min(1).optional(), sourcePath: z.string().min(1).optional(), text: z.string().min(1).optional(), assertions: z.array(z.object({ type: z.enum(['event_kind', 'tool_called', 'plan_step']), kind: z.string().optional(), name: z.string().optional(), id: z.string().optional(), status: z.string().optional() })).min(1).optional(), timeoutMs: z.number().int().min(1_000).max(3_600_000).optional() }).refine((value) => Boolean(value.scenario || (value.sourcePath && value.text && value.assertions)), 'scenario or sourcePath/text/assertions is required') }, async (input) => {
    try {
      if (active?.suite) throw new Error('use_modcrafting_suite_stage_tools_for_persistent_runs')
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
  console.log(JSON.stringify({ ok: true, name: 'modcrafting-test-lab', tools: 14, suiteStages: SUITE_STAGE_IDS, model: `${SUITE_PROVIDER}/${SUITE_MODEL}`, server: Boolean(server) }))
} else {
  console.error('ModCrafting Test Lab MCP listening on stdio')
  const handle = serveStdio(() => buildServer())
  process.on('SIGINT', () => { void handle.close() })
}
