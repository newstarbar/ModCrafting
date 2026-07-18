import test from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldApplyTurnEvent,
  shouldCancelTurnOnSessionLeave,
  shouldForceRestoreSnapshot
} from '../src/renderer/src/utils/session-switch-guard.ts'

test('shouldApplyTurnEvent only accepts matching generation', () => {
  assert.equal(shouldApplyTurnEvent(0, 0), true)
  assert.equal(shouldApplyTurnEvent(3, 3), true)
  assert.equal(shouldApplyTurnEvent(0, 1), false)
  assert.equal(shouldApplyTurnEvent(2, 5), false)
})

test('shouldForceRestoreSnapshot on cross-session and first open', () => {
  assert.equal(shouldForceRestoreSnapshot(null, 'session-b'), true)
  assert.equal(shouldForceRestoreSnapshot('session-a', 'session-b'), true)
  assert.equal(shouldForceRestoreSnapshot('session-a', 'session-a'), false)
  assert.equal(shouldForceRestoreSnapshot('session-a', null), false)
})

test('shouldCancelTurnOnSessionLeave when leaving a real session', () => {
  assert.equal(shouldCancelTurnOnSessionLeave('session-a', 'session-b'), true)
  assert.equal(shouldCancelTurnOnSessionLeave('session-a', null), true)
  assert.equal(shouldCancelTurnOnSessionLeave(null, 'session-b'), false)
  assert.equal(shouldCancelTurnOnSessionLeave('session-a', 'session-a'), false)
  assert.equal(shouldCancelTurnOnSessionLeave(null, null), false)
})

test('generation gate sequence: switch invalidates then new bind accepts', () => {
  let turnGeneration = 0
  let activeTurnGeneration = 0

  // Start turn on A
  activeTurnGeneration = turnGeneration
  assert.equal(shouldApplyTurnEvent(activeTurnGeneration, turnGeneration), true)

  // Switch away: bump (as ChatPanel does)
  turnGeneration += 1
  assert.equal(shouldApplyTurnEvent(activeTurnGeneration, turnGeneration), false)

  // New turn on B: rebind
  activeTurnGeneration = turnGeneration
  assert.equal(shouldApplyTurnEvent(activeTurnGeneration, turnGeneration), true)
})
