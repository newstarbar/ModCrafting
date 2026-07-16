import type { ChronoEntry } from '../types/display-message'

export type ClosingReason = 'completed' | 'partial' | 'cancelled' | 'error' | 'planned' | 'answered'

export interface PlanStepLike {
  id: string
  description: string
  status: string
}

export interface BuildClosingSummaryOptions {
  reason: ClosingReason
  steps?: PlanStepLike[]
  sessionGoal?: string
  error?: string
}

const NUMBERED_LINE_RE = /^\s*\d+[.\、\s]+/
const PLAN_PLACEHOLDER_RE = /^已制定实施计划/

function isNumberedPlanText(content: string): boolean {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  const numbered = lines.filter((l) => NUMBERED_LINE_RE.test(l))
  return numbered.length >= 2 || (numbered.length === 1 && lines.length === 1)
}

function progressPhrase(steps?: PlanStepLike[]): string | null {
  if (!steps?.length) return null
  const done = steps.filter((s) => s.status === 'completed').length
  const total = steps.length
  const running = steps.find((s) => s.status === 'running')
  const pending = steps.find((s) => s.status === 'pending')
  const failed = steps.find((s) => s.status === 'error')
  if (done === total) return `计划进度 ${done}/${total}，全部完成`
  if (failed) return `计划进度 ${done}/${total}，步骤 #${failed.id} 失败`
  if (running) return `计划进度 ${done}/${total}，停在步骤 #${running.id}`
  if (pending) return `计划进度 ${done}/${total}，下一步为 #${pending.id}`
  return `计划进度 ${done}/${total}`
}

/** 气泡中是否已有可读的收尾正文（排除编号计划列表） */
export function hasReadableClosingText(entries: ChronoEntry[]): boolean {
  return entries.some((e) => {
    if (e.kind !== 'text') return false
    const t = e.content.trim()
    if (!t) return false
    if (isNumberedPlanText(t)) return false
    return true
  })
}

/** 主机侧收尾总结（1～3 句），用于正常结束缺少正文或取消/异常时兜底 */
export function buildTurnClosingSummary(opts: BuildClosingSummaryOptions): string {
  const goal = opts.sessionGoal?.trim()
  const progress = progressPhrase(opts.steps)
  const errorText = opts.error?.trim()
  const isCancel = opts.reason === 'cancelled' || (errorText != null && /cancel/i.test(errorText))

  if (opts.reason === 'planned') {
    const n = opts.steps?.length ?? 0
    if (n > 0) {
      return `已制定实施计划（${n} 步），请确认后开始执行。`
    }
    return '计划已就绪，请确认后开始执行。'
  }

  if (isCancel || opts.reason === 'cancelled') {
    const parts = ['本轮已停止。']
    if (progress) parts.push(`${progress}。`)
    if (goal) parts.push(`当前目标：${goal}。`)
    parts.push('发送新消息可继续。')
    return parts.join('')
  }

  if (opts.reason === 'error') {
    const parts = ['本轮异常结束。']
    if (errorText && !/cancel/i.test(errorText)) {
      parts.push(`原因：${errorText.slice(0, 200)}。`)
    }
    if (progress) parts.push(`${progress}。`)
    parts.push('可重试本轮或发送新消息继续。')
    return parts.join('')
  }

  if (opts.reason === 'completed') {
    const parts = ['本轮任务已完成。']
    if (progress) parts.push(`${progress}。`)
    else if (opts.steps?.length) parts.push(`共完成 ${opts.steps.length} 个步骤。`)
    if (goal) parts.push(`目标「${goal}」已落实。`)
    return parts.join('')
  }

  if (opts.reason === 'partial') {
    const parts = ['本轮部分完成。']
    if (progress) parts.push(`${progress}。`)
    if (goal) parts.push(`目标：${goal}。`)
    parts.push('发送新消息可继续推进。')
    return parts.join('')
  }

  // answered / chat
  if (progress) return `本轮已结束。${progress}。`
  return '本轮已结束。'
}

/** 若缺少可读正文则追加总结；已有正文则原样返回 */
export function ensureClosingSummaryEntry(
  entries: ChronoEntry[],
  opts: BuildClosingSummaryOptions
): ChronoEntry[] {
  if (hasReadableClosingText(entries)) {
    // plan_ready 路径可能已有计划占位，对 planned 视为足够
    if (opts.reason === 'planned') {
      const hasPlanPlaceholder = entries.some(
        (e) => e.kind === 'text' && PLAN_PLACEHOLDER_RE.test(e.content.trim())
      )
      if (hasPlanPlaceholder || hasReadableClosingText(entries)) return entries
    }
    return entries
  }
  const summary = buildTurnClosingSummary(opts)
  if (!summary.trim()) return entries
  return [...entries, { kind: 'text', content: summary }]
}
