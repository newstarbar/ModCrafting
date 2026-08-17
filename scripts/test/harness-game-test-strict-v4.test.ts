import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  createGameTestSpec,
  computeApprovedLayoutFingerprint,
  gameTestVariantFingerprint,
  registerApprovedLayoutRecord,
  getApprovedLayoutRecord
} from '../../src/renderer/src/harness/game-test-protocol.ts'
import { assertionFromSnapshot } from '../../src/renderer/src/harness/game-test-runner.ts'

test('V4 relation accepts independent client/server operands and normalizers', () => {
  const result = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'modcrafting:test',
    checkpoints: ['M0', 'M1'],
    actions: [{ type: 'wait', ms: 10, checkpoint: 'M1' }],
    assertions: [
      { type: 'snapshot_relation', left: { checkpoint: 'M0', source: 'player', pointer: '/uuid' }, right: { checkpoint: 'M1', source: 'serverPlayer', pointer: '/uuid' }, operator: 'equals' },
      { type: 'snapshot_relation', left: { checkpoint: 'M0', source: 'serverPlayer', pointer: '/inventory' }, right: { checkpoint: 'M1', source: 'serverPlayer', pointer: '/inventory' }, operator: 'equals', normalizer: 'inventory_v1' }
    ]
  })
  assert.equal(result.ok, true)
})

test('runtime variant fingerprint excludes observer identity', () => {
  assert.equal(gameTestVariantFingerprint({ x: 1, token: 'a' }, 'jvm-a'), gameTestVariantFingerprint({ x: 1, token: 'a' }, 'jvm-b'))
  assert.notEqual(gameTestVariantFingerprint({ x: 1, token: 'a' }), gameTestVariantFingerprint({ x: 2, token: 'b' }))
})

test('wait_until is a strict named action and invalid target is rejected', () => {
  const result = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'modcrafting:test',
    checkpoints: ['D', 'R'],
    actions: [
      { type: 'wait_until', condition: 'death_screen', timeoutMs: 5_000, checkpoint: 'D' },
      { type: 'wait_until', condition: 'server_player_available', timeoutMs: 10_000, checkpoint: 'R' }
    ],
    assertions: [{ type: 'screen_matches', screenName: 'DeathScreen', checkpoint: 'D' }]
  })
  assert.equal(result.ok, true)
  const invalid = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'modcrafting:test',
    checkpoints: ['A', 'B'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'A' }, { type: 'wait', ms: 1, checkpoint: 'B' }],
    assertions: [{ type: 'snapshot_relation', left: { checkpoint: 'A', source: 'serverPlayer', pointer: '/notExposed' }, right: { checkpoint: 'B', source: 'serverPlayer', pointer: '/width' }, operator: 'equals' }]
  })
  assert.equal(invalid.ok, false)
})

test('strict scenarios reject drifting afterAction assertions', () => {
  const result = createGameTestSpec({
    feature_type: 'player_interaction',
    subject_id: 'modcrafting:test',
    checkpoints: ['M0', 'M1'],
    actions: [{ type: 'wait', ms: 10, checkpoint: 'M1' }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/width', equals: 0.5, afterAction: 0 }]
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /afterAction|checkpoint/i)
})

test('strict scenarios reject duplicate action checkpoints', () => {
  const result = createGameTestSpec({
    feature_type: 'player_interaction', subject_id: 'example:player', checkpoints: ['A'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'A' }, { type: 'wait', ms: 1, checkpoint: 'A' }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/uuid', equals: 'same', checkpoint: 'A' }]
  })
  assert.equal(result.ok, false)
})

test('HUD freshness is measured at the named checkpoint, not scenario end', () => {
  const row = assertionFromSnapshot(
    { type: 'hud_text', text: 'TARGET_ABC', token: 'TARGET_ABC', checkpoint: 'H1', maxAgeMs: 500 },
    { hudTrace: [{ sequence: 1, text: 'PLAYER killed TARGET_ABC', normalizedX: 0.8, normalizedY: 0.1, x: 1000, y: 50, observedAt: 1_000 }] },
    undefined,
    { H1: { __checkpointObservedAt: 1_100 } }
  )
  assert.equal(row.passed, true)
})

test('HUD semantic oracle requires the H0 player name and victim token in one fresh draw', () => {
  const assertion = { type: 'hud_text' as const, text: 'TARGET_ABC', token: 'TARGET_ABC', checkpoint: 'H1', sinceCheckpoint: 'H0', attackerCheckpoint: 'H0', requireAttackerVictimSemantics: true, maxAgeMs: 500 }
  const checkpoints = { H0: { serverPlayer: { name: 'PLAYER_ONE' }, __checkpointObservedAt: 1_000 }, H1: { __checkpointObservedAt: 1_100 } }
  const passed = assertionFromSnapshot(assertion, { hudTrace: [{ sequence: 1, text: 'PLAYER_ONE killed TARGET_ABC', observedAt: 1_050 }] }, undefined, checkpoints)
  const failed = assertionFromSnapshot(assertion, { hudTrace: [{ sequence: 1, text: 'TARGET_ABC', observedAt: 1_050 }] }, undefined, checkpoints)
  assert.equal(passed.passed, true)
  assert.equal(failed.passed, false)
})

test('strict HUD semantic assertions require an attacker checkpoint', () => {
  const valid = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H0', 'H1'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }],
    assertions: [{ type: 'hud_text', text: 'TARGET', token: 'TARGET', checkpoint: 'H1', sinceCheckpoint: 'H0', attackerCheckpoint: 'H0', requireAttackerVictimSemantics: true }]
  })
  const invalid = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H0', 'H1'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }],
    assertions: [{ type: 'hud_text', text: 'TARGET', token: 'TARGET', checkpoint: 'H1', sinceCheckpoint: 'H0', requireAttackerVictimSemantics: true }]
  })
  assert.equal(valid.ok, true)
  assert.equal(invalid.ok, false)
})

test('strict player combat assertions accept a dynamic attacker checkpoint and reject an unbound player event', () => {
  const valid = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H0', 'H1'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }],
    assertions: [{ type: 'combat_event', victimTag: 'TARGET', attackerCheckpoint: 'H0', attackerIsPlayer: true, killed: true, checkpoint: 'H1', sinceCheckpoint: 'H0' }]
  })
  assert.equal(valid.ok, true)
  const invalid = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H0', 'H1'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }],
    assertions: [{ type: 'combat_event', victimTag: 'TARGET', attackerIsPlayer: true, killed: true, checkpoint: 'H1', sinceCheckpoint: 'H0' }]
  })
  assert.equal(invalid.ok, false)
})

test('automated objective scenarios cannot mix user confirmation into the game verdict', () => {
  const result = createGameTestSpec({
    feature_type: 'hud_gui', subject_id: 'example:hud', checkpoints: ['H1'],
    actions: [{ type: 'wait', ms: 1, checkpoint: 'H1' }],
    assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/uuid', equals: 'same', checkpoint: 'H1' }],
    acceptanceContract: { version: 1, requirements: [
      { id: 'objective', sourceQuote: 'objective', claim: 'objective', oracle: { type: 'game_assertion', assertion: { type: 'snapshot_value', source: 'player', pointer: '/uuid', equals: 'same', checkpoint: 'H1' } } },
      { id: 'visual', sourceQuote: 'visual', claim: 'visual', oracle: { type: 'user_confirmation', prompt: 'approve' } }
    ] }
  })
  assert.equal(result.ok, false)
})

test('approved layout is host-owned and normalized before HUD matching', () => {
  const body = { layoutType: 'hud', canvasWidth: 1280, canvasHeight: 720, elements: [{ id: 'kill-feed', type: 'text', label: 'kill feed', x: 960, y: 48, width: 280, height: 32, color: 0xffffffff, alpha: 255, shadow: true }] }
  const hostFingerprint = computeApprovedLayoutFingerprint(body)
  const registered = registerApprovedLayoutRecord({ approvalId: 'layout-test', layoutFingerprint: hostFingerprint, ...body, approvedAt: 1 })
  assert.equal(registered.ok, true)
  const record = getApprovedLayoutRecord('layout-test', hostFingerprint)
  assert.equal(record?.elements[0].x, 0.75)
  assert.equal(record?.elements[0].y, 48 / 720)
  assert.equal(getApprovedLayoutRecord('layout-test', 'wrong'), undefined)
  const replacement = registerApprovedLayoutRecord({ approvalId: 'layout-test', layoutFingerprint: hostFingerprint, ...body, elements: [{ ...body.elements[0], x: 900 }], approvedAt: 2 })
  assert.equal(replacement.ok, false)
})

test('formal stage fixtures no longer contain fixed-coordinate or snapshot_changed oracles', () => {
  const root = path.resolve('scripts/test/scenarios')
  for (const file of ['player-morph-toggle.json', 'kill-feed-hud.json', 'death-rewind.json', 'complete-project-minimax.json']) {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>
    // Prompts may mention legacy patterns to explicitly forbid them.  Only
    // compiled contracts/specs are objective oracles and must be clean.
    const oracleText = JSON.stringify({ acceptanceContract: parsed.acceptanceContract, gameTestContract: parsed.gameTestContract, gameTestSpec: parsed.gameTestSpec })
    assert.doesNotMatch(oracleText, /snapshot_changed|snapshot_unchanged|"equals":\s*20|"equals":\s*4\.5|minecraft:diamond/)
  }
})
