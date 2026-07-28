import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mcTestScenarioTool,
  getSupportedFeatureTypes
} from '../../src/renderer/src/harness/mc-test-scenario-tool.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

const ctx: ToolContext = {
  projectPath: '/tmp/proj',
  callId: 'test-call'
}

test('mc_test_scenario: tool metadata is correct', () => {
  assert.equal(mcTestScenarioTool.name, 'mc_test_scenario')
  assert.equal(mcTestScenarioTool.readOnly(), true)
  assert.ok(mcTestScenarioTool.description.includes('feature_type'))
  assert.ok(mcTestScenarioTool.description.includes('entity_behavior'))
})

test('mc_test_scenario: getSupportedFeatureTypes returns all 6 types', () => {
  const types = getSupportedFeatureTypes()
  assert.deepEqual(types.sort(), [
    'entity_behavior',
    'hud_gui',
    'new_block',
    'new_item',
    'new_recipe',
    'player_interaction'
  ])
})

test('mc_test_scenario: invalid feature_type returns error with available types', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'invalid_type' })
  const output = String(result)
  assert.match(output, /无效的 feature_type/)
  assert.match(output, /new_item/)
  assert.match(output, /entity_behavior/)
  assert.match(output, /hud_gui/)
})

test('mc_test_scenario: new_item template contains give and use steps', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'new_item' })
  const output = String(result)
  assert.match(output, /新物品功能测试/)
  assert.match(output, /mc_command/)
  assert.match(output, /give @s/)
  assert.match(output, /mc_input/)
  assert.match(output, /action.*use/)
  assert.match(output, /mc_screenshot/)
  assert.match(output, /mc_inventory/)
  assert.match(output, /物品成功给予并显示在主手/)
})

test('mc_test_scenario: new_block template contains setblock step', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'new_block' })
  const output = String(result)
  assert.match(output, /新方块功能测试/)
  assert.match(output, /setblock/)
  assert.match(output, /碰撞箱/)
  assert.match(output, /mc_screenshot/)
})

test('mc_test_scenario: new_recipe template contains crafting steps', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'new_recipe' })
  const output = String(result)
  assert.match(output, /新合成配方测试/)
  assert.match(output, /give @s/)
  assert.match(output, /合成台|crafting_table/)
})

test('mc_test_scenario: entity_behavior template includes mc_observe_entity steps', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'entity_behavior' })
  const output = String(result)
  assert.match(output, /实体行为修改测试/)
  assert.match(output, /summon/)
  assert.match(output, /mc_observe_entity/)
  assert.match(output, /type/)
  // 必须包含两次 mc_observe_entity 调用（初始状态 + 状态变化对比）
  const matches = output.match(/mc_observe_entity/g) || []
  assert.ok(matches.length >= 2, 'entity_behavior template should call mc_observe_entity at least twice')
  assert.match(output, /爆炸倒计时|传送|樱花粒子|行为修改/)
})

test('mc_test_scenario: player_interaction template includes trigger item steps', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'player_interaction' })
  const output = String(result)
  assert.match(output, /玩家交互功能测试/)
  assert.match(output, /give @s/)
  assert.match(output, /action.*use/)
  assert.match(output, /mc_world/)
})

test('mc_test_scenario: hud_gui template includes hotkey and widget click', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'hud_gui' })
  const output = String(result)
  assert.match(output, /HUD.*界面功能测试/)
  assert.match(output, /key_press/)
  assert.match(output, /hotkey|f6/)
  assert.match(output, /mc_inspect/)
  assert.match(output, /click_widget/)
})

test('mc_test_scenario: feature_detail is included in output when provided', async () => {
  const result = await mcTestScenarioTool.execute(ctx, {
    feature_type: 'entity_behavior',
    feature_detail: 'creeper_sakura_explosion'
  })
  const output = String(result)
  assert.match(output, /creeper_sakura_explosion/)
})

test('mc_test_scenario: mod_id is included in output when provided', async () => {
  const result = await mcTestScenarioTool.execute(ctx, {
    feature_type: 'new_item',
    mod_id: 'my_mod'
  })
  const output = String(result)
  assert.match(output, /my_mod/)
  assert.match(output, /模组 ID：my_mod/)
  assert.match(output, /modid.*替换为此值/)
})

test('mc_test_scenario: entity_behavior explicitly forbids screenshot-only verification', async () => {
  const result = await mcTestScenarioTool.execute(ctx, { feature_type: 'entity_behavior' })
  const output = String(result)
  assert.match(output, /mc_observe_entity.*对比状态变化/)
  assert.match(output, /禁止仅凭截图/)
})
