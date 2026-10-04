import { findModelInProvider, getCatalogVisionSupport, getProvider, normalizeModelId } from './llm-providers.ts'

export const AGENT_ROLE_IDS = [
  'router', 'coordinator', 'explorer', 'planner', 'implementer',
  'debugger', 'codeReviewer', 'visualReviewer', 'verifier', 'summarizer'
] as const

export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number]
export type TaskDifficulty = 'simple' | 'standard' | 'complex'
export const TASK_TEMPLATE_IDS = ['auto', 'feature', 'bugfix', 'ui', 'build', 'minecraft', 'refactor', 'knowledge'] as const
export type TaskTemplateId = (typeof TASK_TEMPLATE_IDS)[number]
export type RouteDecisionSource = 'rules' | 'model' | 'hybrid' | 'fallback'
export type TurnRoutingIntent = 'chat' | 'resume' | 'develop' | 'plan_only'

/** Cooldown after auth / rate-limit / protocol failure before retrying a model. */
export const MODEL_COOLDOWN_MS = 60_000

export interface ModelRef { providerId: string; modelId: string }

export interface DifficultyBinding {
  primary: ModelRef
  fallbacks?: ModelRef[]
}

export interface RoleBinding {
  primary: ModelRef
  fallbacks: ModelRef[]
  enabled: boolean
  required: boolean
  promptAppend?: string
  /** Optional per-difficulty overrides (ControlFlow-style role × tier). */
  byDifficulty?: Partial<Record<TaskDifficulty, DifficultyBinding>>
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

/** Roles that an optional companion provider may cover (gap-fill / third-party checks). */
export const COMPANION_EXPERT_ROLE_IDS = ['codeReviewer', 'visualReviewer'] as const
export type CompanionExpertRoleId = (typeof COMPANION_EXPERT_ROLE_IDS)[number]

export interface ProviderModelLadder {
  fast: ModelRef
  strong: ModelRef
  vision: ModelRef
}

export interface ModelRoutingConfig {
  version: 1
  onboardingCompleted: boolean
  /** Primary vendor for built-in multi-model collaboration (default DeepSeek). */
  homeProviderId: string
  /** Optional second vendor for specialist expert slots only. */
  companionProviderId?: string
  /** Expert roles routed to companion when companionProviderId is set. */
  companionExpertRoles: CompanionExpertRoleId[]
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

/** Signal layer (Semantic Router-inspired): extracted before role/model binding. */
export interface RoutingSignals {
  taskTemplateId: Exclude<TaskTemplateId, 'auto'>
  difficulty: TaskDifficulty
  needsVision: boolean
  needsDebug: boolean
  /** When true, optional router-model classification may refine signals. */
  ambiguous: boolean
  confidence: 'high' | 'low'
}

export interface RouteDecision {
  difficulty: TaskDifficulty
  taskTemplateId: Exclude<TaskTemplateId, 'auto'>
  roles: AgentRoleId[]
  /** Roles that the controller will actually invoke for the current intent. */
  activeRoles: AgentRoleId[]
  delegations: DelegationTask[]
  signals: RoutingSignals
  reason: string
  source: RouteDecisionSource
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

export const DIFFICULTY_LABELS: Record<TaskDifficulty, string> = {
  simple: '简单', standard: '标准', complex: '复杂'
}

const ref = (providerId: string, modelId: string): ModelRef => ({ providerId, modelId })
const deepseekFlash = ref('deepseek', 'deepseek-flash')
const deepseekPro = ref('deepseek', 'deepseek-v4-pro')

function binding(primary: ModelRef, fallbacks: ModelRef[] = [], overrides: Partial<RoleBinding> = {}): RoleBinding {
  return { primary, fallbacks, enabled: true, required: false, ...overrides }
}

function isFastModelId(modelId: string): boolean {
  return /flash|lite|turbo|mini|highspeed|fast/i.test(modelId)
}

function isStrongModelId(modelId: string): boolean {
  return /pro|max|code|plus/i.test(modelId) && !isFastModelId(modelId)
}

/**
 * Whether a ref occupies the cheap tier of its provider ladder. Routing is allowed to
 * escalate a cheap slot to the strong model, but a cheap slot must never be filled by a
 * model the user did not choose — that is what made the composer selection inert.
 */
export function isFastTierRef(candidate: ModelRef): boolean {
  return !isStrongModelId(candidate.modelId)
}

/** Pick fast / strong / vision models from a provider catalog. */
export function buildHomeProviderLadder(providerId: string): ProviderModelLadder {
  const provider = getProvider(providerId)
  const models = provider?.models || []
  const make = (modelId: string): ModelRef => ref(providerId, modelId)
  if (!models.length) {
    return { fast: make('default'), strong: make('default'), vision: make('default') }
  }
  const fastModel = models.find((model) => isFastModelId(model.id)) || models[0]
  const strongModel = models.find((model) => isStrongModelId(model.id))
    || models.find((model) => !isFastModelId(model.id))
    || models[models.length - 1]
  const visionModel = models.find((model) => model.vision) || fastModel
  return {
    fast: make(fastModel.id),
    strong: make(strongModel.id),
    vision: make(visionModel.id)
  }
}

function makePreset(
  id: string,
  label: string,
  description: string,
  budget: RoutingBudget,
  roleModels: Partial<Record<AgentRoleId, ModelRef>>,
  tierOverrides: Partial<Record<AgentRoleId, Partial<Record<TaskDifficulty, DifficultyBinding>>>> = {}
): RoutingPreset {
  const base: Record<AgentRoleId, ModelRef> = {
    router: deepseekFlash,
    coordinator: deepseekFlash,
    explorer: deepseekFlash,
    planner: deepseekPro,
    implementer: deepseekPro,
    debugger: deepseekPro,
    codeReviewer: deepseekPro,
    visualReviewer: deepseekFlash,
    verifier: deepseekFlash,
    summarizer: deepseekFlash
  }
  const models = { ...base, ...roleModels }
  const withTier = (roleId: AgentRoleId, primary: ModelRef, fallbacks: ModelRef[], overrides: Partial<RoleBinding> = {}): RoleBinding => {
    const tiers = tierOverrides[roleId]
    return binding(primary, fallbacks, { ...overrides, ...(tiers ? { byDifficulty: tiers } : {}) })
  }
  return {
    id, label, description, builtIn: true, budget,
    roles: {
      router: withTier('router', models.router, [deepseekFlash]),
      coordinator: withTier('coordinator', models.coordinator, [deepseekPro, deepseekFlash]),
      explorer: withTier('explorer', models.explorer, [deepseekFlash]),
      planner: withTier('planner', models.planner, [deepseekPro, deepseekFlash]),
      implementer: withTier('implementer', models.implementer, [deepseekPro, deepseekFlash], { required: true }),
      debugger: withTier('debugger', models.debugger, [deepseekPro, deepseekFlash]),
      codeReviewer: withTier('codeReviewer', models.codeReviewer, [deepseekPro, deepseekFlash]),
      visualReviewer: withTier('visualReviewer', models.visualReviewer, [deepseekFlash, deepseekPro], { required: true }),
      verifier: withTier('verifier', models.verifier, [deepseekFlash, deepseekPro]),
      summarizer: withTier('summarizer', models.summarizer, [deepseekFlash])
    }
  }
}

/**
 * Balanced is the shipped default, so its `standard` tier must not bill the strong
 * model: escalation to Pro is reserved for `complex` turns and for presets the user
 * picks explicitly (`deep` / `code`). Pro stays as a fallback for capacity failures.
 */
const balancedTiers: Partial<Record<AgentRoleId, Partial<Record<TaskDifficulty, DifficultyBinding>>>> = {
  planner: {
    simple: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  implementer: {
    simple: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  debugger: {
    simple: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  codeReviewer: {
    simple: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  }
}

const fastTiers: Partial<Record<AgentRoleId, Partial<Record<TaskDifficulty, DifficultyBinding>>>> = {
  planner: {
    simple: { primary: deepseekFlash },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  implementer: {
    simple: { primary: deepseekFlash },
    standard: { primary: deepseekFlash, fallbacks: [deepseekPro] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  }
}

const deepTiers: Partial<Record<AgentRoleId, Partial<Record<TaskDifficulty, DifficultyBinding>>>> = {
  planner: {
    simple: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    standard: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  implementer: {
    simple: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    standard: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  },
  codeReviewer: {
    simple: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    standard: { primary: deepseekPro, fallbacks: [deepseekFlash] },
    complex: { primary: deepseekPro, fallbacks: [deepseekFlash] }
  }
}

const economyTiers: Partial<Record<AgentRoleId, Partial<Record<TaskDifficulty, DifficultyBinding>>>> = {
  planner: {
    simple: { primary: deepseekFlash },
    standard: { primary: deepseekFlash },
    complex: { primary: deepseekFlash, fallbacks: [deepseekPro] }
  },
  implementer: {
    simple: { primary: deepseekFlash },
    standard: { primary: deepseekFlash },
    complex: { primary: deepseekFlash, fallbacks: [deepseekPro] }
  }
}

/** Built-in presets are DeepSeek-only templates; runtime remaps via materializePresetForHome. */
export const BUILTIN_ROUTING_PRESETS: RoutingPreset[] = [
  makePreset('fast', '快速', '单厂轻量协作：更快反馈，较少委派；复杂档仍可升到 Pro。', { maxReadonlyConcurrency: 2, maxDelegations: 5, maxExpertRepairHandoffs: 1 }, { implementer: deepseekFlash, verifier: deepseekFlash, codeReviewer: deepseekFlash, planner: deepseekFlash }, fastTiers),
  makePreset('balanced', '均衡', '单厂多模型默认平衡：按难度在 Flash / Pro 间升降。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, {}, balancedTiers),
  makePreset('deep', '深度', '单厂强模型偏置：规划、实现与审查优先 Pro，委派预算更高。', { maxReadonlyConcurrency: 3, maxDelegations: 10, maxExpertRepairHandoffs: 3 }, { router: deepseekPro, coordinator: deepseekPro, explorer: deepseekPro, verifier: deepseekPro, summarizer: deepseekPro }, deepTiers),
  makePreset('economy', '经济', '尽可能复用 Flash；复杂任务才短暂升档 Pro。', { maxReadonlyConcurrency: 2, maxDelegations: 5, maxExpertRepairHandoffs: 1 }, { planner: deepseekFlash, implementer: deepseekFlash, debugger: deepseekFlash, codeReviewer: deepseekFlash, verifier: deepseekFlash }, economyTiers),
  makePreset('code', '代码专精', '同厂强调实现与代码审查权重（仍为单厂；第三方审查可开伴厂专家槽）。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, { planner: deepseekPro, implementer: deepseekPro, codeReviewer: deepseekPro }, balancedTiers),
  makePreset('visual', '视觉专精', '同厂多模态偏置：视觉审查走 Flash；游戏测试推荐模型待评测，默认不引入第二厂。', { maxReadonlyConcurrency: 3, maxDelegations: 8, maxExpertRepairHandoffs: 2 }, { coordinator: deepseekPro, planner: deepseekPro, explorer: deepseekFlash, verifier: deepseekFlash, visualReviewer: deepseekFlash }),
  makePreset('single', '单模型兼容', '用当前选择的模型完成全部职责，兼容旧会话。', { maxReadonlyConcurrency: 1, maxDelegations: 1, maxExpertRepairHandoffs: 1 }, { planner: deepseekFlash, implementer: deepseekFlash, debugger: deepseekFlash, codeReviewer: deepseekFlash })
]

function classifyTemplateTier(model: ModelRef): 'fast' | 'strong' {
  if (model.providerId === 'deepseek') {
    return model.modelId.includes('pro') || model.modelId.includes('max') ? 'strong' : 'fast'
  }
  return isStrongModelId(model.modelId) ? 'strong' : 'fast'
}

function ladderPick(ladder: ProviderModelLadder, tier: 'fast' | 'strong' | 'vision'): ModelRef {
  if (tier === 'vision') return ladder.vision
  return tier === 'strong' ? ladder.strong : ladder.fast
}

function remapRefForRole(
  model: ModelRef,
  roleId: AgentRoleId,
  home: ProviderModelLadder,
  companion: ProviderModelLadder | null,
  expertRoles: ReadonlySet<string>
): ModelRef {
  const useCompanion = Boolean(companion && expertRoles.has(roleId))
  const ladder = useCompanion && companion ? companion : home
  if (roleId === 'visualReviewer') return ladder.vision
  return ladderPick(ladder, classifyTemplateTier(model))
}

function remapDifficultyBinding(
  value: DifficultyBinding,
  roleId: AgentRoleId,
  home: ProviderModelLadder,
  companion: ProviderModelLadder | null,
  expertRoles: ReadonlySet<string>
): DifficultyBinding {
  return {
    primary: remapRefForRole(value.primary, roleId, home, companion, expertRoles),
    ...(value.fallbacks?.length
      ? { fallbacks: value.fallbacks.map((item) => remapRefForRole(item, roleId, home, companion, expertRoles)) }
      : {})
  }
}

/** Rewrite a built-in preset onto the home ladder; companion only covers selected expert roles. */
export function materializePresetForHome(
  preset: RoutingPreset,
  homeProviderId: string,
  companionProviderId?: string,
  companionExpertRoles: readonly CompanionExpertRoleId[] = []
): RoutingPreset {
  if (!preset.builtIn) return preset
  const home = buildHomeProviderLadder(homeProviderId || 'deepseek')
  const companionId = companionProviderId?.trim()
  const companion = companionId && companionId !== homeProviderId
    ? buildHomeProviderLadder(companionId)
    : null
  const expertRoles = new Set(
    companion
      ? companionExpertRoles.filter((role) => (COMPANION_EXPERT_ROLE_IDS as readonly string[]).includes(role))
      : []
  )
  const roles = Object.fromEntries(AGENT_ROLE_IDS.map((roleId) => {
    const source = preset.roles[roleId]
    const next: RoleBinding = {
      ...source,
      primary: remapRefForRole(source.primary, roleId, home, companion, expertRoles),
      fallbacks: source.fallbacks.map((item) => remapRefForRole(item, roleId, home, companion, expertRoles)),
      ...(source.byDifficulty
        ? {
            byDifficulty: Object.fromEntries(
              (Object.entries(source.byDifficulty) as Array<[TaskDifficulty, DifficultyBinding]>).map(([tier, binding]) => [
                tier,
                remapDifficultyBinding(binding, roleId, home, companion, expertRoles)
              ])
            ) as Partial<Record<TaskDifficulty, DifficultyBinding>>
          }
        : {})
    }
    return [roleId, next]
  })) as Record<AgentRoleId, RoleBinding>
  return { ...preset, roles }
}

export function collectProviderIdsInPreset(preset: RoutingPreset): string[] {
  const ids = new Set<string>()
  for (const roleId of AGENT_ROLE_IDS) {
    const role = preset.roles[roleId]
    ids.add(role.primary.providerId)
    for (const fallback of role.fallbacks) ids.add(fallback.providerId)
    if (role.byDifficulty) {
      for (const tier of Object.values(role.byDifficulty)) {
        if (!tier) continue
        ids.add(tier.primary.providerId)
        for (const fallback of tier.fallbacks || []) ids.add(fallback.providerId)
      }
    }
  }
  return [...ids]
}

export function countProvidersInPreset(preset: RoutingPreset): number {
  return collectProviderIdsInPreset(preset).length
}

export function normalizeCompanionExpertRoles(raw: unknown): CompanionExpertRoleId[] {
  if (!Array.isArray(raw)) return ['codeReviewer']
  const allowed = new Set<string>(COMPANION_EXPERT_ROLE_IDS)
  const unique: CompanionExpertRoleId[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !allowed.has(item)) continue
    if (!unique.includes(item as CompanionExpertRoleId)) unique.push(item as CompanionExpertRoleId)
  }
  return unique.length ? unique : ['codeReviewer']
}

export function defaultRoutingConfig(): ModelRoutingConfig {
  return {
    version: 1,
    onboardingCompleted: false,
    homeProviderId: 'deepseek',
    companionExpertRoles: ['codeReviewer'],
    defaultSelection: { mode: 'routed', strategyId: 'balanced', taskTemplateId: 'auto' },
    hardLimits: { maxReadonlyConcurrency: 3, maxDelegations: 12, maxExpertRepairHandoffs: 3 },
    presets: []
  }
}

export function allRoutingPresets(config?: Pick<ModelRoutingConfig, 'presets'>): RoutingPreset[] {
  return [...BUILTIN_ROUTING_PRESETS, ...(config?.presets || [])]
}

type RoutingLookupConfig = Pick<ModelRoutingConfig, 'presets' | 'homeProviderId' | 'companionProviderId' | 'companionExpertRoles'>

export function findRoutingPreset(config: RoutingLookupConfig | Pick<ModelRoutingConfig, 'presets'> | undefined, id?: string): RoutingPreset {
  const preset = allRoutingPresets(config).find((item) => item.id === id) || BUILTIN_ROUTING_PRESETS[1]
  if (!preset.builtIn) return preset
  const homeProviderId = config && 'homeProviderId' in config && typeof config.homeProviderId === 'string'
    ? config.homeProviderId
    : 'deepseek'
  const companionProviderId = config && 'companionProviderId' in config ? config.companionProviderId : undefined
  const companionExpertRoles = config && 'companionExpertRoles' in config && Array.isArray(config.companionExpertRoles)
    ? config.companionExpertRoles
    : ['codeReviewer']
  return materializePresetForHome(preset, homeProviderId, companionProviderId, companionExpertRoles)
}

export function isVisionModelRef(model: ModelRef): boolean {
  return getCatalogVisionSupport(model.modelId, model.providerId) === true
}

export function modelRefKey(model: ModelRef): string {
  return `${model.providerId}:${model.modelId}`
}

export function resolveBindingForDifficulty(
  binding: RoleBinding,
  difficulty: TaskDifficulty
): { primary: ModelRef; fallbacks: ModelRef[] } {
  const tier = binding.byDifficulty?.[difficulty]
  if (!tier) return { primary: binding.primary, fallbacks: binding.fallbacks }
  return {
    primary: tier.primary,
    fallbacks: tier.fallbacks?.length ? tier.fallbacks : binding.fallbacks
  }
}

function templateKeywordHits(input: string, hasImages: boolean): Array<Exclude<TaskTemplateId, 'auto'>> {
  const hits: Array<Exclude<TaskTemplateId, 'auto'>> = []
  if (hasImages || /(?:gui|ui|界面|屏幕|预览|按钮|热键)/i.test(input)) hits.push('ui')
  if (/(?:报错|错误|崩溃|失败|bug|修复|异常)/i.test(input)) hits.push('bugfix')
  if (/(?:构建|gradle|jdk|环境|依赖)/i.test(input)) hits.push('build')
  if (/(?:方块|物品|实体|附魔|配方|minecraft)/i.test(input)) hits.push('minecraft')
  if (/(?:重构|整理|迁移)/i.test(input)) hits.push('refactor')
  if (/(?:文档|知识|说明|教程)/i.test(input)) hits.push('knowledge')
  return hits
}

export function extractRoutingSignals(input: string, template: TaskTemplateId, hasImages = false): RoutingSignals {
  const hits = templateKeywordHits(input, hasImages)
  const forced = template !== 'auto'
  const inferred: Exclude<TaskTemplateId, 'auto'> = forced
    ? (template as Exclude<TaskTemplateId, 'auto'>)
    : hits[0] || 'feature'
  const complex = /(?:重构|架构|多个|全局|迁移|复杂|并发)/i.test(input)
  const needsVision = inferred === 'ui' || hasImages || /(?:gui|ui|界面|屏幕|预览|按钮|热键)/i.test(input)
  const needsDebug = inferred === 'bugfix' || inferred === 'build' || /(?:报错|错误|崩溃|失败|bug|异常)/i.test(input)
  // Length is not difficulty. A pasted session goal or a verbose description used to
  // clear a 180-char bar and silently escalate the whole run to the strong model.
  const difficulty: TaskDifficulty = complex ? 'complex' : needsDebug ? 'standard' : 'simple'
  const ambiguous = !forced && (hits.length >= 2 || (hits.length === 0 && input.trim().length > 0 && input.trim().length < 80 && !/(?:功能|实现|添加|新增|做一|开发|帮我)/i.test(input)))
  return {
    taskTemplateId: inferred,
    difficulty,
    needsVision,
    needsDebug,
    ambiguous,
    confidence: ambiguous || hits.length === 0 ? 'low' : hits.length >= 2 ? 'low' : 'high'
  }
}

export function rolesForTemplate(template: Exclude<TaskTemplateId, 'auto'>): AgentRoleId[] {
  const roles: AgentRoleId[] = ['router', 'coordinator']
  if (template === 'ui') roles.push('explorer', 'planner', 'implementer', 'visualReviewer', 'verifier', 'summarizer')
  else if (template === 'bugfix') roles.push('explorer', 'debugger', 'planner', 'implementer', 'codeReviewer', 'verifier', 'summarizer')
  else if (template === 'knowledge') roles.push('explorer', 'summarizer')
  else if (template === 'build') roles.push('explorer', 'debugger', 'planner', 'implementer', 'verifier', 'summarizer')
  else roles.push('explorer', 'planner', 'implementer', 'codeReviewer', 'verifier', 'summarizer')
  return [...new Set(roles)]
}

/** Roles the harness will actually invoke for this turn intent (not display-only). */
export function executableRolesForIntent(decision: Pick<RouteDecision, 'roles' | 'taskTemplateId' | 'signals'>, intent: TurnRoutingIntent): AgentRoleId[] {
  const allowed = new Set(decision.roles)
  const active = new Set<AgentRoleId>()
  active.add('router')

  if (intent === 'chat') {
    if (allowed.has('coordinator')) active.add('coordinator')
    return AGENT_ROLE_IDS.filter((role) => active.has(role))
  }

  if (decision.taskTemplateId === 'knowledge') {
    if (allowed.has('explorer')) active.add('explorer')
    if (allowed.has('summarizer')) active.add('summarizer')
    return AGENT_ROLE_IDS.filter((role) => active.has(role))
  }

  if (intent === 'plan_only' || intent === 'develop') {
    if (allowed.has('explorer')) active.add('explorer')
    if (allowed.has('planner')) active.add('planner')
  }

  if (intent === 'develop' || intent === 'resume') {
    if (allowed.has('debugger') && decision.signals.needsDebug) active.add('debugger')
    if (allowed.has('implementer')) active.add('implementer')
    if (allowed.has('visualReviewer') && decision.signals.needsVision) active.add('visualReviewer')
    if (intent === 'develop' && allowed.has('codeReviewer')) active.add('codeReviewer')
    if (allowed.has('summarizer')) active.add('summarizer')
  }

  if (intent === 'plan_only' && allowed.has('summarizer')) active.add('summarizer')

  return AGENT_ROLE_IDS.filter((role) => active.has(role))
}

export function buildRouteDecisionFromSignals(
  signals: RoutingSignals,
  source: RouteDecisionSource = 'rules',
  intent: TurnRoutingIntent = 'develop'
): RouteDecision {
  const roles = rolesForTemplate(signals.taskTemplateId)
  const activeRoles = executableRolesForIntent({ roles, taskTemplateId: signals.taskTemplateId, signals }, intent)
  const unique = roles
  const delegations: DelegationTask[] = activeRoles.map((roleId, index) => ({
    id: `${roleId}_${index + 1}`,
    roleId,
    dependsOn: roleId === 'implementer'
      ? activeRoles.filter((id) => id === 'planner' || id === 'debugger' || id === 'explorer')
      : roleId === 'summarizer'
        ? activeRoles.filter((id) => id !== 'summarizer' && id !== 'router')
        : roleId === 'codeReviewer'
          ? activeRoles.filter((id) => id === 'implementer')
          : [],
    readOnly: roleId !== 'implementer',
    reason: `${TASK_TEMPLATE_LABELS[signals.taskTemplateId]}任务需要${ROLE_LABELS[roleId]}职责`
  }))
  return {
    difficulty: signals.difficulty,
    taskTemplateId: signals.taskTemplateId,
    roles: unique,
    activeRoles,
    delegations,
    signals,
    reason: `${source === 'rules' ? '规则' : source === 'model' ? '模型' : source === 'hybrid' ? '混合' : '回退'}识别为「${TASK_TEMPLATE_LABELS[signals.taskTemplateId]}」，难度为${DIFFICULTY_LABELS[signals.difficulty]}${signals.ambiguous ? '（信号歧义）' : ''}。`,
    source
  }
}

export function buildStaticRouteDecision(input: string, template: TaskTemplateId, hasImages = false, intent: TurnRoutingIntent = 'develop'): RouteDecision {
  return buildRouteDecisionFromSignals(extractRoutingSignals(input, template, hasImages), 'rules', intent)
}

/** Sync rules entrypoint. Prefer hybrid resolveRouteDecision in the controller. */
export const routeUserTurn = buildStaticRouteDecision

export function withActiveRoles(decision: RouteDecision, intent: TurnRoutingIntent): RouteDecision {
  const activeRoles = executableRolesForIntent(decision, intent)
  return {
    ...decision,
    activeRoles,
    delegations: activeRoles.map((roleId, index) => ({
      id: `${roleId}_${index + 1}`,
      roleId,
      dependsOn: roleId === 'implementer'
        ? activeRoles.filter((id) => id === 'planner' || id === 'debugger' || id === 'explorer')
        : roleId === 'summarizer'
          ? activeRoles.filter((id) => id !== 'summarizer' && id !== 'router')
          : roleId === 'codeReviewer'
            ? activeRoles.filter((id) => id === 'implementer')
            : [],
      readOnly: roleId !== 'implementer',
      reason: `${TASK_TEMPLATE_LABELS[decision.taskTemplateId]}任务需要${ROLE_LABELS[roleId]}职责`
    }))
  }
}

/** Fold a retired model id onto its canonical catalog id, keeping the provider. */
function normalizeModelRef(candidate: ModelRef): ModelRef {
  const modelId = normalizeModelId(candidate.providerId, candidate.modelId)
  return modelId === candidate.modelId ? candidate : { providerId: candidate.providerId, modelId }
}

/**
 * Rewrite every ref in a saved custom preset through the catalog alias table, so a
 * retired DeepSeek id cannot survive in persisted routing config indefinitely.
 */
function normalizePresetRefs(preset: RoutingPreset): RoutingPreset {
  const fixBinding = (binding: RoleBinding): RoleBinding => ({
    ...binding,
    primary: normalizeModelRef(binding.primary),
    fallbacks: binding.fallbacks.map(normalizeModelRef),
    ...(binding.byDifficulty
      ? {
          byDifficulty: Object.fromEntries(
            (Object.entries(binding.byDifficulty) as Array<[TaskDifficulty, DifficultyBinding | undefined]>).map(([tier, tierBinding]) => [
              tier,
              tierBinding
                ? {
                    primary: normalizeModelRef(tierBinding.primary),
                    fallbacks: (tierBinding.fallbacks || []).map(normalizeModelRef)
                  }
                : tierBinding
            ])
          ) as Partial<Record<TaskDifficulty, DifficultyBinding>>
        }
      : {})
  })
  return {
    ...preset,
    roles: Object.fromEntries(
      AGENT_ROLE_IDS.map((roleId) => [roleId, fixBinding(preset.roles[roleId])])
    ) as Record<AgentRoleId, RoleBinding>
  }
}

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
  const homeProviderId = typeof value.homeProviderId === 'string' && value.homeProviderId.trim()
    ? value.homeProviderId.trim()
    : fallback.homeProviderId
  const companionRaw = typeof value.companionProviderId === 'string' ? value.companionProviderId.trim() : ''
  const companionProviderId = companionRaw && companionRaw !== homeProviderId && getProvider(companionRaw)
    ? companionRaw
    : undefined
  // A persisted selection ref is only honoured when the catalog still backs it; opaque
  // endpoint-style providers have no catalog and are kept verbatim.
  const rawSelectionModel = selection?.model
  const selectionModel = isValidModelRef(rawSelectionModel) ? normalizeModelRef(rawSelectionModel) : undefined
  const selectionProvider = selectionModel ? getProvider(selectionModel.providerId) : undefined
  const usableSelectionModel = selectionModel
    && (!selectionProvider?.models.length || findModelInProvider(selectionModel.providerId, selectionModel.modelId))
    ? selectionModel
    : undefined
  return {
    version: 1,
    onboardingCompleted: Boolean(value.onboardingCompleted),
    homeProviderId,
    ...(companionProviderId ? { companionProviderId } : {}),
    companionExpertRoles: normalizeCompanionExpertRoles(value.companionExpertRoles),
    defaultSelection: {
      mode: selection?.mode === 'fixed' ? 'fixed' : 'routed',
      strategyId: typeof selection?.strategyId === 'string' ? selection.strategyId : fallback.defaultSelection.strategyId,
      taskTemplateId: validTemplate,
      ...(selection?.customPresetId ? { customPresetId: selection.customPresetId } : {}),
      ...(usableSelectionModel ? { model: usableSelectionModel } : {})
    },
    hardLimits: {
      maxReadonlyConcurrency: limit(value.hardLimits?.maxReadonlyConcurrency, 1, 3, 3),
      maxDelegations: limit(value.hardLimits?.maxDelegations, 1, 12, 12),
      maxExpertRepairHandoffs: limit(value.hardLimits?.maxExpertRepairHandoffs, 0, 3, 3)
    },
    presets: Array.isArray(value.presets) ? value.presets.filter((preset): preset is RoutingPreset => isValidCustomPreset(preset)).map(normalizePresetRefs) : []
  }
}

function isValidModelRef(value: unknown): value is ModelRef {
  return Boolean(value && typeof value === 'object' && typeof (value as ModelRef).providerId === 'string' && typeof (value as ModelRef).modelId === 'string')
}

function isValidDifficultyBinding(value: unknown): value is DifficultyBinding {
  if (!value || typeof value !== 'object') return false
  const binding = value as Partial<DifficultyBinding>
  if (!isValidModelRef(binding.primary)) return false
  if (binding.fallbacks !== undefined && !(Array.isArray(binding.fallbacks) && binding.fallbacks.every(isValidModelRef))) return false
  return true
}

function isValidCustomPreset(value: unknown): value is RoutingPreset {
  if (!value || typeof value !== 'object') return false
  const preset = value as Partial<RoutingPreset>
  if (preset.builtIn === true || !preset.id || !preset.label || !preset.description || !preset.roles || !preset.budget) return false
  if (!Number.isFinite(preset.budget.maxReadonlyConcurrency) || !Number.isFinite(preset.budget.maxDelegations) || !Number.isFinite(preset.budget.maxExpertRepairHandoffs)) return false
  return AGENT_ROLE_IDS.every((role) => {
    const binding = preset.roles?.[role]
    if (!binding || !isValidModelRef(binding.primary) || !Array.isArray(binding.fallbacks) || !binding.fallbacks.every(isValidModelRef)) return false
    if (typeof binding.enabled !== 'boolean' || typeof binding.required !== 'boolean') return false
    if (binding.promptAppend !== undefined && typeof binding.promptAppend !== 'string') return false
    if (binding.byDifficulty) {
      const tiers = Object.keys(binding.byDifficulty) as TaskDifficulty[]
      if (!tiers.every((tier) => ['simple', 'standard', 'complex'].includes(tier) && isValidDifficultyBinding(binding.byDifficulty?.[tier]))) return false
    }
    return true
  })
}
