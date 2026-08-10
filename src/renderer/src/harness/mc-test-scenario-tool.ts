import type { Tool } from './tools'
import { createGameTestSpec, formatGameTestSpec } from './game-test-protocol.ts'

/**
 * 功能测试场景模板。
 *
 * 进入游戏世界后，AI 必须先调用 mc_test_scenario 获取测试步骤脚本，
 * 再按步骤使用 mc_command / mc_input / mc_screenshot / mc_inspect / mc_world / mc_observe_entity
 * 等工具执行测试。
 *
 * 模板按 feature_type 分类，覆盖常见 Fabric 模组功能类型：
 *   - new_item          新物品（UseItemCallback / 物品交互）
 *   - new_block         新方块（放置 / onUse / 碰撞箱）
 *   - new_recipe        新合成配方（材料组合 / 产物验证）
 *   - entity_behavior   实体行为修改（苦力怕爆炸 / 末影人传送等）
 *   - player_interaction 玩家交互功能（闪电剑 / 右键触发效果）
 *   - hud_gui           HUD/界面（按键触发 / 控件交互）
 */

type FeatureType =
  | 'new_item'
  | 'new_block'
  | 'new_recipe'
  | 'entity_behavior'
  | 'player_interaction'
  | 'hud_gui'

interface ScenarioStep {
  /** 步骤序号（从 1 开始） */
  step: number
  /** 工具名称（mc_command / mc_input / mc_screenshot / mc_inspect / mc_world / mc_observe_entity / mc_chat / mc_inventory / mc_ensure_cheats） */
  tool: string
  /** 操作描述（中文，告知 AI 这一步做什么） */
  action: string
  /** 具体调用参数示例（AI 需根据实际 mod_id/item_id 替换占位符） */
  params: Record<string, unknown>
  /** 验证要点（这一步要观察什么） */
  verify: string
}

interface ScenarioTemplate {
  feature_type: FeatureType
  title: string
  description: string
  steps: ScenarioStep[]
  /** 验证完成的关键证据（用于判断功能是否生效） */
  successCriteria: string[]
}

const NEW_ITEM_TEMPLATE: ScenarioTemplate = {
  feature_type: 'new_item',
  title: '新物品功能测试',
  description: '验证新物品的给予、手持、使用（右键）、攻击（左键）逻辑',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_command',
      action: '给予自己新物品（替换 <modid> 和 <item_id>）',
      params: { command: 'give @s <modid>:<item_id> 1' },
      verify: '聊天栏显示"已给予物品"或无错误'
    },
    {
      step: 3,
      tool: 'mc_input',
      action: '切换到第 1 槽位（刚获得的物品）',
      params: { action: 'key_press', key: '1' },
      verify: 'mc_inventory 显示主手物品为新物品'
    },
    {
      step: 4,
      tool: 'mc_inventory',
      action: '验证物品已在主手',
      params: {},
      verify: 'mainHand 字段显示新物品 ID'
    },
    {
      step: 5,
      tool: 'mc_input',
      action: '右键使用物品（验证 UseItemCallback）',
      params: { action: 'use', durationMs: 500 },
      verify: '观察是否触发预期效果（粒子/实体/方块变化）'
    },
    {
      step: 6,
      tool: 'mc_input',
      action: '左键攻击（验证攻击逻辑，如适用）',
      params: { action: 'attack' },
      verify: '观察是否触发预期效果'
    },
    {
      step: 7,
      tool: 'mc_screenshot',
      action: '截图记录使用效果',
      params: {},
      verify: '截图显示功能效果'
    },
    {
      step: 8,
      tool: 'mc_world',
      action: '检查附近实体/方块变化',
      params: { radius: 16 },
      verify: '若功能涉及召唤实体/破坏方块，验证已触发'
    }
  ],
  successCriteria: [
    '物品成功给予并显示在主手',
    '右键/左键触发预期效果（截图或 mc_world 数据证实）',
    '若功能涉及实体生成，mc_world 显示对应实体'
  ]
}

const NEW_BLOCK_TEMPLATE: ScenarioTemplate = {
  feature_type: 'new_block',
  title: '新方块功能测试',
  description: '验证新方块的放置、外观、碰撞箱、右键交互',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_command',
      action: '在玩家脚下放置新方块（替换 <modid> 和 <block_id>）',
      params: { command: 'setblock ~ ~-2 ~ <modid>:<block_id>' },
      verify: '聊天栏显示"方块已放置"或无错误'
    },
    {
      step: 3,
      tool: 'mc_screenshot',
      action: '截图记录方块外观',
      params: {},
      verify: '截图显示新方块渲染正常'
    },
    {
      step: 4,
      tool: 'mc_input',
      action: '向前走上方块（验证碰撞箱）',
      params: { action: 'forward', durationMs: 500 },
      verify: '玩家能正确站在方块上'
    },
    {
      step: 5,
      tool: 'mc_input',
      action: '潜行（验证碰撞箱边缘）',
      params: { action: 'sneak', durationMs: 1000 },
      verify: '玩家不会从方块边缘掉落（若配置正确）'
    },
    {
      step: 6,
      tool: 'mc_input',
      action: '右键方块（验证 onUse 逻辑）',
      params: { action: 'use', durationMs: 500 },
      verify: '观察是否触发预期效果（GUI/红石/状态变化）'
    },
    {
      step: 7,
      tool: 'mc_screenshot',
      action: '截图记录交互效果',
      params: {},
      verify: '截图显示交互后的状态'
    },
    {
      step: 8,
      tool: 'mc_world',
      action: '检查方块周围变化',
      params: { radius: 8 },
      verify: '若功能涉及掉落物/实体，验证已生成'
    }
  ],
  successCriteria: [
    '方块成功放置且渲染正常',
    '碰撞箱正确（玩家能站上去）',
    '右键交互触发预期效果'
  ]
}

const NEW_RECIPE_TEMPLATE: ScenarioTemplate = {
  feature_type: 'new_recipe',
  title: '新合成配方测试',
  description: '验证新合成配方的材料组合与产物',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_command',
      action: '给予合成材料 1（替换 <material1> 和 <count1>）',
      params: { command: 'give @s <material1> <count1>' },
      verify: '聊天栏无错误'
    },
    {
      step: 3,
      tool: 'mc_command',
      action: '给予合成材料 2（替换 <material2> 和 <count2>）',
      params: { command: 'give @s <material2> <count2>' },
      verify: '聊天栏无错误'
    },
    {
      step: 4,
      tool: 'mc_input',
      action: '打开背包（按 E）',
      params: { action: 'key_press', key: 'e' },
      verify: 'mc_inspect 显示 InventoryScreen'
    },
    {
      step: 5,
      tool: 'mc_inspect',
      action: '检视背包界面（查找合成方格）',
      params: {},
      verify: '看到 2x2 合成方格或可点击"合成台"按钮'
    },
    {
      step: 6,
      tool: 'mc_screenshot',
      action: '截图记录背包合成界面',
      params: {},
      verify: '截图显示合成方格'
    },
    {
      step: 7,
      tool: 'mc_command',
      action: '若背包合成方格不够，给予合成台并放置',
      params: { command: 'give @s minecraft:crafting_table 1' },
      verify: '聊天栏无错误'
    },
    {
      step: 8,
      tool: 'mc_input',
      action: '放置合成台并右键打开',
      params: { action: 'use', durationMs: 500 },
      verify: 'mc_inspect 显示 CraftingScreen'
    },
    {
      step: 9,
      tool: 'mc_inventory',
      action: '验证合成产物（若配方已解锁）',
      params: {},
      verify: '背包出现目标产物'
    }
  ],
  successCriteria: [
    '合成材料成功给予',
    '打开合成界面（背包或合成台）',
    '若配方已解锁，背包中出现合成产物'
  ]
}

const ENTITY_BEHAVIOR_TEMPLATE: ScenarioTemplate = {
  feature_type: 'entity_behavior',
  title: '实体行为修改测试（如苦力怕樱花爆炸、末影人移动方式）',
  description: '召唤实体、观察初始状态、触发行为、对比状态变化、截图验证',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_command',
      action: '在玩家附近召唤目标实体（替换 <entity_id>，如 minecraft:creeper）',
      params: { command: 'summon <entity_id> ~ ~ ~ 5' },
      verify: '聊天栏显示"已召唤实体"或无错误'
    },
    {
      step: 3,
      tool: 'mc_input',
      action: '等待 2 秒让实体 AI 激活',
      params: { action: 'key_press', key: 'space', durationMs: 2000 },
      verify: '实体已生成并开始 AI 行为'
    },
    {
      step: 4,
      tool: 'mc_observe_entity',
      action: '观察实体初始状态（type 参数查找最近实体）',
      params: { type: '<entity_id>' },
      verify: '返回实体的 AI 状态、目标、移动速度、特殊状态（如 fuseTime/screaming）'
    },
    {
      step: 5,
      tool: 'mc_input',
      action: '触发实体行为（按功能类型选择）',
      params: { action: 'forward', durationMs: 2000 },
      verify: '苦力怕：接近触发爆炸；末影人：攻击触发仇恨/传送；其他：按功能设计'
    },
    {
      step: 6,
      tool: 'mc_screenshot',
      action: '截图记录行为效果（如樱花粒子、传送动画）',
      params: {},
      verify: '截图显示行为修改后的效果'
    },
    {
      step: 7,
      tool: 'mc_observe_entity',
      action: '再次观察实体状态变化',
      params: { type: '<entity_id>' },
      verify: '对比初始状态，验证 AI 状态/特殊状态已变化'
    },
    {
      step: 8,
      tool: 'mc_world',
      action: '检查附近实体状态/掉落物',
      params: { radius: 16 },
      verify: '若功能涉及掉落物/实体变化，验证已触发'
    },
    {
      step: 9,
      tool: 'mc_chat',
      action: '检查聊天日志是否有行为相关反馈',
      params: { action: 'read', limit: 20 },
      verify: '若有日志输出，确认行为已触发'
    }
  ],
  successCriteria: [
    '实体成功召唤并显示初始状态',
    '触发行为后实体状态发生变化（mc_observe_entity 数据对比）',
    '截图显示行为修改后的视觉效果（如樱花粒子）'
  ]
}

const PLAYER_INTERACTION_TEMPLATE: ScenarioTemplate = {
  feature_type: 'player_interaction',
  title: '玩家交互功能测试（如闪电剑、右键触发效果）',
  description: '给予触发物品、切换槽位、模拟右键、截图验证效果',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_command',
      action: '给予触发物品（替换 <trigger_item>，如 minecraft:diamond_sword）',
      params: { command: 'give @s <trigger_item> 1' },
      verify: '聊天栏无错误'
    },
    {
      step: 3,
      tool: 'mc_input',
      action: '切换到第 1 槽位',
      params: { action: 'key_press', key: '1' },
      verify: 'mc_inventory 显示主手为触发物品'
    },
    {
      step: 4,
      tool: 'mc_inventory',
      action: '验证物品在主手',
      params: {},
      verify: 'mainHand 字段显示触发物品'
    },
    {
      step: 5,
      tool: 'mc_input',
      action: '看向远方方块（调整视角）',
      params: { action: 'mouse_move', dx: 0, dy: -30 },
      verify: '准星指向远方方块'
    },
    {
      step: 6,
      tool: 'mc_input',
      action: '右键触发功能（UseItemCallback）',
      params: { action: 'use', durationMs: 500 },
      verify: '观察是否触发预期效果（闪电/粒子/实体）'
    },
    {
      step: 7,
      tool: 'mc_screenshot',
      action: '截图记录效果',
      params: {},
      verify: '截图显示功能效果（如闪电）'
    },
    {
      step: 8,
      tool: 'mc_world',
      action: '检查附近是否有触发的实体',
      params: { radius: 32 },
      verify: '若功能涉及实体生成（如 lightning_bolt），验证已生成'
    },
    {
      step: 9,
      tool: 'mc_chat',
      action: '检查聊天日志',
      params: { action: 'read', limit: 10 },
      verify: '若有日志输出，确认功能已触发'
    }
  ],
  successCriteria: [
    '触发物品成功给予并显示在主手',
    '右键触发功能效果（截图或 mc_world 数据证实）',
    '若功能涉及实体生成，mc_world 显示对应实体'
  ]
}

const HUD_GUI_TEMPLATE: ScenarioTemplate = {
  feature_type: 'hud_gui',
  title: 'HUD/界面功能测试',
  description: '按键触发 HUD/界面、检视控件、点击交互、截图验证',
  steps: [
    {
      step: 1,
      tool: 'mc_ensure_cheats',
      action: '确保作弊权限已开启',
      params: {},
      verify: '返回"作弊权限已开启"'
    },
    {
      step: 2,
      tool: 'mc_input',
      action: '按热键触发 HUD/界面（替换 <hotkey>，如 f6）',
      params: { action: 'key_press', key: '<hotkey>' },
      verify: 'mc_inspect 显示目标界面'
    },
    {
      step: 3,
      tool: 'mc_input',
      action: '等待 500ms 让界面加载',
      params: { action: 'key_press', key: 'space', durationMs: 500 },
      verify: '界面加载完成'
    },
    {
      step: 4,
      tool: 'mc_inspect',
      action: '检视当前界面/控件',
      params: {},
      verify: '显示目标 Screen 类和控件列表'
    },
    {
      step: 5,
      tool: 'mc_screenshot',
      action: '截图记录界面',
      params: {},
      verify: '截图显示 HUD/界面渲染正常'
    },
    {
      step: 6,
      tool: 'mc_input',
      action: '点击目标控件（替换 <widget_index>）',
      params: { action: 'click_widget', index: '<widget_index>' },
      verify: 'mc_inspect 显示界面切换或状态变化'
    },
    {
      step: 7,
      tool: 'mc_inspect',
      action: '再次检视，验证界面切换',
      params: {},
      verify: 'Screen 类已变化或控件状态已更新'
    },
    {
      step: 8,
      tool: 'mc_screenshot',
      action: '截图记录效果',
      params: {},
      verify: '截图显示交互后的效果'
    }
  ],
  successCriteria: [
    '热键成功触发 HUD/界面',
    '界面渲染正常（mc_inspect + 截图证实）',
    '控件可交互且响应正确'
  ]
}

const TEMPLATES: Record<FeatureType, ScenarioTemplate> = {
  new_item: NEW_ITEM_TEMPLATE,
  new_block: NEW_BLOCK_TEMPLATE,
  new_recipe: NEW_RECIPE_TEMPLATE,
  entity_behavior: ENTITY_BEHAVIOR_TEMPLATE,
  player_interaction: PLAYER_INTERACTION_TEMPLATE,
  hud_gui: HUD_GUI_TEMPLATE
}

const FEATURE_TYPE_DESCRIPTIONS: Record<FeatureType, string> = {
  new_item: '新物品：注册了新物品，需验证给予、手持、右键使用、左键攻击逻辑',
  new_block: '新方块：注册了新方块，需验证放置、外观、碰撞箱、右键交互',
  new_recipe: '新合成配方：添加了合成配方，需验证材料组合与产物',
  entity_behavior: '实体行为修改：修改了原版实体行为（如苦力怕爆炸改樱花、末影人移动方式），需召唤实体并观察状态变化',
  player_interaction: '玩家交互功能：玩家手持物品右键/左键触发效果（如闪电剑），需给予物品并模拟交互',
  hud_gui: 'HUD/界面：添加了 HUD 覆盖层或自定义界面，需按键触发并验证控件交互'
}

function formatScenarioOutput(template: ScenarioTemplate, featureDetail?: string, modId?: string): string {
  const lines: string[] = []
  lines.push(`# 测试场景：${template.title}`)
  lines.push('')
  lines.push(`功能类型：${template.feature_type}`)
  lines.push(`描述：${template.description}`)
  if (featureDetail) {
    lines.push(`功能细节：${featureDetail}`)
  }
  if (modId) {
    lines.push(`模组 ID：${modId}（请将步骤中的 <modid> 替换为此值）`)
  }
  lines.push('')
  lines.push('## 测试步骤')
  lines.push('')
  for (const step of template.steps) {
    lines.push(`### 步骤 ${step.step}：${step.action}`)
    lines.push(`- 工具：\`${step.tool}\``)
    lines.push(`- 参数：\`${JSON.stringify(step.params)}\``)
    lines.push(`- 验证：${step.verify}`)
    lines.push('')
  }
  lines.push('## 成功标准')
  lines.push('')
  for (const criteria of template.successCriteria) {
    lines.push(`- ${criteria}`)
  }
  lines.push('')
  lines.push('## 注意事项')
  lines.push('- 占位符（如 <modid>、<item_id>、<entity_id>）需替换为实际值')
  lines.push('- 每步执行后立即用客观证据（mc_screenshot/mc_inspect/mc_world/mc_observe_entity）验证')
  lines.push('- 若某步失败，分析失败原因后用 mc_input/mc_command 调整，禁止跳过验证')
  lines.push('- 实体行为修改必须用 mc_observe_entity 对比状态变化，禁止仅凭截图宣称完成')
  return lines.join('\n')
}

export const mcTestScenarioTool: Tool = {
  name: 'mc_test_scenario',
  description:
    '获取功能测试场景模板，并可编译为 V2 确定性测试规格。进入游戏世界后必须先调用本工具获取测试步骤脚本，再按步骤执行测试。' +
    '参数：feature_type（必填）— new_item（新物品）/ new_block（新方块）/ new_recipe（新合成配方）/ ' +
    'entity_behavior（实体行为修改，如苦力怕爆炸改樱花）/ player_interaction（玩家交互功能，如闪电剑）/ hud_gui（HUD或界面）。' +
    '可选：feature_detail、mod_id；若同时提供 subject_id（或 hotkey）和 assertions，本工具返回 scenarioId，可用 mc_run_test 执行。' +
    '旧调用仍返回说明模板；旧模板不是通过证据。',
  schema: {
    type: 'object',
    properties: {
      feature_type: {
        type: 'string',
        enum: ['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui'],
        description: '功能类型：new_item=新物品；new_block=新方块；new_recipe=新合成配方；entity_behavior=实体行为修改；player_interaction=玩家交互功能；hud_gui=HUD或界面'
      },
      feature_detail: {
        type: 'string',
        description: '功能细节描述（可选），如 "diamond_sword_summon_lightning" 或 "creeper_sakura_explosion"'
      },
      mod_id: {
        type: 'string',
        description: '模组 ID（可选），用于替换步骤中的 <modid> 占位符'
      },
      subject_id: {
        type: 'string',
        description: 'V2 测试的实际目标 ID，例如 example:lightning_sword 或 minecraft:creeper'
      },
      hotkey: {
        type: 'string',
        description: 'HUD/GUI 的实际触发热键，例如 f6'
      },
      assertions: {
        type: 'array',
        description: 'V2 客观断言列表；至少一项，禁止占位符和纯截图断言',
        items: { type: 'object' }
      },
      actions: {
        type: 'array',
        description: 'Optional deterministic actions; each action is command, input, or wait.',
        items: {
          type: 'object', additionalProperties: false,
          properties: { type: { type: 'string', enum: ['command', 'input', 'wait'] }, command: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' }, ms: { type: 'number' }, label: { type: 'string' } },
          required: ['type']
        }
      },
      visual_only: {
        type: 'boolean',
        description: '纯视觉效果；会明确返回 INCONCLUSIVE，等待用户确认'
      }
    },
    required: ['feature_type']
  },
  readOnly: () => true,
  async execute(_ctx, args: Record<string, unknown>) {
    const featureType = String(args.feature_type || '') as FeatureType
    if (!TEMPLATES[featureType]) {
      return [
        'Error: 无效的 feature_type。支持的取值：',
        ...Object.entries(FEATURE_TYPE_DESCRIPTIONS).map(([k, v]) => `- ${k}: ${v}`)
      ].join('\n')
    }
    const template = TEMPLATES[featureType]
    const featureDetail = args.feature_detail ? String(args.feature_detail) : undefined
    const modId = args.mod_id ? String(args.mod_id) : undefined
    const legacy = formatScenarioOutput(template, featureDetail, modId)
    const requestedV2 = Boolean(args.subject_id || args.target_id || args.hotkey || args.assertions)
    if (!requestedV2) {
      return legacy + '\n\n[V2] 要执行确定性测试，请补充 subject_id（或 hotkey）与至少一条 assertions，然后调用 mc_run_test。'
    }
    const compiled = createGameTestSpec(args)
    if (!compiled.ok) return `${legacy}\n\nError: ${compiled.error}`
    return `${legacy}\n\n${formatGameTestSpec(compiled.spec)}`
  }
}

/** 获取所有支持的功能类型（供外部展示/校验使用） */
export function getSupportedFeatureTypes(): FeatureType[] {
  return Object.keys(TEMPLATES) as FeatureType[]
}
