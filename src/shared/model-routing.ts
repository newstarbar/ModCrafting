import { getCatalogVisionSupport } from './llm-providers.ts'

export const AGENT_ROLE_IDS = [
  'router', 'coordinator', 'explorer', 'planner', 'implementer',
  'debugger', 'codeReviewer', 'visualReviewer', 'verifier', 'summarizer'
] as const

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]
export type TaskDifficulty = 'simple' | 'standard' | 'complex'
export const TASK_TEMPLATE_IDS = ['auto', 'feature', 'bugfix', 'ui', 'build', 'minecraft', 'refactor', 'knowledge'] as const
export type TaskTemplateId = (typeof TASK_TEMPLATE_IDS)[number]

export interface ModelRef { providerId: string; modelId: string }
export interface RoleBinding {
  primary: ModelRef
  fallbacks: ModelRef[]
  enabled: boolean
  required: boolean
  promptAppend?: string
}
export interface RoutingBudget {
  maxReadonlyConcurrency: number
  maxDelegations: number
  maxExpertRepairHandoffs: number
}
export interface RoutingPreset {
  id: string
  label: string
  description: string
  builtIn?: boolean
  roles: Record<AgentRoleId, RoleBinding>
  budget: RoutingBudget
}
export interface RoutingSelection {
  mode: 'routed' | 'fixed'
  strategyId: string
  taskTemplateId: TaskTemplateId
  customPresetId?: string
  model?: ModelRef
}
export interface ModelRoutingConfig {
  version: 1
  onboardingCompleted: boolean
  defaultSelection: RoutingSelection
  hardLimits: RoutingBudget
  presets: RoutingPreset[]
}
export interface DelegationTask {
  id: string
  roleId: AgentRoleId
  dependsOn: AgentRoleId[]
  readOnly: boolean
  reason: string
}
export interface RouteDecision {
  difficulty: TaskDifficulty
  taskTemplateId: TaskTemplateId
  roles: AgentRoleId[]
  delegations: DelegationTask[]
  reason: string
  source: 'rules' | 'model' | 'fallback'
}
export interface CollaborationTrace {
  id: string
  roleId: AgentRoleId
  providerId: string
  modelId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'fallback'
  startedAt?: number
  endedAt?: number
  summary?: string
  fallbackFrom?: ModelRef
  promptTokens?: number
  completionTokens?: number
  cost?: number
}

export const ROLE_LABELS: Record<AgentRoleId, string> = {
  router: '路由', coordinator: '协调', explorer: '勘探', planner: '规划',
  implementer: '实现', debugger: '诊断', codeReviewer: '代码审查',
  visualReviewer: '视觉审查', verifier: '验证', summarizer: '总结'
}

export const TASK_TEMPLATE_LABELS: Record<TaskTemplateId, string> = {
  auto: '自动', feature: '新功能', bugfix: 'Bug 修复', ui: 'UI / GUI',
  build: '构建环境', minecraft: 'Minecraft 内容', refactor: '重构', knowledge: '知识 / 文档'
}

const ref = (providerId: string, modelId: string): ModelRef => ({ providerId, modelId })
const deepseekFlash = ref('deepseek', 'deepseek-v4-flash')
const deepseekPro = ref('deepseek', 'deepseek-v4-pro')
const glm52 = ref('zhipu', 'glm-5.2')
const glmVision = ref('zhipu', 'glm-5v-turbo')
const qwenPlus = ref('dashscope', 'qwen3.7-plus')
const qwenMax = ref('dashscope', 'qwen3.7-max')
const kimiCode = ref('moonshot', 'kimi-k2.7-code')
const kimiFast = ref('moonshot', 'kimi-k2.7-code-highspeed')
const kimiVision = ref('moonshot', 'kimi-k2.6')
const minimaxVision = ref('minimax', 'MiniMax-M3')

function binding(primary: ModelRef, fallbacks: ModelRef[] = [], overrides: Partial<RoleBinding> = {}): RoleBinding {
  return { primary, fallbacks, enabled: true, required: false, ...overrides }
}

function makePreset(
  id: string,
  label: string,
  description: string,
  budget: RoutingBudget,
  roleModels: Partial<Record<AgentRoleId, ModelRef>>,
  visual = glmVision
): RoutingPreset {
  const base: Record<AgentRoleId, ModelRef> = {
    router: deepseekFlash, coordinator: deepseekFlash, explorer: deepseekFlash,
    planner: deepseekPro, implementer: kimiCode, debugger: deepseekPro,
    codeReviewer: glm52, visualReviewer: visual, verifier: qwenPlus, summarizer: deepseekFlash
  }
  const models = { ...base, ...roleModels }
  return {
    id, label, description, builtIn: true, budget,
    roles: {
      router: binding(models.router, [deepseekFlash]),
      coordinator: binding(models.coordinator, [deepseekPro, deepseekFlash]),
      explorer: binding(models.explorer, [deepseekFlash]),
      planner: binding(models.planner, [deepseekPro, deepseekFlash]),
      implementer: binding(models.implementer, [kimiCode, deepseekPro, deepseekFlash], { required: true }),
      debugger: binding(models.debugger, [deepseekPro, deepseekFlash]),
      codeReviewer: binding(models.codeReviewer, [glm52, deepseekPro]),
      visualReviewer: binding(models.visualReviewer, [qwenMax, kimiVision, minimaxVision], { required: true }),
      verifier: binding(models.verifier, [qwenPlus, deepseekFlash]),
      summarizer: binding(models.summarizer, [deepseekFlash])
    }
  }
}

export const BUILTIN_ROUTING_PRESETS: RoutingPreset[] = [
  makePreset('fast', '快速', '更快反馈，优先轻量模型和较少委派。', { maxReadonlyConcurrency: 2, maxDelegations: 5, maxExpertRepairHandoffs: 1 }, { implementer: kimiFast, verifier: deepseekFlash, codeReviewer: deepseekFlash }),
  makePreset('balanced', '均衡', '质量、速度与成本的默认平衡。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, {}),
  makePreset('deep', '深度', '复杂改动使用更强的规划、审查和更高委派预算。', { maxReadonlyConcurrency: 3, maxDelegations: 10, maxExpertRepairHandoffs: 3 }, { router: deepseekPro, coordinator: glm52, planner: glm52, explorer: qwenMax, verifier: qwenMax, summarizer: deepseekPro }),
  makePreset('economy', '经济', '尽可能复用快速文本模型。', { maxReadonlyConcurrency: 2, maxDelegations: 5, maxExpertRepairHandoffs: 1 }, { planner: deepseekFlash, implementer: deepseekFlash, debugger: deepseekFlash, codeReviewer: deepseekFlash, verifier: deepseekFlash }),
  makePreset('code', '代码专精', '优先代码实现、静态审查与诊断能力。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, { planner: deepseekPro, codeReviewer: glm52, implementer: kimiCode }),
  makePreset('visual', '视觉专精', '为 GUI 与游戏内界面增加视觉审查权重。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, { coordinator: qwenMax, planner: qwenMax, explorer: qwenMax, verifier: qwenMax, visualReviewer: glmVision }),
  makePreset('single', '单模型兼容', '用当前选择的模型完成全部职责，兼容旧会话。', { maxReadonlyConcurrency: 1, maxDelegations: 1, maxExpertRepairHandoffs: 1 }, {})
]

export function defaultRoutingConfig(): ModelRoutingConfig {
  return {
    version: 1,
    onboardingCompleted: false,
    defaultSelection: { mode: 'routed', strategyId: 'balanced', taskTemplateId: 'auto' },
    hardLimits: { maxReadonlyConcurrency: 3, maxDelegations: 12, maxExpertRepairHandoffs: 3 },
    presets: []
  }
}

export function allRoutingPresets(config?: Pick<ModelRoutingConfig, 'presets'>): RoutingPreset[] {
  return [...BUILTIN_ROUTING_PRESETS, ...(config?.presets || [])]
}

export function findRoutingPreset(config: Pick<ModelRoutingConfig, 'presets'> | undefined, id?: string): RoutingPreset {
  return allRoutingPresets(config).find((preset) => preset.id === id) || BUILTIN_ROUTING_PRESETS[1]
}

export function isVisionModelRef(model: ModelRef): boolean {
  return getCatalogVisionSupport(model.modelId, model.providerId) === true
}

export function buildStaticRouteDecision(input: string, template: TaskTemplateId, hasImages = false): RouteDecision {
  const text = input.toLowerCase()
  const inferred: TaskTemplateId = template !== 'auto' ? template
    : hasImages || /(?:gui|ui|界面|屏幕|预览|按钮|热键)/i.test(input) ? 'ui'
    : /(?:报错|错误|崩溃|失败|bug|修复|异常)/i.test(input) ? 'bugfix'
    : /(?:构建|gradle|jdk|环境|依赖)/i.test(input) ? 'build'
    : /(?:方块|物品|实体|附魔|配方|minecraft)/i.test(input) ? 'minecraft'
    : /(?:重构|整理|迁移)/i.test(input) ? 'refactor'
    : /(?:文档|知识|说明|教程)/i.test(input) ? 'knowledge' : 'feature'
  const complex = /(?:重构|架构|多个|全局|迁移|复杂|并发)/i.test(input)
  const difficulty: TaskDifficulty = complex ? 'complex' : text.length > 180 ? 'standard' : 'simple'
  const roles: AgentRoleId[] = ['router', 'coordinator']
  if (inferred === 'ui') roles.push('explorer', 'planner', 'implementer', 'visualReviewer', 'verifier', 'summarizer')
  else if (inferred === 'bugfix') roles.push('explorer', 'debugger', 'planner', 'implementer', 'codeReviewer', 'verifier', 'summarizer')
  else if (inferred === 'knowledge') roles.push('explorer', 'summarizer')
  else if (inferred === 'build') roles.push('explorer', 'debugger', 'planner', 'implementer', 'verifier', 'summarizer')
  else roles.push('explorer', 'planner', 'implementer', 'codeReviewer', 'verifier', 'summarizer')
  const unique = [...new Set(roles)]
  return {
    difficulty, taskTemplateId: inferred, roles: unique,
    delegations: unique.map((roleId, index) => ({
      id: `${roleId}_${index + 1}`, roleId,
      dependsOn: roleId === 'implementer' ? ['planner'] : roleId === 'summarizer' ? unique.filter((id) => id !== 'summarizer') : [],
      readOnly: roleId !== 'implementer',
      reason: `${TASK_TEMPLATE_LABELS[inferred]}任务需要${ROLE_LABELS[roleId]}职责`
    })),
    reason: `规则识别为「${TASK_TEMPLATE_LABELS[inferred]}」，难度为${difficulty === 'complex' ? '复杂' : difficulty === 'standard' ? '标准' : '简单'}。`,
    source: 'rules'
  }
}

/** Public routing entrypoint. Deterministic rules remain available when the
 * optional routing-model classification is unavailable. */
export const routeUserTurn = buildStaticRouteDecision

export function normalizeRoutingConfig(raw: unknown): ModelRoutingConfig {
  const fallback = defaultRoutingConfig()
  if (!raw || typeof raw !== 'object') return fallback
  const value = raw as Partial<ModelRoutingConfig>
  const selection = value.defaultSelection
  const validTemplate = TASK_TEMPLATE_IDS.includes(selection?.taskTemplateId as TaskTemplateId) ? selection!.taskTemplateId : 'auto'
  const limit = (candidate: unknown, minimum: number, maximum: number, fallbackValue: number) => {
    const numeric = Number(candidate)
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallbackValue
  }
  return {
    version: 1,
    onboardingCompleted: Boolean(value.onboardingCompleted),
    defaultSelection: {
      mode: selection?.mode === 'fixed' ? 'fixed' : 'routed',
      strategyId: typeof selection?.strategyId === 'string' ? selection.strategyId : fallback.defaultSelection.strategyId,
      taskTemplateId: validTemplate,
      ...(selection?.customPresetId ? { customPresetId: selection.customPresetId } : {}),
      ...(selection?.model && typeof selection.model.providerId === 'string' && typeof selection.model.modelId === 'string' ? { model: selection.model } : {})
    },
    hardLimits: {
      maxReadonlyConcurrency: limit(value.hardLimits?.maxReadonlyConcurrency, 1, 3, 3),
      maxDelegations: limit(value.hardLimits?.maxDelegations, 1, 12, 12),
      maxExpertRepairHandoffs: limit(value.hardLimits?.maxExpertRepairHandoffs, 0, 3, 3)
    },
    presets: Array.isArray(value.presets) ? value.presets.filter((preset): preset is RoutingPreset => isValidCustomPreset(preset)) : []
  }
}

function isValidModelRef(value: unknown): value is ModelRef {
  return Boolean(value && typeof value === 'object' && typeof (value as ModelRef).providerId === 'string' && typeof (value as ModelRef).modelId === 'string')
}

function isValidCustomPreset(value: unknown): value is RoutingPreset {
  if (!value || typeof value !== 'object') return false
  const preset = value as Partial<RoutingPreset>
  if (preset.builtIn === true || !preset.id || !preset.label || !preset.description || !preset.roles || !preset.budget) return false
  if (!Number.isFinite(preset.budget.maxReadonlyConcurrency) || !Number.isFinite(preset.budget.maxDelegations) || !Number.isFinite(preset.budget.maxExpertRepairHandoffs)) return false
  return AGENT_ROLE_IDS.every((role) => {
    const binding = preset.roles?.[role]
    return Boolean(binding && isValidModelRef(binding.primary) && Array.isArray(binding.fallbacks) && binding.fallbacks.every(isValidModelRef) && typeof binding.enabled === 'boolean' && typeof binding.required === 'boolean' && (binding.promptAppend === undefined || typeof binding.promptAppend === 'string'))
  })
}
