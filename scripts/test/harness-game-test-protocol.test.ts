import test from 'node:test'
import assert from 'node:assert/strict'
import { createGameTestSpec, getGameTestSpec, hydrateGameTestSpecsFromText, stateTransitionMatches, validateGameAssertions } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { validateAcceptanceContract } from '../../src/renderer/src/harness/acceptance-contract.ts'
import { canonicalizePlanSteps, normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { gameTestFailureSignature, isSoftSubmitPlanRejection, recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'

test('GameTestSpec rejects placeholders and specs without objective assertions', () => {
  assert.equal(createGameTestSpec({ feature_type: 'new_item', subject_id: '<modid>:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }] }).ok, false)
  assert.equal(createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [] }).ok, false)
})

test('GameTestSpec creates an isolated scenario with cleanup', () => {
  const created = createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [{ type: 'block_equals', x: 0, y: 100, z: 4, blockId: 'example:altar' }] })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(getGameTestSpec(created.spec.id)?.featureType, 'new_block')
  assert.match(JSON.stringify(created.spec.cleanup), /modcrafting_test/)
})

test('game_test accepts only fresh mc_run_test PASS evidence, never screenshots', () => {
  const [step] = normalizeWorkflowSteps([{ id: '1', description: 'run deterministic game test mc_run_test scenarioId=scenario_1', status: 'pending' }])
  assert.equal(step.kind, 'game_test')
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_screenshot', output: 'screenshot captured', durationMs: 0, exitCode: 0 }), false)
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_run_test', output: '{}', durationMs: 0, exitCode: 0, validation: { kind: 'game', valid: true, verdict: 'PASS', version: '1.21.4', checkedAt: Date.now() } }), true)
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_run_test', output: '{}', durationMs: 0, exitCode: 0, validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }), false)
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
  assert.equal(validateGameAssertions([{ type: 'snapshot_value', source: 'player', pointer: 'x', equals: 4 }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'hud_text', text: '<widget_index>' }]).ok, false)
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

test('persisted V2 spec retains its scenario id and gets a legacy acceptance contract', () => {
  const created = createGameTestSpec({ feature_type: 'new_item', subject_id: 'example:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }] })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const legacy = { ...created.spec, acceptanceContract: undefined }
  assert.equal(hydrateGameTestSpecsFromText(`\`\`\`json\n${JSON.stringify({ gameTest: legacy })}\n\`\`\``), 1)
  assert.equal(getGameTestSpec(created.spec.id)?.acceptanceContract?.requirements.length, 1)
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
