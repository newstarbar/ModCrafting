import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_ROLE_IDS,
  BUILTIN_ROUTING_PRESETS,
  allRoutingPresets,
  buildStaticRouteDecision,
  defaultRoutingConfig,
  findRoutingPreset,
  normalizeRoutingConfig
} from '../../src/shared/model-routing.ts'
import { collaborationForAutomation, toolArgsForAutomation, toolOutputForAutomation } from '../../src/renderer/src/harness/automation-event-projection.ts'

test('routing presets cover every fixed Harness role', () => {
  for (const preset of BUILTIN_ROUTING_PRESETS) {
    assert.deepEqual(Object.keys(preset.roles).sort(), [...AGENT_ROLE_IDS].sort())
    assert.ok(preset.roles.implementer.required)
  }
})

test('route decision keeps a single writer and requires visual review for GUI', () => {
  const ui = buildStaticRouteDecision('请为模组做一个设置 GUI 界面', 'auto')
  assert.equal(ui.taskTemplateId, 'ui')
  assert.ok(ui.roles.includes('visualReviewer'))
  assert.equal(ui.delegations.filter((task) => !task.readOnly).map((task) => task.roleId).join(','), 'implementer')
})

test('bug reports route through debugger and Minecraft content through explorer', () => {
  const bug = buildStaticRouteDecision('构建报错，帮我修复这个崩溃', 'auto')
  const minecraft = buildStaticRouteDecision('新增一个方块和配方', 'auto')
  assert.equal(bug.taskTemplateId, 'bugfix')
  assert.ok(bug.roles.includes('debugger'))
  assert.equal(minecraft.taskTemplateId, 'minecraft')
  assert.ok(minecraft.roles.includes('explorer'))
})

test('routing config sanitizes hard limits and ignores malformed presets', () => {
  const config = normalizeRoutingConfig({
    onboardingCompleted: true,
    hardLimits: { maxReadonlyConcurrency: 99, maxDelegations: -3, maxExpertRepairHandoffs: 8 },
    presets: [{ id: 'bad' }]
  })
  assert.equal(config.hardLimits.maxReadonlyConcurrency, 3)
  assert.equal(config.hardLimits.maxDelegations, 1)
  assert.equal(config.hardLimits.maxExpertRepairHandoffs, 3)
  assert.equal(config.presets.length, 0)
  assert.equal(findRoutingPreset(config, 'missing').id, 'balanced')
  assert.ok(allRoutingPresets(defaultRoutingConfig()).length >= 7)
})

test('Test Lab collaboration projection preserves single-model proof without secrets', () => {
  const projected = collaborationForAutomation({
    id: 'role_1', roleId: 'planner', providerId: 'minimax', modelId: 'MiniMax-M3',
    status: 'completed', startedAt: 10, endedAt: 20, summary: '职责完成'
  })
  assert.equal(projected.providerId, 'minimax')
  assert.equal(projected.modelId, 'MiniMax-M3')
  assert.equal('apiKey' in projected, false)
})

test('Test Lab retains only structural plan/game-test evidence', () => {
  assert.equal(toolArgsForAutomation('mc_test_scenario', '{"actions":[]}'), '{"actions":[]}')
  assert.equal(toolOutputForAutomation('mc_run_test', '{"verdict":"PASS"}'), '{"verdict":"PASS"}')
  assert.equal(toolArgsForAutomation('configure_provider', '{"apiKey":"secret"}'), undefined)
  assert.equal(toolOutputForAutomation('read_file', 'source'), undefined)
})
