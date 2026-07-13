export interface ParsedPlanStep {
  id: string
  description: string
  kind?: 'inspect' | 'write' | 'recipe'
  targetPath?: string
  evidence?: string
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

/** Prefer numbered lines; also accept fenced/raw JSON plan arrays. */
function tryParseJsonPlanLite(text: string): ParsedPlanStep[] {
  const candidates: string[] = []
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
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
      const steps: ParsedPlanStep[] = []
      for (let i = 0; i < list.length; i++) {
        const item = list[i] as {
          kind?: string
          description?: string
          title?: string
          targetPath?: string
          path?: string
          evidence?: string
        }
        if (!item || typeof item !== 'object') continue
        const description = String(item.description || item.title || '').trim()
        if (!description) continue
        const kindRaw = String(item.kind || '').toLowerCase()
        const kind = (['write', 'recipe', 'inspect'].includes(kindRaw)
          ? kindRaw
          : undefined) as ParsedPlanStep['kind']
        const targetPath = (item.targetPath || item.path || '').replace(/\\/g, '/') || undefined
        const evidence = item.evidence ? String(item.evidence).trim() : undefined
        steps.push({
          id: String(i + 1),
          description,
          ...(kind ? { kind } : {}),
          ...(targetPath ? { targetPath } : {}),
          ...(evidence ? { evidence } : {})
        })
      }
      if (steps.length > 0) return steps
    } catch {
      // next
    }
  }
  return []
}

export function planHasActionableSteps(text: string): boolean {
  if (parsePlanSteps(text).length >= 1) return true
  return tryParseJsonPlanLite(text).length >= 1
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

/** Whether plan text should proceed to execute phase (numbered or JSON plans). */
export function isActionablePlanText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/无法制定|暂无.*计划|等待用户提供|仅打招呼|无法输出.*计划|无法继续.*计划/i.test(trimmed)) {
    return false
  }
  const numbered = parsePlanSteps(trimmed)
  const jsonSteps = tryParseJsonPlanLite(trimmed)
  const steps = numbered.length > 0 ? numbered : jsonSteps
  if (steps.length === 0) return false
  const corpus = `${trimmed}\n${steps.map((s) => `${s.description} ${s.targetPath || ''} ${s.evidence || ''}`).join('\n')}`
  const hasFileRef = /\.(java|json|gradle|properties|toml)|src\/|gradle\/|data\//i.test(corpus)
  const hasOpsRef =
    isOpsOnlyPlan(steps) ||
    /gradlew|gradle\s|runClient|trigger_build|run_command|编译|构建|运行/i.test(corpus)
  const hasStructuredKind = steps.some((s) => Boolean(s.kind || s.targetPath))
  return hasFileRef || hasOpsRef || hasStructuredKind
}
