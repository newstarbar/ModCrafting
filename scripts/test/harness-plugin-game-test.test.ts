import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { executeGameTest, evaluateGameAssertion, validateGameTestSpec, GAME_TEST_WORLD, JobManager, type GameTestSpec, type GameAssertion, type GameTestAdapter } from '../../packages/modcrafting-core/src/index.ts'

const spec = (assertion: GameAssertion = { type: 'inventory_contains', itemId: 'minecraft:stone' }): GameTestSpec => ({ version: 2, id: 'fixture', featureType: 'new_item', subject: {}, setup: [], actions: [{ type: 'wait', ms: 0 }], assertions: [assertion], cleanup: [{ type: 'command', command: 'fixture-cleanup' }] })
const snapshot = (extra: Record<string, unknown> = {}) => ({ ok: true, worldName: GAME_TEST_WORLD, requestId: 'fixture', observedAt: 100, inventory: { ok: true, hotbar: [], main: [{ id: 'minecraft:stone', count: 2 }], armor: [], offhand: [] }, blocks: [{ x: 1, y: 100, z: 2, blockId: 'minecraft:stone' }], entities: [{ type: 'minecraft:pig', name: 'Fixture Pig', team: 'fixture_team', tags: ['fixture'], health: 20, maxHealth: 20, attackDamage: 2, movementSpeed: 0.25 }], player: { health: 20 }, ...extra })
function fake(options: { before?: Record<string, unknown>; after?: Record<string, unknown>; world?: string; throwAction?: boolean; failCleanup?: boolean; throwSnapshot?: boolean; cancelled?: boolean } = {}) {
  let count = 0
  const calls: string[] = []
  const adapter: GameTestAdapter = {
    snapshot: async () => {
      if (options.throwSnapshot) throw new Error('Observer unavailable')
      count++
      return { ok: true, data: snapshot({ requestId: `fixture_${count}`, ...(count < 3 ? options.before : options.after), ...(options.world ? { worldName: options.world } : {}) }) }
    },
    action: async (action) => {
      const cleanup = action.type === 'command' && action.command === 'fixture-cleanup'
      calls.push(cleanup ? 'cleanup' : 'action')
      if (cleanup && options.failCleanup) throw new Error('cleanup failed')
      if (!cleanup && options.throwAction) throw new Error('action failed')
      return { ok: true, data: {} }
    },
    cancelled: () => Boolean(options.cancelled)
  }
  return { adapter, calls }
}

const invalid: Array<[string, unknown]> = [
  ['empty assertions', { ...spec(), assertions: [] }],
  ['empty actions', { ...spec(), actions: [] }],
  ['unknown assertion', { ...spec(), assertions: [{ type: 'invented' }] }],
  ['missing item ID', { ...spec(), assertions: [{ type: 'inventory_contains' }] }],
  ['missing coordinates', { ...spec(), assertions: [{ type: 'block_equals', blockId: 'minecraft:stone' }] }],
  ['missing pointer', { ...spec(), assertions: [{ type: 'snapshot_value', source: 'player', equals: 20 }] }],
  ['missing equals', { ...spec(), assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/health' }] }],
  ['unknown source', { ...spec(), assertions: [{ type: 'snapshot_value', source: 'unknown', pointer: '/health', equals: 20 }] }],
  ['unsafe pointer', { ...spec(), assertions: [{ type: 'snapshot_value', source: 'player', pointer: '/__proto__', equals: {} }] }],
  ['unfiltered entities', { ...spec(), assertions: [{ type: 'entity_exists' }] }],
  ['entity attribute without target', { ...spec(), assertions: [{ type: 'entity_attribute', target: {}, attribute: 'health', equals: 20 }] }],
  ['entity attribute without comparison', { ...spec(), assertions: [{ type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'health' }] }],
  ['entity attribute unknown attribute', { ...spec(), assertions: [{ type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'luck', equals: 1 }] }],
  ['entity name without expected value', { ...spec(), assertions: [{ type: 'entity_name', target: { entityType: 'minecraft:pig' } }] }],
  ['entity team without team', { ...spec(), assertions: [{ type: 'entity_team', target: { entityType: 'minecraft:pig' } }] }],
  ['bad count', { ...spec(), assertions: [{ type: 'inventory_contains', itemId: 'minecraft:stone', countAtLeast: 0 }] }],
  ['unknown action', { ...spec(), actions: [{ type: 'exec' }] }],
  ['negative wait', { ...spec(), actions: [{ type: 'wait', ms: -1 }] }],
  ['unbounded wait', { ...spec(), actions: [{ type: 'wait', ms: 10001 }] }],
  ['empty command', { ...spec(), actions: [{ type: 'command', command: ' ' }] }],
  ['bad input args', { ...spec(), actions: [{ type: 'input', action: 'click', args: [] }] }],
  ['report traversal', { ...spec(), id: '../../user-file' }],
  ['invalid subject', { ...spec(), subject: null }]
]
for (const [name, value] of invalid) test(`INVALID_SPEC: ${name}`, async () => {
  const parsed = validateGameTestSpec(value)
  assert.equal(parsed.ok, false)
  const { adapter, calls } = fake()
  const result = await executeGameTest(value, adapter, 'fixture-version', 'fixture')
  assert.equal(result.code, 'INVALID_SPEC')
  assert.notEqual(result.verdict, 'PASS')
  assert.deepEqual(calls, [])
})

test('Live entity tags are unavailable even when client tags are empty or a fixture supplies them', async () => {
  for (const tags of [[], ['fixture']]) {
    const { adapter, calls } = fake({ after: { entities: [{ type: 'minecraft:pig', tags }] } })
    const result = await executeGameTest(spec({ type: 'entity_exists', entityType: 'minecraft:pig', tag: 'fixture' }), adapter, 'fixture-version', 'live')
    assert.equal(result.verdict, 'INCONCLUSIVE')
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE')
    assert.equal((result.acceptance as { evidence: Array<{ unavailable: boolean }> }).evidence[0].unavailable, true)
    assert.deepEqual(calls, ['action', 'cleanup'])
  }
})

for (const assertion of [
  { type: 'inventory_contains', itemId: 'minecraft:stone', countAtLeast: 2 },
  { type: 'block_equals', x: 1, y: 100, z: 2, blockId: 'minecraft:stone' },
  { type: 'entity_exists', entityType: 'minecraft:pig', tag: 'fixture', exists: true },
  { type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'maxHealth', equals: 20 },
  { type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'attackDamage', atLeast: 2 },
  { type: 'entity_name', target: { entityType: 'minecraft:pig' }, contains: 'Fixture' },
  { type: 'entity_team', target: { entityType: 'minecraft:pig' }, team: 'fixture_team' },
  { type: 'snapshot_value', source: 'player', pointer: '/health', equals: 20 },
  { type: 'snapshot_changed', source: 'player', pointer: '/health', from: 19, to: 20 }
] as GameAssertion[]) test(`Fresh supported ${assertion.type} can PASS`, async () => {
  const { adapter, calls } = fake({ before: { player: { health: 19 } } })
  const value = await executeGameTest(spec(assertion), adapter, 'fixture-version', 'fixture')
  assert.equal(value.verdict, 'PASS')
  assert.equal(value.code, 'OK')
  assert.equal(value.version, 'fixture-version', 'fixture')
  assert.equal(value.scenarioId, 'fixture')
  assert.deepEqual(calls, ['action', 'cleanup'])
})

for (const assertion of [
  { type: 'hud_text', text: 'old success', match: 'contains' },
  { type: 'command_result', command: 'say fixture', minResult: 1 },
  { type: 'snapshot_value', source: 'hudTrace', pointer: '/0/text', equals: 'old success' }
] as GameAssertion[]) test(`Unsupported freshness/capability: ${assertion.type}`, async () => {
  const { adapter } = fake({ after: { hudTrace: [{ sequence: 1, text: 'old success' }] } })
  const value = await executeGameTest(spec(assertion), adapter, 'fixture-version', 'fixture')
  assert.equal(value.verdict, 'INCONCLUSIVE')
  assert.equal(value.code, 'CAPABILITY_UNAVAILABLE')
})

test('Entity attribute/name/team mismatches are FAIL; missing observed fields are INCONCLUSIVE', async () => {
  for (const [assertion, entities, verdict, code] of [
    [{ type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'maxHealth', equals: 21 }, undefined, 'FAIL', 'ASSERTION_FAILED'],
    [{ type: 'entity_attribute', target: { entityType: 'minecraft:pig' }, attribute: 'maxHealth', equals: 20 }, [{ type: 'minecraft:pig' }], 'INCONCLUSIVE', 'EVIDENCE_MISSING'],
    [{ type: 'entity_name', target: { entityType: 'minecraft:pig' }, equals: 'Other Pig' }, undefined, 'FAIL', 'ASSERTION_FAILED'],
    [{ type: 'entity_team', target: { entityType: 'minecraft:pig' }, team: 'other_team' }, undefined, 'FAIL', 'ASSERTION_FAILED'],
    [{ type: 'entity_attribute', target: { entityType: 'minecraft:sheep' }, attribute: 'maxHealth', equals: 20 }, undefined, 'FAIL', 'ASSERTION_FAILED']
  ] as Array<[GameAssertion, undefined | Array<Record<string, unknown>>, string, string]>) {
    const { adapter } = fake({ after: entities ? { entities } : {} })
    const value = await executeGameTest(spec(assertion), adapter, 'fixture-version', 'fixture')
    assert.equal(value.verdict, verdict)
    assert.equal(value.code, code)
  }
})

test('Observed mismatch is FAIL; missing inventory is INCONCLUSIVE', async () => {
  for (const [inventory, verdict, code] of [[{ ok: true, main: [], hotbar: [], armor: [], offhand: [] }, 'FAIL', 'ASSERTION_FAILED'], [undefined, 'INCONCLUSIVE', 'EVIDENCE_MISSING']] as const) {
    const { adapter } = fake({ after: { inventory } })
    const result = await executeGameTest(spec(), adapter, 'fixture-version', 'fixture')
    assert.equal(result.verdict, verdict)
    assert.equal(result.code, code)
  }
})
test('Observer missing and non-test-world never execute actions or claim PASS', async () => {
  for (const options of [{ throwSnapshot: true }, { world: 'Real user world' }]) {
    const { adapter, calls } = fake(options)
    const result = await executeGameTest(spec(), adapter, 'fixture-version', 'fixture')
    assert.equal(result.verdict, 'INCONCLUSIVE')
    assert.equal(result.code, 'ENVIRONMENT_UNAVAILABLE')
    assert.deepEqual(calls, [])
  }
})
test('Action throws: cleanup still runs; cleanup failure invalidates PASS', async () => {
  for (const options of [{ throwAction: true }, { failCleanup: true }]) {
    const { adapter, calls } = fake(options)
    const result = await executeGameTest(spec(), adapter, 'fixture-version', 'fixture')
    assert.equal(result.verdict, 'INCONCLUSIVE')
    assert.ok(calls.includes('cleanup'))
    assert.equal(result.code, options.failCleanup ? 'CLEANUP_FAILED' : 'ENVIRONMENT_UNAVAILABLE')
  }
})
test('Missing, failed, stale, or incomplete snapshots never PASS', async () => {
  for (const after of [{ ok: false }, { requestId: 'fixture_2' }, { observedAt: undefined }, { inventory: { ok: false } }, { inventory: { main: [], hotbar: [], armor: [] } }]) {
    const { adapter } = fake({ after })
    assert.notEqual((await executeGameTest(spec(), adapter, 'fixture-version', 'fixture')).verdict, 'PASS')
  }
})
test('Missing entity query cannot satisfy exists=false, missing blocks/pointers stay inconclusive', async () => {
  for (const [assertion, data] of [
    [{ type: 'entity_exists', entityType: 'minecraft:pig', exists: false }, { entities: undefined }],
    [{ type: 'entity_exists', entityType: 'minecraft:pig', exists: false }, { entities: Array.from({ length: 64 }, () => ({ type: 'minecraft:cow' })) }],
    [{ type: 'block_equals', x: 1, y: 100, z: 2, blockId: 'minecraft:stone' }, { blocks: [] }],
    [{ type: 'snapshot_changed', source: 'player', pointer: '/health', to: 20 }, { player: { health: 20 } }]
  ] as Array<[GameAssertion, Record<string, unknown>]>) {
    const { adapter } = fake({ before: { player: {} }, after: data })
    const result = await executeGameTest(spec(assertion), adapter, 'fixture-version', 'fixture')
    assert.equal(result.verdict, 'INCONCLUSIVE')
    assert.equal(result.code, 'EVIDENCE_MISSING')
  }
})
test('Snapshot equality ignores object-key order', () => {
  const evidence = evaluateGameAssertion({ type: 'snapshot_value', source: 'player', pointer: '/value', equals: { b: 2, a: 1 } }, {}, { player: { value: { a: 1, b: 2 } } })
  assert.equal(evidence.passed, true)
})
test('Cancelled test attempts cleanup and cannot PASS', async () => {
  const { adapter, calls } = fake({ cancelled: true })
  const result = await executeGameTest(spec(), adapter, 'fixture-version', 'fixture')
  assert.equal(result.verdict, 'INCONCLUSIVE')
  assert.deepEqual(calls, ['cleanup'])
})
test('Stopped job does not become completed when its callback later settles', async () => {
  const jobs = new JobManager()
  let finish: () => void
  const wait = new Promise<void>((resolve) => { finish = resolve })
  const id = jobs.start('fixture', async (job) => { await wait; return { cancelled: job.cancelled() } })
  jobs.stop(id); finish!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(jobs.status(id).status, 'stopped')
  assert.deepEqual(jobs.status(id).result, { cancelled: true })
})
test('Cleanup attempts remaining actions after a failure, and never commands a switched world', async () => {
  const value = spec()
  value.cleanup.push({ type: 'wait', ms: 0 })
  const failed = fake({ failCleanup: true })
  const report = await executeGameTest(value, failed.adapter, 'fixture-version', 'fixture')
  assert.equal(report.code, 'CLEANUP_FAILED')
  assert.deepEqual(failed.calls, ['action', 'cleanup', 'action'])
  const switched = fake()
  let reads = 0
  const original = switched.adapter.snapshot
  switched.adapter.snapshot = async (spec) => { const value = await original(spec); if (++reads >= 4) value.data.worldName = 'Real world'; return value }
  assert.equal((await executeGameTest(spec(), switched.adapter, 'fixture-version', 'fixture')).code, 'CLEANUP_FAILED')
  assert.deepEqual(switched.calls, ['action'])
})
test('Live job status is JSON-safe and stop terminates its owned Windows process tree', { skip: process.platform !== 'win32' ? 'Windows process-tree fixture' : false }, async () => {
  const child = spawn(process.execPath, ['-e', 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"}); console.log(child.pid); setInterval(()=>{},1000)'], { windowsHide: true })
  let descendant: number | undefined
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const jobs = new JobManager()
  const id = jobs.start('fixture', async (job) => { job.setChild(child); await closed; return { cancelled: job.cancelled() } })
  const timeout = setTimeout(() => { child.kill(); if (descendant) { try { process.kill(descendant) } catch {} } }, 4000)
  try {
    descendant = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', (value) => resolve(Number(String(value).trim()))) })
    assert.ok(Number.isInteger(descendant) && descendant > 0)
    assert.equal(JSON.parse(JSON.stringify(jobs.status(id))).pid, child.pid)
    assert.equal('child' in jobs.status(id), false)
    jobs.stop(id)
    await closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(jobs.status(id).status, 'stopped')
    assert.throws(() => process.kill(descendant!, 0))
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    if (descendant) { try { process.kill(descendant) } catch {} }
  }
})
