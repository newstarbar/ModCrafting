import type { ChronoEntry, DisplayMessage } from '../types/display-message'
import type { ChatMessage } from '../harness/chat-message'
import type { PlanStep } from '../components/TaskPlan'

const TOOL_OUTPUT_LIMIT = 48_000
const TOOL_ARGS_LIMIT = 16_000
const DIFF_CONTENT_LIMIT = 24_000
const CTRL_CONTENT_LIMIT = 24_000
const REASONING_LIMIT = 16_000

function escapeMd(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function fence(lang: string, body: string): string {
  const safe = body.replace(/\r\n/g, '\n')
  // avoid breaking fences if content contains ```
  const marker = safe.includes('```') ? '````' : '```'
  return `${marker}${lang}\n${safe}\n${marker}`
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n… [截断：原始 ${text.length} 字符，已保留前 ${limit}]`
}

function jsonBlock(value: unknown, limit = TOOL_ARGS_LIMIT): string {
  try {
    return fence('json', clip(JSON.stringify(value, null, 2), limit))
  } catch {
    return fence('text', clip(String(value), limit))
  }
}

function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
    case 'done':
      return '完成'
    case 'running':
      return '进行中'
    case 'error':
      return '失败'
    case 'pending':
      return '待办'
    default:
      return status
  }
}

function planStepsSection(steps: PlanStep[] | undefined, title: string): string[] {
  if (!steps?.length) return []
  const lines: string[] = [`### ${title}`, '']
  for (const step of steps) {
    const meta: string[] = [`#${step.id}`, statusLabel(step.status)]
    if ('kind' in step && step.kind) meta.push(String(step.kind))
    const path =
      ('targetPath' in step && step.targetPath) ||
      ('targetPaths' in step && step.targetPaths?.length ? step.targetPaths.join(', ') : '')
    if (path) meta.push(String(path))
    lines.push(`- **[${meta.join(' · ')}]** ${escapeMd(step.description || '')}`)
    if ('evidence' in step && step.evidence) {
      lines.push(`  - evidence: \`${escapeMd(String(step.evidence))}\``)
    }
  }
  lines.push('')
  return lines
}

function toolEntryToMarkdown(entry: Extract<ChronoEntry, { kind: 'tool' }>, index: number): string[] {
  const lines: string[] = []
  const dur = formatDuration(entry.durationMs)
  const titleBits = [
    entry.name || 'tool',
    statusLabel(entry.status),
    dur,
    entry.displayName && entry.displayName !== entry.name ? entry.displayName : '',
  ].filter(Boolean)
  lines.push(`#### 工具 #${index + 1} · ${titleBits.join(' · ')}`)
  lines.push('')
  if (entry.id) lines.push(`- toolCallId: \`${entry.id}\``)
  if (entry.startMs) lines.push(`- startMs: ${entry.startMs}`)
  if (entry.durationMs != null) lines.push(`- durationMs: ${entry.durationMs}`)
  lines.push('')

  if (entry.args && Object.keys(entry.args).length > 0) {
    lines.push('**参数**')
    lines.push('')
    lines.push(jsonBlock(entry.args))
    lines.push('')
  }

  const output = (entry.output || entry.liveOutput || '').trim()
  if (output) {
    lines.push('**输出**')
    lines.push('')
    lines.push(fence('text', clip(output, TOOL_OUTPUT_LIMIT)))
    lines.push('')
  }

  if (entry.fileDiff) {
    const d = entry.fileDiff
    lines.push('**文件变更**')
    lines.push('')
    lines.push(`- path: \`${d.path}\``)
    lines.push(`- action: ${d.action || 'update'}`)
    lines.push(`- +${d.added} / -${d.removed}`)
    if (d.firstAdded) lines.push(`- firstAdded: ${escapeMd(d.firstAdded)}`)
    if (d.firstRemoved) lines.push(`- firstRemoved: ${escapeMd(d.firstRemoved)}`)
    lines.push('')
    if (d.content) {
      lines.push('变更内容：')
      lines.push('')
      lines.push(fence('diff', clip(d.content, DIFF_CONTENT_LIMIT)))
      lines.push('')
    }
    if (d.oldContent) {
      lines.push('覆盖前旧内容：')
      lines.push('')
      lines.push(fence('text', clip(d.oldContent, DIFF_CONTENT_LIMIT)))
      lines.push('')
    }
  }

  if (!entry.args && !output && !entry.fileDiff) {
    lines.push('_（无参数/输出详情）_')
    lines.push('')
  }

  return lines
}

function entriesToMarkdown(entries: ChronoEntry[] | undefined, contentFallback?: string): string {
  if (!entries?.length) {
    return contentFallback?.trim() ? escapeMd(contentFallback.trim()) : '_（无内容）_'
  }
  const parts: string[] = []
  let toolIndex = 0
  for (const entry of entries) {
    if (entry.kind === 'text') {
      const t = entry.content.trim()
      if (t) parts.push(escapeMd(t))
    } else if (entry.kind === 'reasoning') {
      const t = entry.content.trim()
      if (t) {
        parts.push('### 推理过程')
        parts.push('')
        parts.push(fence('text', clip(t, REASONING_LIMIT)))
      }
    } else if (entry.kind === 'tool') {
      parts.push(...toolEntryToMarkdown(entry, toolIndex++))
    }
  }
  if (parts.length === 0) {
    return contentFallback?.trim() ? escapeMd(contentFallback.trim()) : '_（无内容）_'
  }
  return parts.join('\n')
}

function controllerAppendix(messages: ChatMessage[] | undefined): string[] {
  if (!messages?.length) return []
  const lines: string[] = [
    '---',
    '',
    '## 附录 · Controller API 消息快照',
    '',
    `_共 ${messages.length} 条（用于对照模型原始上下文；大字段已截断）_`,
    '',
  ]
  messages.forEach((m, i) => {
    const role = m.role || 'unknown'
    const name = m.name ? ` / ${m.name}` : ''
    const phase = m.phase ? ` · phase=${m.phase}` : ''
    const origin = m.origin ? ` · origin=${m.origin}` : ''
    lines.push(`### [${i + 1}] ${role}${name}${phase}${origin}`)
    lines.push('')
    if (m.tool_call_id) lines.push(`- tool_call_id: \`${m.tool_call_id}\``)
    if (m.taskId) lines.push(`- taskId: \`${m.taskId}\``)
    if (m.tool_calls?.length) {
      lines.push('- tool_calls:')
      lines.push('')
      lines.push(jsonBlock(m.tool_calls, TOOL_ARGS_LIMIT))
      lines.push('')
    }
    const content = (m.content || '').trim()
    if (content) {
      lines.push(fence('text', clip(content, CTRL_CONTENT_LIMIT)))
      lines.push('')
    } else if (!m.tool_calls?.length) {
      lines.push('_（空内容）_')
      lines.push('')
    }
  })
  return lines
}

export interface BuildSessionMarkdownOptions {
  messages: DisplayMessage[]
  sessionGoal?: string
  sessionName?: string
  exportedAt?: string
  projectPath?: string | null
  model?: string
  endpoint?: string
  providerId?: string
  composerMode?: string
  phase?: string
  activePlanSteps?: PlanStep[]
  controllerMessages?: ChatMessage[]
}

function maskEndpoint(endpoint?: string): string {
  if (!endpoint) return '（未知）'
  return endpoint.replace(/\/\/[^@/\s]+@/, '//***@')
}

/** 将会话导出为可供诊断的完整 Markdown 文档 */
export function buildSessionMarkdown(opts: BuildSessionMarkdownOptions): string {
  const exportedAt = opts.exportedAt ?? new Date().toISOString()
  const goal = opts.sessionGoal?.trim() || '（未设定）'
  const title = opts.sessionName?.trim() || 'ModCrafting 会话诊断导出'

  const failedTools: string[] = []
  let toolCount = 0
  for (const msg of opts.messages) {
    for (const e of msg.entries || []) {
      if (e.kind !== 'tool') continue
      toolCount++
      if (e.status === 'error') {
        const path =
          e.fileDiff?.path ||
          (typeof e.args?.path === 'string' ? e.args.path : '')
        failedTools.push(`${e.name || 'tool'}${path ? `: ${path}` : ''}`)
      }
    }
  }

  const lines: string[] = [
    `# ${title}`,
    '',
    '## 元数据',
    '',
    `- 导出时间：${exportedAt}`,
    `- 项目路径：${opts.projectPath || '（未知）'}`,
    `- 会话目标：${goal}`,
    `- 消息数：${opts.messages.length}`,
    `- 工具调用数：${toolCount}`,
    `- 失败工具数：${failedTools.length}`,
    `- 模型：${opts.model || '（未知）'}`,
    `- Provider：${opts.providerId || '（未知）'}`,
    `- Endpoint：${maskEndpoint(opts.endpoint)}`,
    `- Composer 模式：${opts.composerMode || '（未知）'}`,
    `- Phase：${opts.phase || '（未知）'}`,
    '',
  ]

  if (failedTools.length) {
    lines.push('### 失败工具一览')
    lines.push('')
    for (const item of failedTools) lines.push(`- ${escapeMd(item)}`)
    lines.push('')
  }

  lines.push(...planStepsSection(opts.activePlanSteps, '当前实施计划（完整步骤）'))

  lines.push('---', '', '## 对话时间线', '')

  let turn = 0
  for (const msg of opts.messages) {
    if (msg.role === 'user') {
      turn += 1
      lines.push(`## 第 ${turn} 轮 · 用户`)
      lines.push('')
      lines.push(`- messageId: \`${msg.id}\``)
      lines.push(`- timestamp: ${msg.timestamp ? new Date(msg.timestamp).toISOString() : '（无）'}`)
      lines.push('')
      lines.push(escapeMd(msg.content?.trim() || '_（无内容）_'))
      lines.push('')
      if (msg.stateSnapshot) {
        const snap = msg.stateSnapshot
        lines.push('<details>')
        lines.push('<summary>用户消息 stateSnapshot（回滚快照摘要）</summary>')
        lines.push('')
        lines.push(`- phase: ${snap.phase}`)
        lines.push(`- composerMode: ${snap.composerMode}`)
        lines.push(`- sessionGoal: ${snap.sessionGoal || '（空）'}`)
        lines.push(`- messageIndex: ${snap.messageIndex}`)
        lines.push(`- controllerMessages: ${snap.controllerMessages?.length ?? 0}`)
        lines.push(`- fileSnapshots: ${snap.fileSnapshots?.length ?? 0}`)
        if (snap.planTrackerSteps?.length) {
          lines.push('')
          lines.push(...planStepsSection(snap.planTrackerSteps, '快照内计划步骤'))
        }
        if (snap.fileSnapshots?.length) {
          lines.push('文件快照路径：')
          for (const fs of snap.fileSnapshots) {
            lines.push(`- \`${fs.path}\` @ ${new Date(fs.timestamp).toISOString()} (${fs.content.length} chars)`)
          }
          lines.push('')
        }
        lines.push('</details>')
        lines.push('')
      }
      continue
    }

    // assistant
    if (turn === 0) turn = 1
    lines.push(`## 第 ${turn} 轮 · 助手`)
    lines.push('')
    lines.push(`- messageId: \`${msg.id}\``)
    lines.push(`- timestamp: ${msg.timestamp ? new Date(msg.timestamp).toISOString() : '（无）'}`)
    if (msg.turnStatus) lines.push(`- turnStatus: \`${msg.turnStatus}\``)
    lines.push('')

    if (msg.embeddedPlan?.length) {
      lines.push(...planStepsSection(msg.embeddedPlan, '本轮嵌入计划步骤'))
    }

    lines.push(entriesToMarkdown(msg.entries, msg.content))
    lines.push('')
  }

  lines.push(...controllerAppendix(opts.controllerMessages))

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function defaultSessionExportFileName(prefix = 'mc-session'): string {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  return `${prefix}-${ts}.md`
}
