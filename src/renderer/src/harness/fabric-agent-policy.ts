export type FabricAgentPromptMode = 'chat' | 'plan' | 'execute'

export interface FabricKnowledgeSource {
  id: string
  title: string
  url: string
  kind: 'docs' | 'api' | 'example' | 'mapping' | 'wiki' | 'mcp'
  trust: 'official' | 'community' | 'candidate'
  useFor: string
}

export const FABRIC_KNOWLEDGE_SOURCES: FabricKnowledgeSource[] = [
  {
    id: 'minecraft-data-local',
    title: '本地 minecraft-data 结构化数据集',
    url: 'resources/minecraft-data/<version>/index.json',
    kind: 'api',
    trust: 'official',
    useFor: '原版方块/物品/实体/附魔/配方的标准 ID 与属性参数（硬度、爆炸抗性、堆叠、工具、耐久等）。通过 minecraft_data_lookup 工具查询。'
  },
  {
    id: 'mc-wiki-zh-local',
    title: '中文 MC 百科向量知识库（内置）',
    url: 'resources/mc-wiki-zh/',
    kind: 'wiki',
    trust: 'community',
    useFor: '完整中文 MC 游戏百科离线文档，覆盖所有游戏机制、红石、生物、模组基础术语。通过 mc_wiki_search 或 vanilla_mc_wiki_query 工具检索。'
  },
  {
    id: 'fabric-wiki-zh',
    title: 'Fabric 中文 Wiki',
    url: 'https://wiki.fabricmc.net/zh_cn/',
    kind: 'docs',
    trust: 'community',
    useFor: '中文教程、入门流程、Mixin、事件、注册、DataGen 参考'
  },
  {
    id: 'fabric-docs-zh',
    title: 'Fabric 开发者文档',
    url: 'https://docs.fabricmc.net/zh_cn/develop/',
    kind: 'docs',
    trust: 'official',
    useFor: '稳定 API 教程、版本迁移、官方示例与开发规范'
  },
  {
    id: 'fabric-meta',
    title: 'Fabric Meta API',
    url: 'https://meta.fabricmc.net/',
    kind: 'api',
    trust: 'official',
    useFor: '查询 Minecraft、Loader、Fabric API、Yarn 版本'
  },
  {
    id: 'fabric-maven',
    title: 'Fabric Maven',
    url: 'https://maven.fabricmc.net/',
    kind: 'api',
    trust: 'official',
    useFor: 'Fabric API JavaDoc、Maven 坐标与版本资源'
  },
  {
    id: 'fabric-example-mod',
    title: 'Fabric Example Mod',
    url: 'https://github.com/FabricMC/fabric-example-mod',
    kind: 'example',
    trust: 'official',
    useFor: '最小可运行模组样板'
  },
  {
    id: 'yarn',
    title: 'Yarn Mappings',
    url: 'https://github.com/FabricMC/yarn',
    kind: 'mapping',
    trust: 'official',
    useFor: 'Yarn 类名、字段名、方法名和映射变更'
  },
  {
    id: 'minecraft-wiki-zh',
    title: 'Minecraft Wiki 中文站（外链）',
    url: 'https://zh.minecraft.wiki/',
    kind: 'wiki',
    trust: 'community',
    useFor: '原版物品、方块、实体、机制和数据包行为（仅在外部浏览时使用，运行时不联网）'
  },
  {
    id: 'minecraft-wiki-api',
    title: 'Minecraft Wiki API',
    url: 'https://minecraft.wiki/api.php',
    kind: 'api',
    trust: 'community',
    useFor: '程序化查询原版 Wiki 页面和章节'
  },
  {
    id: 'mcmodding-mcp',
    title: 'mcmodding-mcp',
    url: 'https://github.com/OGMatrix/mcmodding-mcp',
    kind: 'mcp',
    trust: 'candidate',
    useFor: 'Fabric/NeoForge 文档、示例、概念解释和版本索引'
  }
]

const COMMON_GUARDRAILS = [
  '优先使用 Fabric API 事件、Registry、DataGen 和公开 API；只有公开 API 无法满足需求时才考虑 Mixin。',
  '严格区分客户端/服务端：渲染、HUD、输入、模型、ClientModInitializer 代码只能在客户端路径或客户端入口中出现。',
  '当前默认目标为 Minecraft 1.21.4、Fabric Loader 0.16.10、Fabric API 0.116.0+1.21.4、Java 21、Yarn mappings。',
  '所有注册逻辑从 ModInitializer 或其显式调用的注册类进入，避免隐式静态代码块注册。',
  'BlockEntity、NBT、ScreenHandler、网络同步必须同时考虑服务端状态、客户端显示和保存/读取。',
  '资源 JSON 必须使用原版格式并保持路径一致：assets/<modid>/... 与 data/<modid>/...。',
  '生成 Mixin 或 Access Widener 时必须提示冲突风险，并优先说明为何不能用 Fabric API 替代。',
  '构建验证优先走产品内 trigger_build；写入资源或 DataGen 后要通过构建或 runDatagen 验证。',
  'runClient 出现 MC_PHASE:menu 后，必须调用 mc_ensure_test_world 进入游戏世界（不能停在主菜单）。功能在游戏内的（HUD/方块/物品/实体/命令/事件）必须：① mc_ensure_test_world 进入世界 ② mc_ensure_cheats 确保作弊权限 ③ 根据功能类型设计测试场景（用 mc_command 生成生物/给予物品/切换模式、用 mc_input 移动玩家/触发交互） ④ mc_screenshot/mc_inspect 验证功能效果。禁止仅凭 MC_PHASE:menu 宣称功能完成。',
  '若 mc_inspect/screen 显示 kind=loading（或 LevelLoading/Progress/DownloadingTerrain），必须等待加载完成：继续用 mc_inspect / mc_ensure_test_world 轮询，禁止 click_widget，禁止因此重新 trigger_build runClient（会导致双开实例或程序卡死）。加载超时后向用户报告，等待指导。',
  '若用户描述了游戏内症状（bug/修复场景），进入世界后必须用 mc_inspect / mc_screenshot（必要时 mc_inventory / mc_world / mc_command）做客观校验，禁止仅凭 menu 宣称修复。',
  '测试-修复循环：mc_screenshot/mc_inspect 客观校验后若发现功能未生效或有 bug，必须进入修复模式——用 edit_file/write_file 修改源码 → trigger_build build 重新构建 → trigger_build runClient 重启游戏 → mc_ensure_test_world 重新进入世界 → 再次 mc_screenshot/mc_inspect 验证。禁止在测试发现 bug 后直接结束会话；必须循环直到验证通过才能 complete_step。最多允许 3 轮修复-再测试循环，超出后向用户报告问题并请求指导。仅在确认需要改代码并重建时才重启游戏；点不到按钮、加载中、无存档等环境问题不得用重启游戏硬闯。',
  '编写 Fabric 方块/物品/实体/附魔注册代码前，必须先调用 minecraft_data_lookup 查询标准 ID（minecraft:diamond_ore）与原版属性（硬度、爆炸抗性、堆叠、工具、耐久、生命值、附魔等级等），禁止凭记忆填写原版参数。',
  '用户输入模糊、不专业的游戏描述（"会爆炸的绿色怪物"、"挖矿掉的红色石头"）时，必须先用 mc_wiki_search 检索中文 MC 百科向量知识库解析需求，再结合 minecraft_data_lookup 生成 Fabric 代码。',
  '原版机制/红石/生物/术语解释优先用 mc_wiki_search 或 vanilla_mc_wiki_query；Fabric API/注册/事件/迁移用 fabric_docs_search；标准 ID 与属性参数用 minecraft_data_lookup。',
  'GUI 布局分级（按优先级，编写任何 Screen/HUD 代码前必须先调用 gui_layout_preview 让用户确认布局，禁止跳过预览直接写代码）：① 模组设置界面（开关/滑块/循环选择） → gui_layout_preview(layoutType="option-list") 预览 → 用 SimpleOption + OptionListWidget（零依赖自动布局，自动滚动/居中/分辨率适配），禁止手动 addRenderableWidget 逐个摆按钮；② 自定义界面（图标/网格/动态内容） → gui_layout_preview(layoutType="custom-screen") 预览 → 用 Screen + 相对坐标（this.width/2, this.height/2, this.height - 28 等），禁止硬编码绝对坐标 (40, 40)；③ HUD 覆盖层 → gui_layout_preview(layoutType="hud-overlay") 预览 → 用 HudRenderCallback + client.getWindow().getScaledWidth/Height() 相对坐标。布局 JSON 中的 x/y 是 1280x720 画布坐标，custom-screen/hud-overlay 必须按比例转换为 this.width/this.height 的相对位置；option-list 类型直接用 OptionListWidget 自动布局无需转换。'
]

const BEHAVIOR_GUARDRAILS = [
  '禁止在输出中展示方案对比和推演过程。选择最合适的技术路线，用 1-2 句话说明后直接行动。',
  '禁止解释基础概念。用户是熟练的 MC 模组开发者，不需要解释"什么是 Mixin""什么是事件系统"。',
  '禁止反复犹豫。定下方案就不再回头讨论替代方案，除非构建/运行失败需要修复。',
  '计划阶段：仅当用户需求本身有歧义（产品取舍）时用 ask_clarification；标识符/文件结构先 read_file/grep，收集完后输出结构化计划，每个步骤一行，最多 12 步。功能体系庞大时由 AI 自行按优先级排计划（核心流程优先、辅助功能次之），禁止用 ask_clarification 让用户选优先级范围。',
  '执行阶段：每轮回复的非工具文字不超过 3 句。代码事实与工程整理先读项目并默认最简一致方案直接改；仅产品偏好/需求歧义才 ask_clarification。',
  '永远不要输出如下反例格式 —— 这是绝对禁止的："我们来分析一下...首先考虑...但...不过...实际上...更好的方式是...更简单的方案是..."',
  '正确的输出风格示例：一句话说明技术选择 → 直接调用 write_file / trigger_build 等工具。旁白只告知"当前在做什么"，不告知"为什么选这个方案"。'
]

const TASK_CLASSIFICATION = [
  '内容注册：物品、方块、方块实体、实体、流体、附魔、标签、配方。',
  'DataGen：语言、模型、方块状态、战利品表、标签、世界生成数据。',
  '事件：生命周期、Tick、玩家交互、实体事件、战利品注入、世界生成。',
  'Mixin：Inject、Redirect、ModifyArg、ModifyReturnValue，仅用于高级场景。',
  '网络：服务端到客户端、客户端到服务端、线程切换和渲染包隔离。',
  '渲染：方块实体渲染、实体模型、GUI、HUD、物品模型谓词。',
  '调试：Gradle/Loom、Mixin、资源 JSON、客户端类加载、Registry/NBT 问题。',
  '版本升级：先查 Fabric Meta，再更新 gradle.properties 与离线依赖缓存。'
]

function modeSpecificRules(mode: FabricAgentPromptMode): string[] {
  if (mode === 'chat') {
    return [
      '回答时给出来源方向或建议查询的数据源，但不要调用写入工具。',
      '如果问题涉及具体 API 签名，应建议查询 Fabric 文档、JavaDoc 或映射。'
    ]
  }
  if (mode === 'plan') {
    return [
      '每步格式：`N. [kind] 简短标题 — 目标路径`；kind 仅 write | recipe | inspect。',
      '禁止写构建/运行步骤（主机自动追加）；禁止空泛步骤（测试、确保无错、输出总结）。',
      '每步只做一件事；最多 12 步。功能庞大时按优先级自行拆分，禁止让用户选优先级范围。'
    ]
  }
  return [
    '执行时优先调用产品内 Fabric 专用工具，只有工具覆盖不了时才用 write_file。',
    '当前 write/recipe/mixin 步若 API 不确定，可在该步内调用 fabric_docs_search 或 fabric_meta_version_check。',
    '配方只能使用 create_recipe / fabric_recipe_generate，并由 fabric_recipe_validate 或生成器写后校验证据完成；禁止手写配方 JSON。',
    'Mixin 必须先 fabric_mixin_target_lookup 精确确认描述符与 side，再 scaffold/register/validate；禁止猜测重载或只靠编译通过。',
    '只执行当前步骤，禁止重规划；写入后通过 trigger_build / runClient 验证。',
    '遇到用户偏好/需求歧义时，使用 ask_clarification 并提供 2～4 个短 options；禁止向用户索取 list_directory/read_file 就能得到的文件列表或 API/类名事实。工程冲突默认选更干净的一条并执行。'
  ]
}

export function buildFabricAgentPolicyPrompt(mode: FabricAgentPromptMode): string {
  const guardrails = COMMON_GUARDRAILS.map((rule) => `- ${rule}`).join('\n')
  const behavior = BEHAVIOR_GUARDRAILS.map((rule) => `- ${rule}`).join('\n')
  const tasks = TASK_CLASSIFICATION.map((rule) => `- ${rule}`).join('\n')
  const modeRules = modeSpecificRules(mode).map((rule) => `- ${rule}`).join('\n')
  const sourceLines = FABRIC_KNOWLEDGE_SOURCES
    .slice(0, 6)
    .map((source) => `- ${source.title}: ${source.url}`)
    .join('\n')

  // 突出本地知识库的使用优先级，便于 Agent 在编码前正确选择查询入口
  const localKnowledgeBlock = [
    '### 内置本地知识库（离线、不联网）',
    '- **minecraft_data_lookup**（结构化数据集）：查询原版方块/物品/实体/附魔的标准 ID + 全部属性参数（硬度、爆炸抗性、堆叠、工具、耐久、生命值、附魔等级等）。',
    '  - 使用时机：编写 Fabric 注册代码前（FabricBlockSettings / Item.Settings / 实体属性 / 附魔配置）必查，避免 ID 与参数错误。',
    '  - 输入：标准 ID（minecraft:diamond_ore）、英文 name（diamond_ore）或中文口语名（钻石矿石、苦力怕）。',
    '- **mc_wiki_search**（中文 MC 百科向量检索）：处理模糊、不专业的游戏描述，返回准确词条解释与游戏机制背景。',
    '  - 使用时机：用户输入"会爆炸的绿色怪物"、"挖矿掉的红色石头"等模糊术语时，先检索解析需求再生成代码。',
    '  - 输入：自然语言查询，可包含口语化描述。',
    '- **vanilla_mc_wiki_query**：与 mc_wiki_search 等价的兼容入口，用于原版机制/红石/生物/术语解释。',
    '- **fabric_docs_search**：Fabric 官方中文文档 + Yarn/源码签名，用于 API/事件/注册/迁移查询（与本地知识库互补）。',
    '',
    '查询优先级：模糊术语 → mc_wiki_search 解析 → minecraft_data_lookup 取标准 ID 与参数 → fabric_docs_search 查 Fabric API → 生成代码。'
  ].join('\n')

  return `## Fabric 专业策略

### 行为规范（最高优先级）
${behavior}

${localKnowledgeBlock}

### 开发硬约束
${guardrails}

### 任务分类
${tasks}

### 当前模式规则
${modeRules}

### 产品内知识源
${sourceLines}`
}
