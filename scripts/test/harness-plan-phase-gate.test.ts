import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isPlanPostLockTool,
  MAX_PLAN_SUBMIT_NUDGE_ROUNDS,
  MAX_READONLY_ROUNDS,
  PLAN_EXPLORATION_LOCK_KICK,
  PLAN_SUBMIT_NUDGE,
  shouldNudgePlanSubmit
} from '../../src/renderer/src/harness/plan-phase-gate.ts'

test('plan exploration lock kick demands submit_plan', () => {
  assert.match(PLAN_EXPLORATION_LOCK_KICK, /submit_plan/)
  assert.match(PLAN_EXPLORATION_LOCK_KICK, /已锁定/)
  assert.equal(MAX_READONLY_ROUNDS, 3)
})

test('text-only plan replies are nudged up to MAX then stop', () => {
  assert.match(PLAN_SUBMIT_NUDGE, /禁止仅用文字结束/)
  assert.match(PLAN_SUBMIT_NUDGE, /submit_plan/)
  assert.equal(shouldNudgePlanSubmit(0), true)
  assert.equal(shouldNudgePlanSubmit(MAX_PLAN_SUBMIT_NUDGE_ROUNDS - 1), true)
  assert.equal(shouldNudgePlanSubmit(MAX_PLAN_SUBMIT_NUDGE_ROUNDS), false)
})

test('post-lock tools are only submit_plan and ask_clarification', () => {
  assert.equal(isPlanPostLockTool('submit_plan'), true)
  assert.equal(isPlanPostLockTool('ask_clarification'), true)
  assert.equal(isPlanPostLockTool('read_file'), false)
  assert.equal(isPlanPostLockTool('fabric_docs_search'), false)
  assert.equal(isPlanPostLockTool('grep'), false)
})
