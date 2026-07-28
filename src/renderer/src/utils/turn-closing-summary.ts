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
const CLOSING_MARKERS_RE = /^(本轮已停止|本轮异常结束|本轮部分完成|本轮任务已完成|## 任务总结分析|本轮已结束)/

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

function hasClosingSummaryText(entries: ChronoEntry[]): boolean {
  return entries.some((e) => {
    if (e.kind !== 'text') return false
    return CLOSING_MARKERS_RE.test(e.content.trim())
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
    const parts: string[] = []
    const verifySteps = opts.steps?.filter(s =>
      /验证|测试|screenshot|inspect|截图/i.test(s.description)
    ) || []
    if (verifySteps.length > 0) {
      parts.push('## 任务总结分析')
      parts.push(`已完成 ${opts.steps?.length || 0} 个步骤，其中 ${verifySteps.length} 个验证步骤。`)
      if (goal) {
        parts.push(`目标「${goal}」已落实。`)
      }
      parts.push('请参考下方测试截图确认功能效果。')
    } else {
      parts.push('本轮任务已完成。')
      if (progress) parts.push(`${progress}。`)
      else if (opts.steps?.length) parts.push(`共完成 ${opts.steps.length} 个步骤。`)
      if (goal) parts.push(`目标「${goal}」已落实。`)
    }
    return parts.join('')
  }

  if (opts.reason === 'partial') {
    const parts = ['本轮部分完成。']
    if (errorText && !/cancel/i.test(errorText)) {
      parts.push(`原因：${errorText.slice(0, 200)}。`)
    }
    // 附加失败步骤详情，帮助用户/AI 定位问题
    const failedStep = opts.steps?.find(s => s.status === 'error')
    if (failedStep) {
      parts.push(`失败步骤：${failedStep.description}。`)
    }
    if (progress) parts.push(`${progress}。`)
    if (goal) parts.push(`目标：${goal}。`)
    parts.push('发送新消息可继续推进。')
    return parts.join('')
  }

  // answered / chat
  if (progress) return `本轮已结束。${progress}。`
  return '本轮已结束。'
}

function lastToolFailureReason(entries: ChronoEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind !== 'tool') continue
    const out = String(e.output || '').trim()
    const failed = e.status === 'error' || /^\s*Error:/i.test(out)
    if (!failed) continue
    const firstLine = out.split('\n').map((l) => l.trim()).find(Boolean) || ''
    const name = e.name || 'tool'
    if (firstLine) return `${name}: ${firstLine.slice(0, 160)}`
    return `${name} 失败`
  }
  return undefined
}

/**
 * 追加收尾总结：
 * - error / cancelled / partial：始终追加（即使已有旁白）
 * - completed：若尚无「任务总结」类收尾则追加
 * - 其它：仅在缺少可读正文时追加
 */
export function ensureClosingSummaryEntry(
  entries: ChronoEntry[],
  opts: BuildClosingSummaryOptions
): ChronoEntry[] {
  const forceAppend =
    opts.reason === 'error'
    || opts.reason === 'cancelled'
    || opts.reason === 'partial'

  const enriched: BuildClosingSummaryOptions = { ...opts }
  if ((forceAppend || opts.reason === 'error') && !enriched.error) {
    const fromTools = lastToolFailureReason(entries)
    if (fromTools) enriched.error = fromTools
  }

  if (forceAppend) {
    // Always append a fresh closing for abnormal / partial ends (even if an older marker exists).
    const summary = buildTurnClosingSummary(enriched)
    if (!summary.trim()) return entries
    if (hasClosingSummaryText(entries)) {
      // Replace trailing closing marker with richer one if we now have a reason
      const withoutOld = entries.filter((e) => !(e.kind === 'text' && CLOSING_MARKERS_RE.test(e.content.trim())))
      return [...withoutOld, { kind: 'text', content: summary }]
    }
    return [...entries, { kind: 'text', content: summary }]
  }

  if (opts.reason === 'completed') {
    if (hasClosingSummaryText(entries)) return entries
    const summary = buildTurnClosingSummary(enriched)
    if (!summary.trim()) return entries
    return [...entries, { kind: 'text', content: summary }]
  }

  if (hasReadableClosingText(entries)) {
    if (opts.reason === 'planned') {
      const hasPlanPlaceholder = entries.some(
        (e) => e.kind === 'text' && PLAN_PLACEHOLDER_RE.test(e.content.trim())
      )
      if (hasPlanPlaceholder || hasReadableClosingText(entries)) return entries
    }
    return entries
  }
  const summary = buildTurnClosingSummary(enriched)
  if (!summary.trim()) return entries
  return [...entries, { kind: 'text', content: summary }]
}
