import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceContractFingerprint, createGameTestSpec, gameTestScenarioFingerprint, getGameTestSpec, hydrateGameTestSpecsFromText, registerGameTestSpec, stateTransitionMatches, validateGameAssertions } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { validateAcceptanceContract } from '../../src/renderer/src/harness/acceptance-contract.ts'
import { canonicalizePlanSteps, normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { gameTestFailureSignature, isSoftSubmitPlanRejection, recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'
import { mcRunTestTool } from '../../src/renderer/src/harness/game-test-runner.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

test('GameTestSpec rejects placeholders and specs without objective assertions', () => {
  assert.equal(createGameTestSpec({ feature_type: 'new_item', subject_id: '<modid>:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }] }).ok, false)
  assert.equal(createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [] }).ok, false)
})

test('V2 scenarios reject a feature with no executable action', () => {
  const result = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud',
    assertions: [{ type: 'hud_text', text: 'KILL' }]
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /action/i)
})

test('strict scenarios require declared checkpoints on every action and relation references', () => {
  const missing = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player', checkpoints: ['M0', 'M1'], baselineCheckpoint: 'M0',
    actions: [{ type: 'wait', ms: 10 }], assertions: [{ type: 'snapshot_relation', source: 'player', pointer: '/width', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'ratio', ratio: 0.5, tolerance: 0.02 }]
  })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /checkpoint/i)
  const valid = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player', checkpoints: ['M0', 'M1'], baselineCheckpoint: 'M0', variables: { token: { type: 'token', values: ['abc123'] } },
    actions: [{ type: 'wait', ms: 10, checkpoint: 'M1' }], assertions: [{ type: 'snapshot_relation', source: 'player', pointer: '/width', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'ratio', ratio: 0.5, tolerance: 0.02 }]
  })
  assert.equal(valid.ok, true)
})

test('strict protocol rejects layout or trace downgrades', () => {
  const noLayout = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H1'], approvedLayoutId: 'layout-1',
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }], assertions: [{ type: 'hud_text', text: '{{token}}', token: '{{token}}', checkpoint: 'H1', approvedLayoutElementId: 'kill-feed' }]
  })
  assert.equal(noLayout.ok, false)
  if (!noLayout.ok) assert.match(noLayout.error, /layout|approved/i)
})

test('new objective assertion types validate their observer fields', () => {
  assert.equal(validateGameAssertions([{ type: 'combat_event', victimTag: 'round', killed: true }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'combat_event', victimTag: 'round', attackerIsPlayer: true }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'elapsed_between', fromCheckpoint: 'P', toCheckpoint: 'D', minMs: 60000, minWorldTicks: 1200 }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'snapshot_relation', source: 'serverPlayer', pointer: '/width', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'approximately', tolerance: 0.01 }]).ok, true)
  const unsupported = createGameTestSpec({ feature_type: 'player_interaction', subject_id: 'example:player', actions: [{ type: 'wait', ms: 1 }], assertions: [{ type: 'snapshot_relation', source: 'serverPlayer', pointer: '/unsupported', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'equals' }] })
  assert.equal(unsupported.ok, false)
})

test('mc_run_test rejects a missing AcceptanceContract before touching the game host', async () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'wait', ms: 1 }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const result = await mcRunTestTool.execute({ projectPath: 'D:/test', callId: 'contract-check' } as ToolContext, { scenarioId: created.spec.id })
  const payload = typeof result === 'string' ? JSON.parse(result) : JSON.parse(result.output)
  assert.equal(payload.verdict, 'INCONCLUSIVE')
  assert.equal(payload.inconclusiveCode, 'SPEC_NO_ASSERTIONS')
  assert.equal(payload.responsibility, 'agent_test_design')
})

test('GameTestSpec creates an isolated scenario with cleanup', () => {
  const created = createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [{ type: 'block_equals', x: 0, y: 100, z: 4, blockId: 'example:altar' }] })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(getGameTestSpec(created.spec.id)?.featureType, 'new_block')
  assert.match(JSON.stringify(created.spec.cleanup), /modcrafting_test/)
})

test('game_test accepts only fresh mc_run_test PASS evidence, never screenshots', () => {
  const created = createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [{ type: 'block_equals', x: 0, y: 100, z: 4, blockId: 'example:altar' }] })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const [step] = normalizeWorkflowSteps([{ id: '1', description: `run deterministic game test mc_run_test scenarioId=${created.spec.id}`, status: 'pending', gameTest: created.spec }])
  assert.equal(step.kind, 'game_test')
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_screenshot', output: 'screenshot captured', durationMs: 0, exitCode: 0 }), false)
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_run_test', args: { scenarioId: created.spec.id }, output: '{}', durationMs: 0, exitCode: 0, validation: { kind: 'game', valid: true, verdict: 'PASS', version: '1.21.4', checkedAt: Date.now() } }), true)
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_run_test', args: { scenarioId: created.spec.id }, output: '{}', durationMs: 0, exitCode: 0, validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }), false)
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_run_test', args: { scenarioId: 'scenario_stale' }, output: '{}', durationMs: 0, exitCode: 0, validation: { kind: 'game', valid: true, verdict: 'PASS', version: '1.21.4', checkedAt: Date.now() } }), false)
})

test('same failed assertion has a stable signature across fresh sessions', () => {
  const report = (id: string, observedAt: number) => JSON.stringify({ id, scenarioId: 'scenario_block', observedAt, evidence: [{ passed: false, detail: `block example:altar at ${observedAt}`, assertion: { type: 'block_equals', blockId: 'example:altar' } }] })
  assert.equal(gameTestFailureSignature(report('test_a', 1710000000000)), gameTestFailureSignature(report('test_b', 1720000000000)))
})

test('generic assertion protocol validates type, placeholders, pointers, and timelines without feature semantics', () => {
  assert.equal(validateGameAssertions([{ kind: 'world_state' }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'world_state' }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'snapshot_value', source: 'player', pointer: '/x', equals: 4 }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'snapshot_changed', source: 'serverPlayer', pointer: '/health', to: 20, afterAction: 0 }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'snapshot_changed', source: 'player', pointer: '/width', afterAction: 0 }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'snapshot_unchanged', source: 'player', pointer: '/uuid', afterAction: 0 }]).ok, true)
  assert.equal(validateGameAssertions([{ type: 'snapshot_value', source: 'player', pointer: 'x', equals: 4 }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'hud_text', text: '<widget_index>' }]).ok, false)
  assert.equal(createGameTestSpec({ feature_type: 'player_interaction', subject_id: 'example:player', actions: [{ type: 'wait', ms: 10 }], assertions: [{ type: 'render_trace', modelClass: 'UnsupportedModel' }] }).ok, false)
})

test('hotkey interactions compile to input and ordered checkpoints remain generic', () => {
  const created = createGameTestSpec({
    feature_type: 'player_interaction', hotkey: 'K',
    actions: [{ type: 'input', action: 'key', args: { key: 'k' } }, { type: 'wait', ms: 20 }, { type: 'input', action: 'key_press', args: { key: 'k' } }],
    assertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/x', from: 0, to: 2, afterAction: 0 }, { type: 'snapshot_changed', source: 'player', pointer: '/x', from: 2, to: 0, afterAction: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.spec.actions[0].type, 'input')
  assert.equal(stateTransitionMatches(created.spec.assertions[0] as never, 0, 2), true)
})

test('acceptance contract requires a structural oracle per atomic requirement', () => {
  const invalid = validateAcceptanceContract({ version: 1, requirements: [{ id: 'a', sourceQuote: '需求', claim: '完成' }] }, () => ({ ok: true }))
  assert.equal(invalid.ok, false)
  const valid = validateAcceptanceContract({ version: 1, requirements: [
    { id: 'build', sourceQuote: '构建', claim: '构建成功', oracle: { type: 'build_success' } },
    { id: 'state', sourceQuote: '状态变化', claim: '状态可观测', oracle: { type: 'game_assertion', assertion: { type: 'snapshot_changed', source: 'player', pointer: '/x', to: 4, afterAction: 0 } } },
    { id: 'visual', sourceQuote: '外观', claim: '外观符合设计', oracle: { type: 'user_confirmation', prompt: '确认截图', capture: 'screenshot' } }
  ] }, (assertion) => validateGameAssertions([assertion]))
  assert.equal(valid.ok, true)
})

test('GameTestSpec requires every objective contract requirement to map to an assertion', () => {
  const result = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'wait', ms: 1 }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }],
    acceptanceContract: {
      version: 1,
      requirements: [{
        id: 'health', sourceQuote: 'health', claim: 'health is observable',
        oracle: { type: 'game_assertion', assertion: { type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20 } }
      }]
    }
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /no matching GameTestSpec assertion/i)
})

test('persisted V2 spec retains its scenario id and gets a legacy acceptance contract', () => {
  const created = createGameTestSpec({ feature_type: 'new_item', subject_id: 'example:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }] })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const legacy = { ...created.spec, acceptanceContract: undefined }
  assert.equal(hydrateGameTestSpecsFromText(`\`\`\`json\n${JSON.stringify({ gameTest: legacy })}\n\`\`\``), 1)
  assert.equal(getGameTestSpec(created.spec.id)?.acceptanceContract?.requirements.length, 1)
})

test('scenario fingerprints exclude runtime identity while retaining revision metadata', () => {
  const first = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  const second = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (!first.ok || !second.ok) return
  assert.equal(gameTestScenarioFingerprint(first.spec), gameTestScenarioFingerprint(second.spec))
  assert.notEqual(first.spec.id, second.spec.id)
  assert.equal(first.spec.scenarioRevision, 1)
})

test('scenarios persist a separate AcceptanceContract fingerprint', () => {
  const contract = {
    version: 1 as const,
    requirements: [{
      id: 'state', sourceQuote: 'state', claim: 'width changes',
      oracle: { type: 'game_assertion' as const, assertion: { type: 'snapshot_changed' as const, source: 'player' as const, pointer: '/width' } }
    }]
  }
  const created = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player',
    actions: [{ type: 'wait', ms: 1 }], assertions: contract.requirements.map((entry) => entry.oracle.assertion),
    acceptanceContract: contract
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.spec.acceptanceContractFingerprint, acceptanceContractFingerprint(contract))
  assert.notEqual(created.spec.acceptanceContractFingerprint, created.spec.scenarioFingerprint)
})

test('visual review decision persists as user_confirmation evidence without changing scenario identity', () => {
  const created = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud',
    actions: [{ type: 'wait', ms: 1 }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 2 }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const restored = registerGameTestSpec({
    ...created.spec,
    visualReviewDecision: 'accepted',
    visualReviewEvidence: {
      decision: 'accepted', prompt: '确认 HUD 视觉效果', screenshotToolId: 'shot-1', capturedAt: 10, reviewedAt: 20
    }
  })
  assert.equal(restored.ok, true)
  if (!restored.ok) return
  assert.equal(restored.spec.visualReviewDecision, 'accepted')
  assert.equal(restored.spec.visualReviewEvidence?.decision, 'accepted')
  assert.equal(restored.spec.visualReviewEvidence?.screenshotToolId, 'shot-1')
  assert.equal(restored.spec.scenarioFingerprint, created.spec.scenarioFingerprint)
})

test('legacy inspect game test is migrated after build and run without losing status', () => {
  const migrated = canonicalizePlanSteps([
    { id: '1', description: 'write mixin', kind: 'mixin', status: 'completed' },
    { id: '2', description: 'run deterministic test mc_run_test scenarioId=scenario_old', kind: 'inspect', status: 'error' },
    { id: '3', description: 'build project trigger_build build', status: 'pending' },
    { id: '4', description: 'start game runClient', status: 'pending' }
  ])
  assert.deepEqual(migrated.map((step) => step.kind), ['mixin', 'build', 'run', 'game_test'])
})

test('only submit_plan receives execute-phase soft guidance', () => {
  assert.equal(isSoftSubmitPlanRejection({ toolName: 'submit_plan' }), true)
  assert.equal(isSoftSubmitPlanRejection({ toolName: 'mc_run_test' }), false)
})
