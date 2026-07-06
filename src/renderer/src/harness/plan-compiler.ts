import {
  BUILD_STEP_PATTERN,
  MAX_PLAN_STEPS,
  RUN_STEP_PATTERN,
  isOpsOnlyPlan,
  parsePlanSteps,
  type ParsedPlanStep
} from '../utils/plan-steps.ts'

export type StructuredStepKind = 'write' | 'recipe' | 'inspect'

export interface CompiledPlanStep extends ParsedPlanStep {
  kind?: StructuredStepKind
  targetPath?: string
  hostManaged?: boolean
}

const STRUCTURED_KIND_RE = /^\[(write|recipe|inspect)\]\s*/i
const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;—\-]+)(?:`)?/i
const VAGUE_STEP_RE = /确保|测试功能|检查|验证|确认无错|输出总结/
const KNOWLEDGE_INSPECT_RE = /mixin|网络|payload|datagen|新\s*api|access\s*widener/i

const HOST_BUILD_DESC = '构建项目（gradlew build）'
const HOST_RUN_DESC = '启动游戏进行真实测试（runClient）'
const HOST_INSPECT_DESC =
  '查询知识库确认当前 Minecraft/Fabric 版本 API 与资源格式（fabric_docs_search / fabric_meta_version_check）'

function renumber(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return steps.map((s, i) => ({ ...s, id: String(i + 1) }))
}

function isHostTerminalStep(description: string): boolean {
  const d = description.toLowerCase()
  return BUILD_STEP_PATTERN.test(d) || RUN_STEP_PATTERN.test(d)
}

function parseStructuredLine(description: string): { kind?: StructuredStepKind; body: string; targetPath?: string } {
  const kindMatch = description.match(STRUCTURED_KIND_RE)
  const kind = kindMatch ? (kindMatch[1].toLowerCase() as StructuredStepKind) : undefined
  const body = kindMatch ? description.slice(kindMatch[0].length).trim() : description
  const pathMatch = body.match(PATH_RE)
  return { kind, body, targetPath: pathMatch?.[1]?.replace(/\\/g, '/') }
}

export function parseStructuredSteps(text: string): CompiledPlanStep[] {
  const raw = parsePlanSteps(text)
  return raw.map((step) => {
    const { kind, body, targetPath } = parseStructuredLine(step.description)
    return {
      ...step,
      description: body || step.description,
      kind,
      targetPath
    }
  })
}

export function dropVagueSteps(steps: CompiledPlanStep[]): CompiledPlanStep[] {
  return steps.filter((s) => {
    if (s.hostManaged) return true
    if (PATH_RE.test(s.description)) return true
    if (s.kind === 'recipe' || s.kind === 'write' || s.kind === 'inspect') return true
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
    const key = (step.targetPath || step.description).toLowerCase().replace(/[\s`*_、,，。.；;：:()（）!！?？~-]/g, '')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(step)
  }
  return result
}

export function needsKnowledgeInspect(steps: CompiledPlanStep[]): boolean {
  if (steps.length === 0) return false
  if (isOpsOnlyPlan(steps)) return false
  if (steps.some((s) => s.kind === 'inspect')) return false
  if (steps.some((s) => KNOWLEDGE_INSPECT_RE.test(s.description))) return true
  const onlyRecipe = steps.every((s) => s.kind === 'recipe' || /配方|recipe/i.test(s.description))
  if (onlyRecipe) return false
  const missingPath = steps.some(
    (s) => (s.kind === 'write' || !s.kind) && !s.targetPath && !PATH_RE.test(s.description)
  )
  return missingPath
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
  steps = stripHostTerminalFromLlmSteps(steps)
  steps = dropVagueSteps(steps)
  steps = dedupeByPath(steps)
  if (needsKnowledgeInspect(steps)) {
    steps = prependKnowledgeInspect(steps)
  }
  steps = appendHostTerminalSteps(steps)
  return steps
}

export function compiledStepsToParsed(steps: CompiledPlanStep[]): ParsedPlanStep[] {
  return steps.map(({ id, description }) => ({ id, description }))
}
