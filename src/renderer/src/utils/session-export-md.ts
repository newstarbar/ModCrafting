import type { ChronoEntry, DisplayMessage } from '../types/display-message'

function escapeMd(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function toolLine(entry: Extract<ChronoEntry, { kind: 'tool' }>): string {
  const name = entry.name || 'tool'
  const pathHint =
    entry.fileDiff?.path ||
    (typeof entry.args === 'object' && entry.args && 'path' in entry.args
      ? String((entry.args as { path?: unknown }).path ?? '')
      : '')
  const status = entry.status === 'error' ? '失败' : entry.status === 'running' ? '进行中' : '完成'
  if (pathHint) return `- \`${name}: ${pathHint}\`（${status}）`
  return `- \`${name}\`（${status}）`
}

function entriesToMarkdown(entries: ChronoEntry[] | undefined, contentFallback?: string): string {
  if (!entries?.length) {
    return contentFallback?.trim() ? escapeMd(contentFallback.trim()) : '_（无内容）_'
  }
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'text') {
      const t = entry.content.trim()
      if (t) parts.push(escapeMd(t))
    } else if (entry.kind === 'tool') {
      parts.push(toolLine(entry))
    } else if (entry.kind === 'reasoning') {
      // skip CoT in export
    }
  }
  if (parts.length === 0) {
    return contentFallback?.trim() ? escapeMd(contentFallback.trim()) : '_（无内容）_'
  }
  return parts.join('\n\n')
}

export interface BuildSessionMarkdownOptions {
  messages: DisplayMessage[]
  sessionGoal?: string
  sessionName?: string
  exportedAt?: string
}

/** 将会话展示消息导出为单个 Markdown 文档 */
export function buildSessionMarkdown(opts: BuildSessionMarkdownOptions): string {
  const exportedAt = opts.exportedAt ?? new Date().toISOString()
  const goal = opts.sessionGoal?.trim() || '（未设定）'
  const title = opts.sessionName?.trim() || 'ModCrafting 会话导出'

  const lines: string[] = [
    `# ${title}`,
    '',
    `- 导出时间：${exportedAt}`,
    `- 会话目标：${goal}`,
    `- 消息数：${opts.messages.length}`,
    '',
    '---',
    '',
  ]

  let turn = 0
  for (const msg of opts.messages) {
    if (msg.role === 'system') {
      lines.push('### 系统')
      lines.push('')
      lines.push(escapeMd(msg.content?.trim() || '_（无内容）_'))
      lines.push('')
      continue
    }
    if (msg.role === 'user') {
      turn += 1
      lines.push(`## 第 ${turn} 轮 · 用户`)
      lines.push('')
      lines.push(escapeMd(msg.content?.trim() || '_（无内容）_'))
      lines.push('')
      continue
    }
    // assistant
    if (turn === 0) turn = 1
    lines.push(`## 第 ${turn} 轮 · 助手`)
    lines.push('')
    if (msg.turnStatus) {
      lines.push(`_状态：${msg.turnStatus}_`)
      lines.push('')
    }
    if (msg.embeddedPlan?.length) {
      const done = msg.embeddedPlan.filter((s) => s.status === 'completed').length
      lines.push(`_实施计划进度：${done}/${msg.embeddedPlan.length}_`)
      lines.push('')
    }
    lines.push(entriesToMarkdown(msg.entries, msg.content))
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function defaultSessionExportFileName(prefix = 'mc-session'): string {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  return `${prefix}-${ts}.md`
}
