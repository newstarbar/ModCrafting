export interface ParsedPlanStep {
  id: string
  description: string
}

export const OPS_STEP_PATTERN = /gradlew|gradle\s|runClient|trigger_build|run_command|编译|构建|运行|build/i

/** Upper bound on plan steps to guard against runaway/verbose plans */
export const MAX_PLAN_STEPS = 10

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
