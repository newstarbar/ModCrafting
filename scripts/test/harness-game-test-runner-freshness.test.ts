import test from 'node:test'
import assert from 'node:assert/strict'
import { assertionFromSnapshot, verdictFor } from '../../src/renderer/src/harness/game-test-runner.ts'
import { createGameTestSpec, MAX_GAME_TEST_WAIT_MS } from '../../src/renderer/src/harness/game-test-protocol.ts'

test('HUD assertions ignore trace text recorded before the asserted action', () => {
  const assertion = { type: 'hud_text' as const, text: 'KILL', match: 'contains' as const, afterAction: 0 }
  const before = { observedAt: 1_000 }
  assert.equal(assertionFromSnapshot(assertion, { observedAt: 2_000, hudTrace: [{ text: 'KILL', observedAt: 900 }] }, before).passed, false)
  assert.equal(assertionFromSnapshot(assertion, { observedAt: 2_000, hudTrace: [{ text: 'KILL', observedAt: 1_500 }] }, before).passed, true)
})

test('render assertions likewise require a fresh trace entry', () => {
  const assertion = { type: 'render_trace' as const, entityType: 'minecraft:player', afterAction: 0 }
  const result = assertionFromSnapshot(assertion, {
    observedAt: 2_000,
    renderTrace: [{ entityType: 'minecraft:player', observedAt: 500 }]
  }, { observedAt: 1_000 })
  assert.equal(result.passed, false)
})

test('game tests accept a real minute-scale wait and reject excessive waits', () => {
  const valid = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:test',
    actions: [{ type: 'wait', ms: 61_000 }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20, afterAction: 0 }]
  })
  assert.equal(valid.ok, true)
  const invalid = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:test',
    actions: [{ type: 'wait', ms: MAX_GAME_TEST_WAIT_MS + 1 }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20, afterAction: 0 }]
  })
  assert.equal(invalid.ok, false)
})

test('objective verdict is independent from a separate visual review requirement', () => {
  const row = assertionFromSnapshot(
    { type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20 },
    { player: { health: 20 } }
  )
  assert.equal(verdictFor([row], false).verdict, 'PASS')
  assert.equal(verdictFor([row], true).verdict, 'INCONCLUSIVE')
})

test('HUD assertions can verify objective position and disappearance without visual confirmation', () => {
  const positive = assertionFromSnapshot(
    { type: 'hud_text', text: 'KILL', position: { xMin: 900, yMin: 20 }, afterAction: 0 },
    { observedAt: 2_000, hudTrace: [{ text: 'KILL player', x: 1_000, y: 24, observedAt: 1_500 }] },
    { observedAt: 1_000 }
  )
  assert.equal(positive.passed, true)
  const negative = assertionFromSnapshot(
    { type: 'hud_text', text: 'KILL', exists: false, afterAction: 1 },
    { observedAt: 8_000, hudTrace: [{ text: 'KILL player', x: 1_000, y: 24, observedAt: 1_500 }] },
    { observedAt: 2_000 }
  )
  assert.equal(negative.passed, true)
})

test('snapshot_unchanged verifies UUID stability against the action baseline', () => {
  const result = assertionFromSnapshot(
    { type: 'snapshot_unchanged', source: 'player', pointer: '/uuid', afterAction: 0 },
    { player: { uuid: 'same-player' } },
    { player: { uuid: 'same-player' } }
  )
  assert.equal(result.passed, true)
  assert.equal(assertionFromSnapshot(
    { type: 'snapshot_unchanged', source: 'player', pointer: '/uuid', afterAction: 0 },
    { player: { uuid: 'new-player' } },
    { player: { uuid: 'same-player' } }
  ).passed, false)
})

test('strict relations use right/left ratio and combat traces require attribution', () => {
  const relation = assertionFromSnapshot(
    { type: 'snapshot_relation', source: 'serverPlayer', pointer: '/width', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'ratio', ratio: 0.5, tolerance: 0.02 },
    { serverPlayer: { width: 1 } },
    undefined,
    { M0: { serverPlayer: { width: 2 } }, M1: { serverPlayer: { width: 1 } } }
  )
  assert.equal(relation.passed, true)
  const combat = assertionFromSnapshot(
    { type: 'combat_event', victimTag: 'round-a', attackerIsPlayer: true, killed: true },
    { combatTrace: [{ sequence: 2, victimTags: ['round-a'], attackerIsPlayer: true, killed: true }] },
    { traceCursors: { combatTrace: 1 } }
  )
  assert.equal(combat.passed, true)
})

test('combat attribution can bind the attacker UUID to a named player checkpoint', () => {
  const assertion = { type: 'combat_event' as const, victimTag: 'round-a', attackerCheckpoint: 'H0', attackerIsPlayer: true, killed: true, sinceCheckpoint: 'H0' }
  const checkpoints = { H0: { serverPlayer: { uuid: 'player-uuid' }, traceCursors: { combatTrace: 1 } } }
  const pass = assertionFromSnapshot(assertion, {
    combatTrace: [{ sequence: 2, victimTags: ['round-a'], attackerUuid: 'player-uuid', attackerIsPlayer: true, killed: true }]
  }, undefined, checkpoints)
  const fail = assertionFromSnapshot(assertion, {
    combatTrace: [{ sequence: 2, victimTags: ['round-a'], attackerUuid: 'other-uuid', attackerIsPlayer: true, killed: true }]
  }, undefined, checkpoints)
  assert.equal(pass.passed, true)
  assert.equal(fail.passed, false)
})
