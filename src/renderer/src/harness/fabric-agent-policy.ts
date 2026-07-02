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
    title: 'Minecraft Wiki 中文站',
    url: 'https://zh.minecraft.wiki/',
    kind: 'wiki',
    trust: 'community',
    useFor: '原版物品、方块、实体、机制和数据包行为'
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
  '构建验证优先走产品内 trigger_build；写入资源或 DataGen 后要通过构建或 runDatagen 验证。'
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
      '计划第一步应识别任务类别，并说明需要查询哪些产品内只读知识工具。',
      '计划中避免泛泛而谈，每一步应落到 Java、JSON、Gradle、DataGen、构建或运行验证。'
    ]
  }
  return [
    '执行时优先调用产品内 Fabric 专用工具，只有工具覆盖不了时才用 write_file。',
    '写入后必须通过 trigger_build、runDatagen、runClient 或日志读取形成验证闭环。'
  ]
}

export function buildFabricAgentPolicyPrompt(mode: FabricAgentPromptMode): string {
  const guardrails = COMMON_GUARDRAILS.map((rule) => `- ${rule}`).join('\n')
  const tasks = TASK_CLASSIFICATION.map((rule) => `- ${rule}`).join('\n')
  const modeRules = modeSpecificRules(mode).map((rule) => `- ${rule}`).join('\n')
  const sourceLines = FABRIC_KNOWLEDGE_SOURCES
    .slice(0, 6)
    .map((source) => `- ${source.title}: ${source.url}`)
    .join('\n')

  return `## Fabric 专业策略

### 开发硬约束
${guardrails}

### 任务分类
${tasks}

### 当前模式规则
${modeRules}

### 产品内知识源
${sourceLines}`
}
