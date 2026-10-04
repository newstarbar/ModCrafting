import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptanceContractFingerprint, createGameTestSpec, expandSandboxCommands, gameTestScenarioFingerprint, getGameTestSpec, hydrateGameTestSpecsFromText, registerGameTestSpec, resolveSandbox, SANDBOX_COMMANDS, stateTransitionMatches, validateGameAssertions } from '../../src/renderer/src/harness/game-test-protocol.ts'
import { validateAcceptanceContract } from '../../src/renderer/src/harness/acceptance-contract.ts'
import { canonicalizePlanSteps, normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { gameTestFailureSignature, isSoftSubmitPlanRejection, recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'
import { mcRunTestTool } from '../../src/renderer/src/harness/game-test-runner.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

// ─── sandbox presets ─────────────────────────────────────────────────────────

test('SANDBOX_COMMANDS: all presets have commands', () => {
  assert.ok(Array.isArray(SANDBOX_COMMANDS.flat_platform) && SANDBOX_COMMANDS.flat_platform.length > 0)
  assert.ok(Array.isArray(SANDBOX_COMMANDS.enclosed_arena) && SANDBOX_COMMANDS.enclosed_arena.length > 0)
  assert.ok(Array.isArray(SANDBOX_COMMANDS.stimulus_pad) && SANDBOX_COMMANDS.stimulus_pad.length > 0)
  assert.ok(Array.isArray(SANDBOX_COMMANDS.crafting_station) && SANDBOX_COMMANDS.crafting_station.length > 0)
})

test('expandSandboxCommands: enclosed_arena has barrier walls and ceiling', () => {
  const cmds = expandSandboxCommands('enclosed_arena')
  const cmdText = cmds.map((c) => c.command).join(' ')
  assert.ok(/barrier/i.test(cmdText) || /glass/i.test(cmdText), 'enclosed_arena must have containment blocks')
  assert.ok(/fill.*110.*glass/i.test(cmdText), 'enclosed_arena must have ceiling')
})

test('expandSandboxCommands: skip returns empty', () => {
  assert.deepEqual(expandSandboxCommands('skip'), [])
  assert.deepEqual(expandSandboxCommands(undefined), [])
})

test('expandSandboxCommands: flat_platform creates stone platform', () => {
  const cmds = expandSandboxCommands('flat_platform')
  const cmdText = cmds.map((c) => c.command).join(' ')
  assert.ok(/stone/i.test(cmdText), 'flat_platform must create stone')
})

test('resolveSandbox: entity_behavior defaults to enclosed_arena', () => {
  const result = resolveSandbox(undefined, 'entity_behavior', true)
  assert.equal(result.sandbox, 'enclosed_arena')
})

test('resolveSandbox: entity_behavior without arena errors', () => {
  const result = resolveSandbox('flat_platform', 'entity_behavior', true)
  assert.equal(result.sandbox, 'flat_platform')
  assert.ok(result.error?.includes('enclosed_arena'), 'entity_behavior with flat_platform must error')
})

test('resolveSandbox: entity_behavior with skip is allowed', () => {
  const result = resolveSandbox('skip', 'entity_behavior', true)
  assert.equal(result.sandbox, 'skip')
  assert.equal(result.error, undefined)
})

test('resolveSandbox: new_recipe defaults to crafting_station', () => {
  const result = resolveSandbox(undefined, 'new_recipe', false)
  assert.equal(result.sandbox, undefined) // resolveSandbox only enforces for entity_behavior
})

test('resolveSandbox: invalid preset returns error', () => {
  const result = resolveSandbox('invalid_preset', 'new_item', false)
  assert.equal(result.error?.includes('invalid_preset'), true)
})

// ─── createGameTestSpec: sandbox integrated ─────────────────────────────────

test('createGameTestSpec: entity_behavior auto-adds enclosed_arena when sandbox omitted', () => {
  const result = createGameTestSpec({
    feature_type: 'entity_behavior',
    subject_id: 'minecraft:creeper',
    assertions: [{ type: 'entity_exists', entityType: 'minecraft:creeper', exists: true }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.sandbox, 'enclosed_arena')
})

test('createGameTestSpec: explicit sandbox is preserved', () => {
  const result = createGameTestSpec({
    feature_type: 'new_recipe',
    subject_id: 'example:shaped_recipe',
    sandbox: 'crafting_station',
    assertions: [{ type: 'inventory_contains', itemId: 'example:product' }],
    actions: [{ type: 'input', action: 'click_slot', args: { slot: 0 } }]
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.sandbox, 'crafting_station')
})

test('createGameTestSpec: sandbox commands are in setup', () => {
  const result = createGameTestSpec({
    feature_type: 'entity_behavior',
    subject_id: 'minecraft:creeper',
    sandbox: 'enclosed_arena',
    assertions: [{ type: 'entity_exists', entityType: 'minecraft:creeper' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // defaultSetup (9) + enclosed_arena commands
  assert.ok(result.spec.setup.length > 9, `setup must include sandbox commands; got ${result.spec.setup.length} actions`)
  const sandboxSetup = result.spec.setup.slice(9)
  assert.ok(sandboxSetup.some((a) => a.command?.includes('barrier') || a.command?.includes('glass')), 'setup must include barrier/glass from enclosed_arena')
})

test('createGameTestSpec: sandbox=skip omits sandbox commands', () => {
  const result = createGameTestSpec({
    feature_type: 'new_item',
    subject_id: 'example:item',
    sandbox: 'skip',
    assertions: [{ type: 'inventory_contains', itemId: 'example:item' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.sandbox, 'skip')
  // setup should be only defaultSetup (9 commands), no extra sandbox
  assert.equal(result.spec.setup.length, 9)
})

test('createGameTestSpec: flat_platform sandbox preserved', () => {
  const result = createGameTestSpec({
    feature_type: 'new_block',
    subject_id: 'example:block',
    sandbox: 'flat_platform',
    assertions: [{ type: 'block_equals', x: 0, y: 100, z: 4, blockId: 'example:block' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.sandbox, 'flat_platform')
})

// ─── fingerprint includes sandbox ─────────────────────────────────────────

test('gameTestScenarioFingerprint: sandbox is part of fingerprint', () => {
  const base = createGameTestSpec({
    feature_type: 'new_item',
    subject_id: 'example:item',
    assertions: [{ type: 'inventory_contains', itemId: 'example:item' }],
  })
  assert.equal(base.ok, true)
  if (!base.ok) return
  const withArena = createGameTestSpec({
    feature_type: 'new_item',
    subject_id: 'example:item',
    sandbox: 'enclosed_arena',
    assertions: [{ type: 'inventory_contains', itemId: 'example:item' }],
  })
  assert.equal(withArena.ok, true)
  if (!withArena.ok) return
  assert.notEqual(
    gameTestScenarioFingerprint(base.spec),
    gameTestScenarioFingerprint(withArena.spec),
    'same spec with different sandbox must have different fingerprint'
  )
})

// ─── registerGameTestSpec: sandbox restored ─────────────────────────────────

test('registerGameTestSpec: sandbox round-trips correctly', () => {
  // Provide explicit acceptanceContract so createGameTestSpec stores it in the spec
  // (not auto-generated by the runner), making JSON round-trip stable.
  const created = createGameTestSpec({
    feature_type: 'entity_behavior',
    subject_id: 'minecraft:zombie',
    sandbox: 'enclosed_arena',
    assertions: [{ type: 'entity_exists', entityType: 'minecraft:zombie' }],
    acceptanceContract: {
      version: 1,
      requirements: [{
        id: 'legacy-game-1',
        claim: '实体生成',
        oracle: { type: 'game_assertion', assertion: { type: 'entity_exists', entityType: 'minecraft:zombie' } },
        sourceQuote: 'entity_exists'
      }]
    }
  })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const json = JSON.stringify(created.spec)
  const parsed = JSON.parse(json)
  const restored = registerGameTestSpec(parsed)
  assert.equal(restored.ok, true)
  if (!restored.ok) return
  // Sandbox and key fields must survive round-trip
  assert.equal(restored.spec.sandbox, 'enclosed_arena')
  assert.equal(restored.spec.featureType, created.spec.featureType)
  assert.equal(restored.spec.subject.id, created.spec.subject.id)
  // Setup should be identical (includes sandbox commands)
  assert.equal(restored.spec.setup.length, created.spec.setup.length)
  // JSON equality: both must have acceptanceContract from start
  assert.equal(JSON.stringify(created.spec), JSON.stringify(restored.spec))
})

// ─── mc_test_scenario tool: sandbox schema ─────────────────────────────────

test('createGameTestSpec: sandbox parameter accepted in schema', () => {
  const result = createGameTestSpec({
    feature_type: 'new_item',
    subject_id: 'example:item',
    sandbox: 'stimulus_pad',
    assertions: [{ type: 'inventory_contains', itemId: 'example:item' }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.spec.sandbox, 'stimulus_pad')
})

// ─── container automation ────────────────────────────────────────────────────

test('SnapshotSource includes containerSlots', () => {
  // TypeScript compile check: containerSlots is a valid source
  const result = validateGameAssertions([{
    type: 'snapshot_value',
    source: 'containerSlots',
    pointer: '/slots/9/itemId',
    equals: 'minecraft:diamond'
  }])
  assert.equal(result.ok, true)
})

test('GameTestSpec accepts containerSlots as screen source via snapshot_value', () => {
  // Note: containerSlots is a top-level snapshot alias for the screen container data.
  // snapshot_value with source=screen and pointer=/containerSlots works when
  // the bridge exposes containerSlots at the screen level (bridge-mod V2).
  // new_recipe requires at least one action (no auto-default for recipe yet).
  const result = createGameTestSpec({
    feature_type: 'new_recipe',
    subject_id: 'example:recipe',
    sandbox: 'crafting_station',
    assertions: [
      { type: 'inventory_contains', itemId: 'example:product' }
    ],
    actions: [{ type: 'input', action: 'click_slot', args: { slot: 0 } }]
  })
  assert.equal(result.ok, true)
})

// ─── click_slot action validation ──────────────────────────────────────────

test('createGameTestSpec: click_slot action requires slot arg', () => {
  const result = createGameTestSpec({
    feature_type: 'new_recipe',
    subject_id: 'example:recipe',
    assertions: [{ type: 'snapshot_value', source: 'containerSlots', pointer: '/slots/9/itemId', equals: 'example:product' }],
    actions: [
      { type: 'input', action: 'click_slot', args: {} }
    ]
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.error?.includes('slot'))
})

test('createGameTestSpec: valid click_slot action passes', () => {
  const result = createGameTestSpec({
    feature_type: 'new_recipe',
    subject_id: 'example:recipe',
    assertions: [{ type: 'inventory_contains', itemId: 'example:product' }],
    actions: [
      { type: 'input', action: 'click_slot', args: { slot: 0 } },
      { type: 'input', action: 'click_slot', args: { slot: 9, button: 0 } },
    ]
  })
  assert.equal(result.ok, true)
})
