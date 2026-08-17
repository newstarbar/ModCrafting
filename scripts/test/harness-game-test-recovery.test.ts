import test from 'node:test'
import assert from 'node:assert/strict'
import { createGameTestSpec } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { WorkflowEngine } from '../../src/renderer/src/harness/workflow-engine.ts'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { Registry, type ToolExecutionPayload } from '../../src/renderer/src/harness/tools.ts'
import { EventKind, type Event } from '../../src/renderer/src/harness/events.ts'
import { isToolAllowedForStep } from '../../src/renderer/src/harness/step-policy.ts'

test('game-test recovery gates product tools until explicit product repair', () => {
  const [step] = normalizeWorkflowSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running' }])
  const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args })
  assert.equal(isToolAllowedForStep(step, call('write_file', { path: 'src/main/X.java' })), false)
  assert.equal(isToolAllowedForStep(step, call('delete_file', { path: 'src/main/X.java' })), false)
  assert.equal(isToolAllowedForStep(step, call('trigger_build', { task: 'build' })), false)
  assert.equal(isToolAllowedForStep(step, call('trigger_build', { task: 'build' }), { repairMode: true, repairWriteRequired: true }), false)
  assert.equal(isToolAllowedForStep(step, call('write_file', { path: 'src/main/X.java' }), { repairMode: true, repairWriteRequired: true }), true)
  assert.equal(isToolAllowedForStep(step, call('trigger_build', { task: 'build' }), { repairMode: true, repairWriteRequired: false }), true)
  assert.equal(isToolAllowedForStep(step, call('trigger_build', { task: 'runClient' }), { repairMode: true, repairWriteRequired: false }), true)
})

test('invalid game evidence repairs the scenario internally without clarification', async () => {
  const initial = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  const replacement = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width', to: 2, afterAction: 0 }]
  })
  assert.equal(initial.ok, true)
  assert.equal(replacement.ok, true)
  if (!initial.ok || !replacement.ok) return

  const registry = new Registry()
  let runCount = 0
  registry.add({
    name: 'mc_run_test', description: 'run deterministic test', schema: { type: 'object' }, readOnly: () => false,
    async execute(_ctx, args): Promise<ToolExecutionPayload> {
      runCount++
      const isReplacement = args.scenarioId === replacement.spec.id
      return {
        output: JSON.stringify({ scenarioId: args.scenarioId, verdict: isReplacement ? 'PASS' : 'INCONCLUSIVE' }),
        validation: {
          kind: 'game', valid: isReplacement, verdict: isReplacement ? 'PASS' : 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(),
          ...(isReplacement
            ? {}
            : { inconclusiveCode: 'SPEC_NO_ASSERTIONS' as const, responsibility: 'agent_test_design' as const, scenarioRevision: initial.spec.scenarioRevision, scenarioFingerprint: initial.spec.scenarioFingerprint })
        }
      }
    }
  })
  registry.add({
    name: 'mc_test_scenario', description: 'create deterministic scenario', schema: { type: 'object' }, readOnly: () => true,
    async execute(): Promise<ToolExecutionPayload> {
      return { output: JSON.stringify({ id: replacement.spec.id }) }
    }
  })

  const tracker = PlanTracker.fromSteps([{
    id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: initial.spec
  }])
  const events: Event[] = []
  let round = 0
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps),
    planTracker: tracker,
    registry,
    projectPath: 'D:/test',
    emit: (event) => events.push(event),
    modelCall: async () => {
      round++
      if (round === 1) return { text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: initial.spec.id } }] }
      if (round === 2) return { text: '', reasoning: '', toolCalls: [{ name: 'mc_test_scenario', args: { feature_type: 'player_interaction' } }] }
      return { text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: replacement.spec.id } }] }
    }
  })

  const result = await engine.run([])
  assert.equal(result.needsClarification, undefined)
  assert.equal(result.allDone, true)
  assert.equal(runCount, 2)
  assert.equal(tracker.steps[0].status, 'completed')
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
  const repair = events.find((event) => event.kind === EventKind.GameTestStatus && event.gameTestStatus?.state === 'evidence_repair')
  assert.equal(repair?.gameTestStatus?.code, 'SPEC_NO_ASSERTIONS')
})

test('an INCONCLUSIVE game result paired with ask_clarification terminates without emitting a clarification event', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      return {
        output: JSON.stringify({ verdict: 'INCONCLUSIVE' }),
        validation: {
          kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(),
          inconclusiveCode: 'SPEC_NO_ASSERTIONS', responsibility: 'agent_test_design', scenarioFingerprint: created.spec.scenarioFingerprint
        }
      }
    }
  })
  registry.add({
    name: 'ask_clarification', description: 'clarify', schema: { type: 'object' }, readOnly: () => true,
    async execute(): Promise<string> { return 'clarification requested' }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => ({ text: '', reasoning: '', toolCalls: [
      { name: 'mc_run_test', args: { scenarioId: created.spec.id } },
      { name: 'ask_clarification', args: { question: 'continue?', options: ['yes', 'no'] } }
    ] })
  })
  const result = await engine.run([])
  assert.equal(result.needsClarification, undefined)
  assert.equal(result.gameTestStatus?.state, 'terminal')
  assert.equal(result.gameTestStatus?.code, 'SPEC_NO_ASSERTIONS')
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
})

test('pure visual inconclusive uses a dedicated review card with a fresh screenshot', async () => {
  const created = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  registry.add({
    name: 'mc_run_test', description: 'run visual review fixture', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      return {
        output: 'visual preference needs review',
        validation: {
          kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(),
          inconclusiveCode: 'VISUAL_REVIEW_REQUIRED', responsibility: 'visual_review', scenarioRevision: created.spec.scenarioRevision,
          scenarioFingerprint: created.spec.scenarioFingerprint
        }
      }
    }
  })
  registry.add({
    name: 'mc_screenshot', description: 'fresh screenshot', schema: { type: 'object' }, readOnly: () => true,
    async execute(): Promise<ToolExecutionPayload> { return { output: 'fresh frame', imageBase64: 'aGVsbG8=', imageMimeType: 'image/png' } }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'review visual game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => ({ text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] })
  })
  const result = await engine.run([])
  assert.equal(result.needsVisualReview, true)
  assert.equal(result.needsClarification, undefined)
  assert.equal(tracker.steps[0].status, 'running')
  const status = events.find((event) => event.kind === EventKind.GameTestStatus)?.gameTestStatus
  assert.equal(status?.state, 'visual_review')
  assert.equal(status?.code, 'VISUAL_REVIEW_REQUIRED')
  assert.ok(status?.reviewId)
  assert.match(status?.reviewPrompt || '', /纯视觉要求/)
  assert.equal(status?.reviewScreenshot?.base64, 'aGVsbG8=')
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
})

test('repeating the same invalid scenario three times terminates without a clarification loop', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  let runCount = 0
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      runCount++
      return {
        output: JSON.stringify({ verdict: 'INCONCLUSIVE' }),
        validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: 'SPEC_NO_ASSERTIONS', responsibility: 'agent_test_design', scenarioFingerprint: created.spec.scenarioFingerprint }
      }
    }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => ({ text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] })
  })
  const result = await engine.run([])
  assert.equal(runCount, 3)
  assert.equal(result.needsClarification, undefined)
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
  assert.equal(events.at(-1)?.gameTestStatus?.code, 'REPEATED_INVALID_TEST_SPEC')
})

test('observer recovery is bounded and never enters product repair', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  let runCount = 0
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      runCount++
      return { output: 'observer offline', validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: 'OBSERVER_UNAVAILABLE', responsibility: 'environment', scenarioFingerprint: created.spec.scenarioFingerprint } }
    }
  })
  for (const name of ['write_file', 'edit_file', 'delete_file', 'trigger_build']) {
    registry.add({
      name, description: name, schema: { type: 'object' }, readOnly: () => false,
      async execute(): Promise<string> { return 'blocked fixture tool' }
    })
  }
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const modelToolSets: string[][] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async (_messages, tools) => {
      modelToolSets.push(tools.map((tool) => tool.name))
      return { text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] }
    }
  })
  const result = await engine.run([])
  assert.equal(runCount, 3)
  assert.equal(result.needsClarification, undefined)
  assert.equal(events.at(-1)?.gameTestStatus?.code, 'OBSERVER_UNAVAILABLE')
  assert.equal(events.at(-1)?.gameTestStatus?.state, 'terminal')
  assert.equal(modelToolSets.every((tools) => !tools.some((name) => ['write_file', 'edit_file', 'delete_file', 'trigger_build'].includes(name))), true)
})

test('environment recovery performs host-side world and capability preparation', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return

  const previousWindow = (globalThis as Record<string, unknown>).window
  const hostCalls: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        mcRuntimeStatus: async () => ({ status: 'running', phase: 'ready' }),
        mcStartOrCreate: async () => ({ id: 'mc-recovered' })
      }
    }
  })
  try {
    const registry = new Registry()
    registry.add({
      name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
      async execute(): Promise<ToolExecutionPayload> {
        return { output: 'observer offline', validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: 'OBSERVER_UNAVAILABLE', responsibility: 'environment', scenarioFingerprint: created.spec.scenarioFingerprint } }
      }
    })
    for (const name of ['mc_ensure_test_world', 'mc_ensure_cheats']) {
      registry.add({
        name, description: name, schema: { type: 'object' }, readOnly: () => false,
        async execute(): Promise<string> { hostCalls.push(name); return 'ready' }
      })
    }
    const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
    const engine = new WorkflowEngine({
      steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: () => {},
      modelCall: async () => ({ text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] })
    })
    const result = await engine.run([])
    assert.equal(result.needsClarification, undefined)
    assert.deepEqual(hostCalls, ['mc_ensure_test_world', 'mc_ensure_cheats', 'mc_ensure_test_world', 'mc_ensure_cheats'])
  } finally {
    if (previousWindow === undefined) delete (globalThis as Record<string, unknown>).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('the second objective FAIL opens rebuild/restart product repair', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  let testRuns = 0
  const calls: string[] = []
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      calls.push('mc_run_test')
      testRuns++
      const pass = testRuns >= 3
      return {
        output: JSON.stringify({ scenarioId: created.spec.id, verdict: pass ? 'PASS' : 'FAIL', evidence: [{ passed: pass, detail: pass ? 'fixed' : 'width mismatch' }] }),
        validation: { kind: 'game', valid: pass, verdict: pass ? 'PASS' : 'FAIL', version: '1.21.4', checkedAt: Date.now() }
      }
    }
  })
  registry.add({
    name: 'write_file', description: 'write', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> { calls.push('write_file'); return { output: 'written', artifactPath: 'src/main/X.java', artifactPaths: ['src/main/X.java'] } }
  })
  registry.add({
    name: 'trigger_build', description: 'build', schema: { type: 'object' }, readOnly: () => false,
    async execute(_ctx, args): Promise<string> { calls.push(`trigger_build:${String(args.task)}`); return 'BUILD SUCCESSFUL' }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run deterministic game test', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  let round = 0
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => {
      round++
      if (round <= 2 || round === 6) return { text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] }
      if (round === 3) return { text: '', reasoning: '', toolCalls: [{ name: 'write_file', args: { path: 'src/main/X.java', content: 'fixed' } }] }
      if (round === 4) return { text: '', reasoning: '', toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }] }
      return { text: '', reasoning: '', toolCalls: [{ name: 'trigger_build', args: { task: 'runClient' } }] }
    }
  })
  const result = await engine.run([])
  assert.equal(result.allDone, true)
  assert.deepEqual(calls, ['mc_run_test', 'mc_run_test', 'write_file', 'trigger_build:build', 'trigger_build:runClient', 'mc_run_test'])
  assert.equal(tracker.steps[0].status, 'completed')
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
})

test('required independent PASS count restarts the host and replays the same scenario', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player', required_pass_count: 2,
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  let runs = 0
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      runs++
      return { output: JSON.stringify({ verdict: 'PASS' }), validation: { kind: 'game', valid: true, verdict: 'PASS', version: '1.21.4', checkedAt: Date.now(), scenarioRevision: created.spec.scenarioRevision, scenarioFingerprint: created.spec.scenarioFingerprint } }
    }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run complete scenario', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => ({ text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] })
  })
  const result = await engine.run([])
  assert.equal(result.allDone, true)
  assert.equal(runs, 2)
  const replay = events.find((event) => event.kind === EventKind.GameTestStatus && event.gameTestStatus?.code === 'REPLAY_REQUIRED')
  assert.equal(replay?.gameTestStatus?.passCount, 1)
  assert.equal(replay?.gameTestStatus?.requiredPassCount, 2)
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
})

test('unproven independent replay terminates without resuming the same variant', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player', required_pass_count: 2,
    checkpoints: ['M0'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'M0' }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/uuid', equals: 'player', checkpoint: 'M0' }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const registry = new Registry()
  let runs = 0
  registry.add({
    name: 'mc_run_test', description: 'run', schema: { type: 'object' }, readOnly: () => false,
    async execute(): Promise<ToolExecutionPayload> {
      runs++
      return {
        output: JSON.stringify({ verdict: 'INCONCLUSIVE', inconclusiveCode: 'INDEPENDENT_REPLAY_NOT_PROVEN' }),
        validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: 'INDEPENDENT_REPLAY_NOT_PROVEN', responsibility: 'environment', scenarioRevision: created.spec.scenarioRevision, scenarioFingerprint: created.spec.scenarioFingerprint }
      }
    }
  })
  const tracker = PlanTracker.fromSteps([{ id: '1', description: 'run complete scenario', kind: 'game_test', status: 'running', gameTest: created.spec }])
  const events: Event[] = []
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps), planTracker: tracker, registry, projectPath: 'D:/test', emit: (event) => events.push(event),
    modelCall: async () => ({ text: '', reasoning: '', toolCalls: [{ name: 'mc_run_test', args: { scenarioId: created.spec.id } }] })
  })
  const result = await engine.run([])
  assert.equal(runs, 1)
  assert.equal(result.needsClarification, undefined)
  assert.equal(result.gameTestStatus?.code, 'INDEPENDENT_REPLAY_NOT_PROVEN')
  assert.equal(result.gameTestStatus?.state, 'terminal')
  assert.equal(events.some((event) => event.kind === EventKind.ClarificationNeeded), false)
})
