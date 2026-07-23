import {
  BUILD_STEP_PATTERN,
  MAX_PLAN_STEPS,
  RUN_STEP_PATTERN,
  isOpsOnlyPlan,
  parsePlanSteps,
  type ParsedPlanStep
} from '../utils/plan-steps.ts'

export type StructuredStepKind = 'write' | 'recipe' | 'mixin' | 'inspect'

export interface CompiledPlanStep extends ParsedPlanStep {
  kind?: StructuredStepKind
  targetPath?: string
  targetPaths?: string[]
  hostManaged?: boolean
  evidence?: string
}

const STRUCTURED_KIND_RE = /^\[(write|recipe|mixin|inspect)\]\s*/i
const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;—\-]+)(?:`)?/i
const VAGUE_STEP_RE = /确保|测试功能|检查|验证|确认无错|输出总结/
const KNOWLEDGE_INSPECT_RE = /mixin|网络|payload|datagen|新\s*api|access\s*widener|右键|交互|interact/i

const HOST_BUILD_DESC = '构建项目（gradlew build）'
const HOST_RUN_DESC = '启动游戏进行真实测试（runClient）'
const HOST_INSPECT_DESC =
  '查询知识库确认当前 Minecraft/Fabric 版本 API 与资源格式（fabric_docs_search / fabric_meta_version_check）'

const MIXIN_AUDIT_DESC =
  '检查现有 Mixin 配置与源码：先读 mixins.json 列出已注册 Mixin，再读每个已注册 Mixin 的 Java 源码，确认功能不重复'

const MIXIN_PATH_RE = /mixin/i
const MIXIN_WRITE_RE = /mixin|@Mixin|Mixin\s*(类|class)/i
const NEW_MIXIN_RE = /新建.*[Mm]ixin|创建.*[Mm]ixin|新增.*[Mm]ixin|新.*[Mm]ixin|scaffold.*[Mm]ixin/i
const MIXIN_JAVA_PATH_RE = /(?:^|\/)mixin\/|Mixin\.java$/i
const JAVA_NAME_RE = /([A-Za-z_][\w]*\.java)/g

function normalizePlanPath(path: string): string {
  return path.replace(/\\/g, '/').trim()
}

function stepTargetPaths(step: {
  targetPath?: string
  targetPaths?: string[]
  description?: string
}): string[] {
  const paths = [
    ...(step.targetPath ? [step.targetPath] : []),
    ...(step.targetPaths || [])
  ]
  return paths.map(normalizePlanPath).filter(Boolean)
}

/** Prefer explicit target paths; fall back to Foo.java names in the description. */
export function collectJavaTargets(step: {
  targetPath?: string
  targetPaths?: string[]
  description?: string
}): string[] {
  const fromTargets = stepTargetPaths(step).filter((path) => path.endsWith('.java'))
  if (fromTargets.length > 0) return fromTargets
  const desc = step.description || ''
  const names = [...desc.matchAll(JAVA_NAME_RE)].map((match) => match[1])
  return [...new Set(names)]
}

function isMixinJavaTarget(pathOrName: string): boolean {
  const normalized = normalizePlanPath(pathOrName)
  return MIXIN_JAVA_PATH_RE.test(normalized)
}

/**
 * Only use kind=mixin when every Java target is a Mixin class.
 * Hybrid write steps (Screen/Client/Mod + mixins.json) must stay `write`,
 * otherwise write_file is gated off and long tasks stall mid-plan.
 */
export function shouldForceMixinKind(step: CompiledPlanStep): boolean {
  const javaPaths = collectJavaTargets(step)
  if (javaPaths.length > 0) {
    return javaPaths.every((path) => isMixinJavaTarget(path))
  }

  if (step.kind === 'mixin') return true

  // No java targets: only force mixin when description is clearly mixin-class work,
  // not when mixins.json is merely one of several resource updates.
  if (MIXIN_WRITE_RE.test(step.description) && /@Mixin|Mixin\s*(类|class)|注入/.test(step.description)) {
    return !/\.java/i.test(step.description) || MIXIN_JAVA_PATH_RE.test(step.description)
  }
  return false
}

/** Hybrid steps labeled mixin by the model/persisted plan must be demoted to write. */
export function resolveCompiledStepKind(step: {
  kind?: StructuredStepKind
  description: string
  targetPath?: string
  targetPaths?: string[]
}): StructuredStepKind | undefined {
  // inspect/recipe are intentional — never promote to mixin just because targets are Mixin*.java
  // (that turned "读 Mixin 源码" into register/validate and dropped the real write path).
  if (step.kind === 'inspect' || step.kind === 'recipe') return step.kind

  const javaPaths = collectJavaTargets(step)
  if (javaPaths.length > 0) {
    if (javaPaths.every((path) => isMixinJavaTarget(path))) return 'mixin'
    return 'write'
  }
  if (shouldForceMixinKind(step as CompiledPlanStep)) return 'mixin'
  return step.kind
}

function renumber(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return steps.map((s, i) => ({ ...s, id: String(i + 1) }))
}

function isHostTerminalStep(description: string): boolean {
  const d = description.toLowerCase()
  return BUILD_STEP_PATTERN.test(d) || RUN_STEP_PATTERN.test(d)
}

function parseStructuredLine(description: string): { kind?: StructuredStepKind; body: string; targetPath?: string; evidence?: string } {
  const kindMatch = description.match(STRUCTURED_KIND_RE)
  const kind = kindMatch ? (kindMatch[1].toLowerCase() as StructuredStepKind) : undefined
  const taggedBody = kindMatch ? description.slice(kindMatch[0].length).trim() : description
  const evidenceMatch = taggedBody.match(/[;；]\s*evidence\s*[:：]\s*(.+)$/i)
  const evidence = evidenceMatch?.[1]?.trim()
  const body = evidenceMatch ? taggedBody.slice(0, evidenceMatch.index).trim() : taggedBody
  const pathMatch = body.match(PATH_RE)
  return { kind, body, targetPath: pathMatch?.[1]?.replace(/\\/g, '/'), evidence }
}

const JSON_PLAN_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i

export interface JsonPlanStepInput {
  kind?: string
  description?: string
  title?: string
  targetPath?: string
  path?: string
  targetPaths?: string[]
  evidence?: string
}

/** Prefer fenced/raw JSON plan arrays when present; otherwise fall back to numbered lines. */
export function parseJsonPlanSteps(text: string): CompiledPlanStep[] | null {
  const candidates: string[] = []
  const fence = text.match(JSON_PLAN_FENCE_RE)
  if (fence?.[1]) candidates.push(fence[1].trim())
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1).trim())
  }

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { steps?: unknown }).steps)
          ? (parsed as { steps: unknown[] }).steps
          : null
      if (!list || list.length === 0) continue

      const steps: CompiledPlanStep[] = []
      for (let i = 0; i < list.length; i++) {
        const item = list[i] as JsonPlanStepInput
        if (!item || typeof item !== 'object') continue
        const description = String(item.description || item.title || '').trim()
        if (!description) continue
        const kindRaw = String(item.kind || '').toLowerCase()
        const kind = (['write', 'recipe', 'mixin', 'inspect'].includes(kindRaw)
          ? kindRaw
          : undefined) as StructuredStepKind | undefined
        const targetPath = (item.targetPath || item.path || '').replace(/\\/g, '/') || undefined
        const targetPaths = Array.isArray(item.targetPaths)
          ? item.targetPaths.map(String).map((path) => path.replace(/\\/g, '/')).filter(Boolean)
          : undefined
        const evidence = item.evidence ? String(item.evidence).trim() : undefined
        steps.push({
          id: String(i + 1),
          description,
          kind,
          targetPath,
          ...(targetPaths && targetPaths.length > 0 ? { targetPaths } : {}),
          ...(evidence ? { evidence } : {})
        })
      }
      if (steps.length > 0) return steps
    } catch {
      // try next candidate
    }
  }
  return null
}

export function parseStructuredSteps(text: string): CompiledPlanStep[] {
  const fromJson = parseJsonPlanSteps(text)
  if (fromJson) return fromJson

  const raw = parsePlanSteps(text)
  return raw.map((step) => {
    const { kind, body, targetPath, evidence } = parseStructuredLine(step.description)
    return {
      ...step,
      description: body || step.description,
      kind,
      targetPath,
      ...(evidence ? { evidence } : {})
    }
  })
}

export function dropVagueSteps(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return steps.filter((s) => {
    if (s.hostManaged) return true
    if (PATH_RE.test(s.description)) return true
    if (s.kind === 'recipe' || s.kind === 'write' || s.kind === 'mixin' || s.kind === 'inspect') return true
    if (VAGUE_STEP_RE.test(s.description) && !PATH_RE.test(s.description)) return false
    return true
  })
}

export function stripHostTerminalFromLlmSteps(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return steps.filter((s) => !isHostTerminalStep(s.description))
}

export function dedupeByPath(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  const seen = new Set<string>()
  const result: CompiledPlanStep[] = []
  for (const step of steps) {
    const pathKey = (step.targetPath || step.targetPaths?.join('|') || step.description)
      .toLowerCase()
      .replace(/[\s`*_、,，。.；;：:()（）!！?？~-]/g, '')
    // Include kind so inspect→write same path keeps the write (diag: write was dropped).
    const key = pathKey ? `${step.kind || ''}|${pathKey}` : ''
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(step)
  }
  return result
}

const TEMPLATE_QUICK_CREATE_RE = /模板\s*ID\s*[：:]\s*custom-(?:block|item|food|tool|armor|entity)/i

export function isTemplateQuickCreateText(text: string): boolean {
  return TEMPLATE_QUICK_CREATE_RE.test(text)
}

export function needsKnowledgeInspect(steps: CompiledPlanStep[], sourceText?: string): boolean {
  if (sourceText && isTemplateQuickCreateText(sourceText)) return false
  if (steps.length === 0) return false
  if (isOpsOnlyPlan(steps)) return false
  if (steps.some((s) => s.kind === 'inspect')) return false
  if (steps.some((s) => KNOWLEDGE_INSPECT_RE.test(s.description))) return true
  const onlyRecipe = steps.every((s) => s.kind === 'recipe' || /配方|recipe/i.test(s.description))
  if (onlyRecipe) return false
  const missingPath = steps.some(
    (s) => (s.kind === 'write' || !s.kind) && !s.targetPath && !s.targetPaths?.length && !PATH_RE.test(s.description)
  )
  return missingPath
}

/** Detect plans that write new Mixin classes — these require checking existing
 *  Mixin config AND source files first to avoid duplicating functionality. */
export function needsMixinAudit(steps: CompiledPlanStep[]): boolean {
  if (steps.length === 0) return false
  if (isOpsOnlyPlan(steps)) return false
  // Already has an inspect step that covers mixin audit
  if (steps.some((s) => s.kind === 'inspect' && MIXIN_AUDIT_DESC.includes('Mixin'))) return false
  // Any write step targeting a mixin directory or mentioning mixin
  return steps.some((s) => {
    if (s.kind !== 'write' && s.kind !== 'mixin') return false
    const target = (s.targetPath || '').toLowerCase()
    const desc = s.description.toLowerCase()
    return MIXIN_PATH_RE.test(target) || MIXIN_WRITE_RE.test(desc)
  })
}

/** Detect plans that create a NEW Mixin file — the plan must include a step
 *  to register it in mixins.json, or host will warn. */
export function needsMixinsJsonRegistrationStep(steps: CompiledPlanStep[]): boolean {
  const createsNewMixin = steps.some((s) => {
    if (s.kind !== 'write' && s.kind !== 'mixin') return false
    const target = (s.targetPath || '').toLowerCase()
    const desc = s.description.toLowerCase()
    // Target is a new mixin Java file
    if (MIXIN_PATH_RE.test(target) && target.endsWith('.java')) return true
    // Description says "新建/创建 mixin"
    if (NEW_MIXIN_RE.test(desc)) return true
    return false
  })
  if (!createsNewMixin) return false
  // Check if there's already a step to update mixins.json
  return !steps.some((s) => {
    const target = (s.targetPath || '').toLowerCase()
    const desc = s.description.toLowerCase()
    return target.includes('mixins.json') || target.includes('mixins.') ||
      desc.includes('mixins.json') || desc.includes('mixins 配置') ||
      desc.includes('注册 mixin') || desc.includes('mixin 配置')
  })
}

export function prependMixinAuditStep(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return renumber([
    { id: '0', description: MIXIN_AUDIT_DESC, kind: 'inspect', hostManaged: true },
    ...steps
  ].slice(0, MAX_PLAN_STEPS))
}

export function appendMixinsJsonUpdateWarning(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  // Append a write step to remind about mixins.json registration
  const result = [...steps]
  result.push({
    id: '0',
    description: '更新 mixins.json — 将新创建的 Mixin 类名追加到 mixins 数组中（若文件已存在则先读后写，勿覆盖已有条目）',
    kind: 'write',
    hostManaged: false
  })
  return renumber(result.slice(0, MAX_PLAN_STEPS))
}

export function appendHostTerminalSteps(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  if (steps.length === 0) return steps
  const hasBuild = steps.some((s) => BUILD_STEP_PATTERN.test(s.description))
  const hasRun = steps.some((s) => RUN_STEP_PATTERN.test(s.description))
  const result = [...steps]
  if (!hasBuild) {
    result.push({ id: '0', description: HOST_BUILD_DESC, hostManaged: true })
  }
  if (!hasRun) {
    result.push({ id: '0', description: HOST_RUN_DESC, hostManaged: true })
  }
  return renumber(result.slice(0, MAX_PLAN_STEPS))
}

export function prependKnowledgeInspect(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return renumber([
    { id: '0', description: HOST_INSPECT_DESC, kind: 'inspect', hostManaged: true },
    ...steps
  ].slice(0, MAX_PLAN_STEPS))
}

export function compilePlanFromText(text: string): CompiledPlanStep[] {
  let steps = parseStructuredSteps(text)
  // Pure build/run plans are entirely host terminals. stripHostTerminalFromLlmSteps
  // would leave [] and appendHostTerminalSteps([]) is a no-op — so restore terminals
  // from the source instead of inventing an empty "all done" workflow.
  const opsOnlySource = isOpsOnlyPlan(steps)
  const sourceHasBuild = steps.some((s) => BUILD_STEP_PATTERN.test(s.description))
  const sourceHasRun = steps.some((s) => RUN_STEP_PATTERN.test(s.description))

  steps = steps.map((step) => {
    const kind = resolveCompiledStepKind(step)
    if (kind !== 'mixin') {
      return kind && kind !== step.kind ? { ...step, kind } : step
    }
    return {
      ...step,
      kind: 'mixin' as const,
      description: /fabric_mixin_register|注册/i.test(step.description)
        ? step.description
        : `${step.description}；使用 fabric_mixin_register 注册并由 fabric_mixin_validate 验证`
    }
  })
  steps = stripHostTerminalFromLlmSteps(steps)
  steps = dropVagueSteps(steps)
  steps = dedupeByPath(steps)

  if (opsOnlySource) {
    const restored: CompiledPlanStep[] = []
    if (sourceHasBuild) {
      restored.push({ id: '0', description: HOST_BUILD_DESC, hostManaged: true })
    }
    if (sourceHasRun) {
      restored.push({ id: '0', description: HOST_RUN_DESC, hostManaged: true })
    }
    return renumber(restored)
  }

  // Mixin audit: force agent to read existing config + sources before writing
  if (needsMixinAudit(steps)) {
    steps = prependMixinAuditStep(steps)
  }
  if (needsKnowledgeInspect(steps, text)) {
    steps = prependKnowledgeInspect(steps)
  }
  steps = appendHostTerminalSteps(steps)
  steps = steps.map((step) => {
    if (step.hostManaged || step.evidence?.trim()) return step
    const evidence = defaultEvidenceForKind(step.kind)
    return evidence ? { ...step, evidence } : step
  })
  return steps
}

function defaultEvidenceForKind(kind: StructuredStepKind | undefined): string | undefined {
  switch (kind) {
    case 'mixin':
      return 'fabric_mixin_validate 通过'
    case 'recipe':
      return 'fabric_recipe_validate 通过'
    case 'write':
      return '目标文件已写入且内容正确'
    case 'inspect':
      return '已完成勘察确认'
    default:
      return undefined
  }
}

export function compiledStepsToParsed(steps: CompiledPlanStep[]): ParsedPlanStep[] {
  return steps.map(({ id, description, kind, targetPath, targetPaths, evidence }) => ({
    id,
    description,
    ...(kind ? { kind } : {}),
    ...(targetPath ? { targetPath } : {}),
    ...(targetPaths?.length ? { targetPaths } : {}),
    ...(evidence ? { evidence } : {})
  }))
}
