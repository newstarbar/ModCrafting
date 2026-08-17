import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAppGameTestContract } from './app-game-test-contract.ts'

function event(kind: string, tool: Record<string, unknown>): Record<string, unknown> {
  return { kind, tool }
}

test('app game contract links PASS to its compiled scenario and checks full coverage', () => {
  const args = {
    actions: [
      { type: 'input', action: 'key_press', args: { key: 'g' } },
      { type: 'input', action: 'key_press', args: { key: 'g' } },
      { type: 'wait', ms: 61_000 },
      { type: 'command', command: 'kill @s' }
    ],
    assertions: [
      { type: 'snapshot_changed', source: 'player', pointer: '/width', afterAction: 0 },
      { type: 'snapshot_changed', source: 'player', pointer: '/width', afterAction: 1 },
      { type: 'hud_text', text: 'KILL', match: 'contains', afterAction: 2 }
    ]
  }
  const events = [
    event('ToolResult', { name: 'mc_test_scenario', args: JSON.stringify(args), output: '```json\n{"id": "scenario_all"}\n```' }),
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_all"}', validation: { verdict: 'PASS' } })
  ]
  const result = evaluateAppGameTestContract(events, {
    requiredAssertions: [
      { type: 'snapshot_changed', source: 'player', pointer: '/width' },
      { type: 'snapshot_changed', source: 'player', pointer: '/width' },
      { type: 'hud_text' }
    ],
    requiredInputKeys: { g: 2 },
    minimumWaitMs: 60_000,
    requiredCommandPatterns: ['kill\\s+@s']
  })
  assert.equal(result.passed, true)
  assert.equal(result.scenarioId, 'scenario_all')
})

test('a narrow PASS scenario cannot satisfy a complete-project contract', () => {
  const events = [
    event('ToolResult', { name: 'mc_test_scenario', args: '{"actions":[],"assertions":[{"type":"hud_text"}]}', output: '{"id":"scenario_hud"}' }),
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_hud"}', validation: { verdict: 'PASS' } })
  ]
  const result = evaluateAppGameTestContract(events, {
    requiredAssertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width' }],
    requiredInputKeys: { g: 2 },
    minimumWaitMs: 60_000
  })
  assert.equal(result.passed, false)
  assert.match(result.details.join('\n'), /missing assertion/)
})

test('a submit_plan game test is auditable through its PlanState scenario id', () => {
  const spec = {
    id: 'scenario_planned',
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width' }]
  }
  const events = [
    { kind: 'PlanState', planSteps: [{ id: '8', gameTest: spec }] },
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_planned"}', validation: { verdict: 'PASS' } })
  ]
  const result = evaluateAppGameTestContract(events, {
    requiredAssertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width' }],
    requiredInputKeys: { g: 1 }
  })
  assert.equal(result.passed, true)
})

test('complete-project contracts require two full PASS runs for the final scenario', () => {
  const args = {
    requiredPassCount: 2,
    actions: [{ type: 'input', action: 'key_press', args: { key: 'g' } }],
    assertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width' }]
  }
  const base = [
    event('ToolResult', { name: 'mc_test_scenario', args: JSON.stringify(args), output: '{"id":"scenario_final"}' })
  ]
  const contract = {
    requiredAssertions: [{ type: 'snapshot_changed', source: 'player', pointer: '/width' }],
    minimumPassCount: 2
  }
  const once = evaluateAppGameTestContract([
    ...base,
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_final"}', validation: { verdict: 'PASS' } })
  ], contract)
  assert.equal(once.passed, false)
  assert.match(once.details.join('\n'), /PASS count 1 < required 2/)

  const twice = evaluateAppGameTestContract([
    ...base,
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_final"}', validation: { verdict: 'PASS' } }),
    event('ToolResult', { name: 'trigger_build', args: '{"task":"runClient"}', output: 'runClient restarted' }),
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_final"}', validation: { verdict: 'PASS' } })
  ], contract)
  assert.equal(twice.passed, true)
  assert.equal(twice.scenarioId, 'scenario_final')
})

test('strict contracts reject a formal PASS without named checkpoints and independent evidence', () => {
	const args = {
		requiredPassCount: 2,
		actions: [{ type: 'input', action: 'key_press', args: { key: 'g' }, checkpoint: 'M1' }],
		checkpoints: ['M0', 'M1'],
		assertions: [{ type: 'snapshot_relation', source: 'player', pointer: '/width', leftCheckpoint: 'M0', rightCheckpoint: 'M1', operator: 'ratio', ratio: 0.5 }]
	}
	const events = [
		event('ToolResult', { name: 'mc_test_scenario', args: JSON.stringify(args), output: '{"id":"scenario_strict"}' }),
		event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_strict"}', validation: { verdict: 'PASS' } })
	]
	const result = evaluateAppGameTestContract(events, { requiredCheckpoints: ['M0', 'M1'], requiredRelationOperators: ['ratio'], minimumPassCount: 2, requireIndependentReplay: true })
	assert.equal(result.passed, false)
	assert.match(result.details.join('\n'), /independent replay evidence/)
})

test('formal Suite stages require source write, successful build and ready client launch', () => {
  const args = {
    actions: [{ type: 'wait', ms: 1, checkpoint: 'M1' }],
    checkpoints: ['M0', 'M1'],
    assertions: [{ type: 'snapshot_relation', left: { checkpoint: 'M0', source: 'serverPlayer', pointer: '/width' }, right: { checkpoint: 'M1', source: 'serverPlayer', pointer: '/width' }, operator: 'ratio', ratio: 0.5, tolerance: 0.02 }]
  }
  const base = [
    event('ToolResult', { name: 'mc_test_scenario', args: JSON.stringify(args), output: '{"id":"scenario_stage"}' }),
    event('ToolResult', { name: 'mc_run_test', args: '{"scenarioId":"scenario_stage"}', validation: { verdict: 'PASS' } })
  ]
  const contract = { requiredProjectWrite: true, requiredBuildTasks: ['build', 'runClient'] as const, requiredAssertions: [{ type: 'snapshot_relation' }] }
  const missing = evaluateAppGameTestContract(base, contract)
  assert.equal(missing.passed, false)
  assert.match(missing.details.join('\n'), /project source write|trigger_build task/)
  const complete = evaluateAppGameTestContract([
    event('ToolResult', { name: 'edit_file', args: '{}', outcome: 'succeeded' }),
    event('ToolResult', { name: 'trigger_build', args: '{"task":"build"}', output: 'BUILD SUCCESSFUL', outcome: 'succeeded' }),
    event('ToolResult', { name: 'trigger_build', args: '{"task":"runClient"}', output: '[MC_PHASE:ready]', outcome: 'succeeded' }),
    ...base
  ], contract)
  assert.equal(complete.passed, true)
})
