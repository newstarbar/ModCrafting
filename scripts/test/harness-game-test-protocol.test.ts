import test from 'node:test'
import assert from 'node:assert/strict'
import { createGameTestSpec, getGameTestSpec, hydrateGameTestSpecsFromText, validateGameAssertions } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { canonicalizePlanSteps, normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { gameTestFailureSignature, isSoftSubmitPlanRejection, recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'

test('GameTestSpec rejects placeholders and specs without objective assertions', () => {
  const placeholder = createGameTestSpec({
    feature_type: 'new_item', subject_id: '<modid>:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }]
  })
  assert.equal(placeholder.ok, false)

  const empty = createGameTestSpec({ feature_type: 'new_block', subject_id: 'example:altar', assertions: [] })
  assert.equal(empty.ok, false)
})

test('GameTestSpec creates a concrete isolated scenario with cleanup', () => {
  const created = createGameTestSpec({
    feature_type: 'new_block',
    subject_id: 'example:altar',
    assertions: [{ type: 'block_equals', x: 0, y: 100, z: 4, blockId: 'example:altar' }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(getGameTestSpec(created.spec.id)?.featureType, 'new_block')
  assert.match(JSON.stringify(created.spec.setup), /fill -16 96 -16 16 112 16 air/)
  assert.match(JSON.stringify(created.spec.cleanup), /modcrafting_test/)
})

test('game_test accepts only fresh mc_run_test PASS evidence, never screenshots', () => {
  const [step] = normalizeWorkflowSteps([{
    id: '1', description: '执行确定性游戏测试（mc_run_test scenarioId=scenario_1；仅 PASS 完成）', status: 'pending'
  }])
  assert.equal(step.kind, 'game_test')
  assert.equal(step.validation?.type, 'game_test_passed')
  assert.equal(recordsStepEvidence(step, { ok: true, toolName: 'mc_screenshot', output: 'screenshot captured', durationMs: 0, exitCode: 0 }), false)
  assert.equal(recordsStepEvidence(step, {
    ok: true, toolName: 'mc_run_test', output: '{}', durationMs: 0, exitCode: 0,
    validation: { kind: 'game', valid: true, verdict: 'PASS', version: '1.21.4', checkedAt: Date.now() }
  }), true)
  assert.equal(recordsStepEvidence(step, {
    ok: true, toolName: 'mc_run_test', output: '{}', durationMs: 0, exitCode: 0,
    validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() }
  }), false)
})

test('same failed assertion has a stable signature across fresh game-test sessions', () => {
  const report = (id: string, observedAt: number) => JSON.stringify({
    id, scenarioId: 'scenario_block', observedAt,
    evidence: [{ passed: false, detail: `block example:altar at ${observedAt}`, assertion: { type: 'block_equals', blockId: 'example:altar' } }]
  })
  assert.equal(gameTestFailureSignature(report('test_a', 1710000000000)), gameTestFailureSignature(report('test_b', 1720000000000)))
})

test('strict assertion protocol rejects legacy kind, unknown types, and incomplete fields', () => {
  assert.equal(validateGameAssertions([{ kind: 'world_state' }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'world_state' }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'block_equals', x: 0, y: 100, z: 4 }]).ok, false)
  assert.equal(validateGameAssertions([{ type: 'entity_exists', tag: 'modcrafting_test', exists: false }]).ok, true)
})

test('hotkey player interactions compile to input rather than give and explicit actions win', () => {
  const hotkey = createGameTestSpec({
    feature_type: 'player_interaction', hotkey: 'V',
    assertions: [{ type: 'player_state', path: 'abilities.invulnerable', equals: false }]
  })
  assert.equal(hotkey.ok, true)
  if (!hotkey.ok) return
  assert.equal(hotkey.spec.actions[0].type, 'input')
  const explicit = createGameTestSpec({
    feature_type: 'new_item', subject_id: 'example:wand',
    actions: [{ type: 'wait', ms: 20 }],
    assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }]
  })
  assert.equal(explicit.ok, true)
  if (explicit.ok) assert.deepEqual(explicit.spec.actions, [{ type: 'wait', ms: 20 }])
})

test('persisted V2 spec retains its original scenario id', () => {
  const created = createGameTestSpec({
    feature_type: 'new_item', subject_id: 'example:wand', assertions: [{ type: 'inventory_contains', itemId: 'example:wand' }]
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const restored = hydrateGameTestSpecsFromText(`\`\`\`json\n${JSON.stringify({ gameTest: created.spec })}\n\`\`\``)
  assert.equal(restored, 1)
  assert.equal(getGameTestSpec(created.spec.id)?.id, created.spec.id)
})

test('legacy inspect game test is migrated after build and run without losing status', () => {
  const migrated = canonicalizePlanSteps([
    { id: '1', description: 'write mixin', kind: 'mixin', status: 'completed' },
    { id: '2', description: 'run deterministic test mc_run_test scenarioId=scenario_old', kind: 'inspect', status: 'error' },
    { id: '3', description: 'build project trigger_build build', status: 'pending' },
    { id: '4', description: 'start game runClient', status: 'pending' }
  ])
  assert.deepEqual(migrated.map((step) => step.kind), ['mixin', 'build', 'run', 'game_test'])
  assert.equal(migrated[0].status, 'completed')
  assert.equal(migrated[3].status, 'pending')
})

test('only an actual submit_plan call receives the execute-phase soft guidance', () => {
  assert.equal(isSoftSubmitPlanRejection({ toolName: 'submit_plan' }), true)
  assert.equal(isSoftSubmitPlanRejection({ toolName: 'mc_run_test' }), false)
  assert.equal(isSoftSubmitPlanRejection({ toolName: 'trigger_build' }), false)
})
