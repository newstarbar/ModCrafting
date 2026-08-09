import test from 'node:test'
import assert from 'node:assert/strict'
import { createGameTestSpec, getGameTestSpec } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { gameTestFailureSignature, recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'

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
