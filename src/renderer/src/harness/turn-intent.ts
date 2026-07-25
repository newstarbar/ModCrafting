import type { PlanTracker } from './plan-tracker.ts'
import type { ChatContentPart } from './chat-message.ts'
import { contentAsText } from './chat-message.ts'

export type TurnIntent = 'chat' | 'resume' | 'develop' | 'plan_only'

export type ComposerMode = 'agent' | 'plan' | 'ask'

export interface TurnIntentContext {
  phase: 'plan' | 'execute'
  planTracker: PlanTracker | null
  hasProject: boolean
  composerMode: ComposerMode
  /** Plan text accepted/parsed but not yet attached as planTracker (e.g. after plan_failed). */
  hasPlanCandidate?: boolean
}

/** Extremely narrow resume command — structural fallback only (not a Chinese keyword bag). */
const NARROW_RESUME_PATTERN =
  /^(继续|接着|往下|continue|执行计划|开始执行|执行)[\s!！。.?？~，,]*$/i

export function isNarrowResumeInput(input: string): boolean {
  return NARROW_RESUME_PATTERN.test(input.trim())
}

/** @deprecated Use isNarrowResumeInput — kept for session-resume tests / callers. */
export function isResumeInput(input: string): boolean {
  return isNarrowResumeInput(input)
}

/**
 * Structural crash / build failure detection (format-based, not Chinese word bags).
 * Used as safety gate when LLM classification fails or mislabels.
 */
export function isStructuralErrorReport(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  if (
    /Crash Report|----\s*Minecraft Crash Report\s*----|Exception in thread|java\.lang\.\w*Exception|at\s+knot\/\/|BUILD FAILED|Compilation failed|\.java:\d+|Caused by:/i.test(
      trimmed
    )
  ) {
    return true
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length >= 4) {
    const stackish = lines.filter((l) => /^\s*at\s+\S+/.test(l) || /Exception|Error/.test(l)).length
    if (stackish >= 2) return true
  }
  return false
}

/** @deprecated Prefer classifyUserTurn / isStructuralErrorReport */
export function isErrorReportInput(input: string): boolean {
  return isStructuralErrorReport(input)
}

const CODE_EXPLAIN_PATTERN = /---\s*代码解释\s*---/i

export function isCodeExplainInput(input: string): boolean {
  return CODE_EXPLAIN_PATTERN.test(input)
}

export function buildUserSymptomBlock(symptom: string | null | undefined): string {
  const text = (symptom || '').trim()
  if (!text) return ''
  return (
    `【用户待验证症状】${text.slice(0, 400)}\n` +
    `硬约束：trigger_build runClient 出现 MC_PHASE:ready 仅表示游戏启动成功，不代表该症状已修复。` +
    `ready 后必须调用 mc_inspect 或 mc_screenshot（必要时 mc_inventory / mc_world / mc_command）做客观校验。` +
    `写码步骤必须针对该症状做可验证修改（禁止只加注释/空改）；若 build 全 UP-TO-DATE，说明改动未进入编译，须核对路径（main/client）与 edit_file 是否落盘。` +
    `完成后用一两句说明改了哪一处，由用户确认是否解决。`
  )
}

/** Keep recent user feedback + short assistant notes when starting a follow-up task. */
export function buildCrossTurnDiagnosisRetain(args: {
  system?: { role: 'system'; content: string | ChatContentPart[]; origin?: string }
  messages: Array<{ role: string; content?: string | ChatContentPart[]; origin?: string }>
  taskId: string
  maxPriorUsers?: number
  maxAssistantNotes?: number
}): Array<{ role: string; content: string | ChatContentPart[]; origin?: string; taskId?: string }> {
  const maxUsers = args.maxPriorUsers ?? 5
  const maxAssistants = args.maxAssistantNotes ?? 2
  const priorUsers = args.messages
    .filter((m) => m.role === 'user' && m.origin !== 'harness')
    .map((m) => contentAsText(m.content).trim())
    .filter(Boolean)
    .slice(-maxUsers)
  const currentUser = [...args.messages].reverse().find((m) => m.role === 'user' && m.origin !== 'harness')
  const assistantNotes = args.messages
    .filter((m) => m.role === 'assistant' && contentAsText(m.content).trim().length > 20)
    .map((m) => contentAsText(m.content).trim().slice(0, 1200))
    .slice(-maxAssistants)

  const out: Array<{ role: string; content: string | ChatContentPart[]; origin?: string; taskId?: string }> = []
  if (args.system) {
    out.push({ role: 'system', content: args.system.content, origin: 'harness' })
  }
  if (priorUsers.length > 0) {
    out.push({
      role: 'user',
      origin: 'harness',
      content:
        `【跨轮诊断摘要】用户近期反馈（必须保留，禁止遗忘）：\n` +
        priorUsers.map((s, i) => `${i + 1}. ${s.slice(0, 240)}`).join('\n') +
        `\n请针对最新用户消息修复；不要重复已尝试且无效的方案。`
    })
  }
  for (const note of assistantNotes) {
    out.push({ role: 'assistant', content: note, origin: 'assistant', taskId: args.taskId })
  }
  if (currentUser) {
    // Preserve multimodal content (image parts) — do not coerce to text.
    out.push({
      role: 'user',
      content: currentUser.content ?? '',
      origin: 'user',
      taskId: args.taskId
    })
  }
  return out
}

export function buildSessionGoalBlock(sessionGoal: string): string {
  const goal = sessionGoal.trim()
  return `## 当前会话目标\n${goal || '（未设置）'}\n本轮用户消息应服务于上述目标；若与目标无关，先简短确认再行动。`
}
