export interface ParsedPlanStep {
  id: string
  description: string
  kind?: 'inspect' | 'write' | 'recipe'
  targetPath?: string
}

export const OPS_STEP_PATTERN = /gradlew|gradle\s|runClient|trigger_build|run_command|编译|构建|运行|build/i

/** Upper bound on plan steps to guard against runaway/verbose plans */
export const MAX_PLAN_STEPS = 12

export const BUILD_STEP_PATTERN = /gradlew|gradle\s|trigger_build|编译|构建|build/i
export const RUN_STEP_PATTERN = /runclient|启动游戏|运行游戏|真实测试/i

/** True when a single plan line asks for both build and runClient in one step. */
export function isCombinedBuildRunDescription(description: string): boolean {
  const d = description.toLowerCase()
  return BUILD_STEP_PATTERN.test(d) && RUN_STEP_PATTERN.test(d)
}
const GENERIC_TEST_PATTERN = /测试|检查|确认|验证/

function stepTerminalKind(description: string): 'build' | 'run' | 'other' {
  const d = description.toLowerCase()
  if (RUN_STEP_PATTERN.test(d)) return 'run'
  if (BUILD_STEP_PATTERN.test(d)) return 'build'
  return 'other'
}

function renumberPlanSteps(steps: ParsedPlanStep[]): ParsedPlanStep[] {
  return steps.map((s, i) => ({ ...s, id: String(i + 1) }))
}

const INSPECT_STEP_PATTERN = /查询.*知识|知识库|fabric_docs_search|fabric_meta_version_check|文档|javadoc|wiki|mappings/i

/** Prepend a knowledge inspect step for dev plans that will write files or recipes. */
export function ensureKnowledgeInspectStep(steps: ParsedPlanStep[]): ParsedPlanStep[] {
  if (steps.length === 0) return steps
  if (isOpsOnlyPlan(steps)) return renumberPlanSteps(steps)
  const hasInspect = steps.some((s) => INSPECT_STEP_PATTERN.test(s.description))
  if (hasInspect) return renumberPlanSteps(steps)

  const result: ParsedPlanStep[] = [
    {
      id: '0',
      description: '查询知识库确认当前 Minecraft/Fabric 版本 API 与资源格式（fabric_docs_search / fabric_meta_version_check）'
    },
    ...steps
  ]
  return renumberPlanSteps(result.slice(0, MAX_PLAN_STEPS))
}

/** Ensure dev plans end with build + runClient steps for real testing. */
export function ensureDevTerminalSteps(steps: ParsedPlanStep[]): ParsedPlanStep[] {
  const withKnowledge = ensureKnowledgeInspectStep(steps)
  if (withKnowledge.length === 0) return withKnowledge

  const hasBuild = withKnowledge.some((s) => stepTerminalKind(s.description) === 'build')
  const hasRun = withKnowledge.some((s) => stepTerminalKind(s.description) === 'run')

  if (isOpsOnlyPlan(withKnowledge) && hasBuild && hasRun) {
    return renumberPlanSteps(withKnowledge)
  }

  let result = [...withKnowledge]
  if (!hasBuild) result.push({ id: '0', description: '构建项目（gradlew build）' })
  if (!hasRun) result.push({ id: '0', description: '启动游戏进行真实测试（runClient）' })

  while (result.length > MAX_PLAN_STEPS) {
    const genericIdx = result.findIndex(
      (s, i) => i < result.length - 2 && stepTerminalKind(s.description) === 'other' && GENERIC_TEST_PATTERN.test(s.description)
    )
    if (genericIdx >= 0) {
      result.splice(genericIdx, 1)
      continue
    }
    const otherIdx = result.findIndex((s, i) => i < result.length - 2 && stepTerminalKind(s.description) === 'other')
    if (otherIdx >= 0) {
      result.splice(otherIdx, 1)
      continue
    }
    break
  }

  return renumberPlanSteps(result.slice(0, MAX_PLAN_STEPS))
}

/** Normalize a step description for duplicate detection */
function normalizeStepDescription(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[\s`*_、,，。.；;：:()（）!！?？~-]/g, '')
}

/** Parse numbered plan lines from AI markdown text (deduped + capped) */
export function parsePlanSteps(text: string): ParsedPlanStep[] {
  const steps: ParsedPlanStep[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.replace(/^[\s*\-]+/, '').trim()
    const match = trimmed.match(/^(\d+)[.\、\s]+(.+)$/)
    if (!match) continue
    const description = match[2].trim()
    const key = normalizeStepDescription(description)
    if (!key || seen.has(key)) continue
    seen.add(key)
    steps.push({ id: String(steps.length + 1), description })
    if (steps.length >= MAX_PLAN_STEPS) break
  }
  return steps
}

/** True when every parsed step is build/run ops (no file authoring). */
export function isOpsOnlyPlan(steps: ParsedPlanStep[]): boolean {
  if (steps.length === 0) return false
  return steps.every((s) => OPS_STEP_PATTERN.test(s.description))
}

export function planHasActionableSteps(text: string): boolean {
  return parsePlanSteps(text).length >= 1
}

/**
 * Pick the single best plan source. The model's chain-of-thought (reasoning)
 * frequently drafts several numbered build/run lists; merging it inflates the
 * plan. Prefer the final answer, then streamed text, and only fall back to
 * reasoning when neither contains parseable steps.
 */
export function selectPlanText(reasoning: string, streamedText: string, finalAnswer: string): string {
  const finalT = finalAnswer.trim()
  if (finalT && planHasActionableSteps(finalT)) return finalT
  const streamT = streamedText.trim()
  if (streamT && planHasActionableSteps(streamT)) return streamT
  const reasoningT = reasoning.trim()
  if (reasoningT && planHasActionableSteps(reasoningT)) return reasoningT
  return finalT || streamT || reasoningT
}

/** UI-visible plan source — never fall back to reasoning (avoids CoT numbered lists). */
export function selectVisiblePlanText(streamedText: string, finalAnswer: string): string {
  const finalT = finalAnswer.trim()
  if (finalT && planHasActionableSteps(finalT)) return finalT
  const streamT = streamedText.trim()
  if (streamT && planHasActionableSteps(streamT)) return streamT
  return finalT || streamT
}

/** Whether plan text should proceed to execute phase */
export function isActionablePlanText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/无法制定|暂无.*计划|等待用户提供|仅打招呼|无法输出.*计划|无法继续.*计划/i.test(trimmed)) {
    return false
  }
  if (!planHasActionableSteps(trimmed)) return false
  const steps = parsePlanSteps(trimmed)
  const corpus = `${trimmed}\n${steps.map((s) => s.description).join('\n')}`
  const hasFileRef = /\.(java|json|gradle|properties|toml)|src\/|gradle\//i.test(corpus)
  const hasOpsRef =
    isOpsOnlyPlan(steps) ||
    /gradlew|gradle\s|runClient|trigger_build|run_command|编译|构建|运行/i.test(corpus)
  return hasFileRef || hasOpsRef
}
