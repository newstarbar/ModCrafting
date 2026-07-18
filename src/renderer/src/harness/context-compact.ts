// Context compaction — prevents context-window overflow by
// replacing old tool results with placeholders (micro-compact)
// and triggering LLM summarization when token budget is low (auto-compact).
//
// Three-zone layout:
//   [Pinned Prefix]  [Compressed History]  [Raw Recent Window]
//   system prompt    micro-placeholders    last RECENT_WINDOW messages
//                    or LLM summary

import type { ChatMessage, ChatToolCall } from './chat-message'

// ── Thresholds ──

/** Messages within this window are never compacted. */
export const RECENT_WINDOW = 6

/** Tool results older than this many assistant turns are eligible for micro-compaction. */
const MICRO_COMPACT_AGE = 3

/** Soft floor: tool outputs below this estimated size stay raw. */
const MICRO_TOOL_MIN_TOKENS = 120

/** Soft floor: tool_call arguments below this stay raw. */
const MICRO_ARGS_MIN_CHARS = 400

/**
 * Auto-compact trigger as a fraction of the *effective* working window
 * (capped at DEFAULT_CONTEXT_WINDOW so 1M models still compact early).
 */
export const COMPACT_FRACTION = 0.5

/** Cap used for compaction triggers regardless of vendor 1M marketing windows. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Warn UI when estimated tokens exceed this fraction of the effective window. */
export const WARN_FRACTION = 0.8

// ── Token estimation ──
// Rough heuristic for context compaction triggers only — NOT for billing.
// Cost uses API-reported usage tokens × model pricing. DeepSeek offline
// tokenizer (transformers + tokenizer.json) is for pre-flight local counts.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content || '')
    if (m.tool_calls) {
      total += estimateTokens(JSON.stringify(m.tool_calls))
    }
    if (m.tool_call_id) total += estimateTokens(m.tool_call_id)
    total += 4 // role + overhead per message
  }
  return total
}

/** Working window for compaction: min(model claim, 128k). */
export function effectiveContextWindow(modelContextWindow?: number): number {
  const claimed = modelContextWindow && modelContextWindow > 0
    ? modelContextWindow
    : DEFAULT_CONTEXT_WINDOW
  return Math.min(claimed, DEFAULT_CONTEXT_WINDOW)
}

export function compactThreshold(modelContextWindow?: number, fraction = COMPACT_FRACTION): number {
  return Math.floor(effectiveContextWindow(modelContextWindow) * fraction)
}

export function warnTokenThreshold(modelContextWindow?: number): number {
  return Math.floor(effectiveContextWindow(modelContextWindow) * WARN_FRACTION)
}

// ── Micro-compaction ──

/**
 * Summarize a tool result into a short placeholder.
 * Preserves the tool name and exit status so the model still knows what happened.
 */
function compactToolResult(name: string, output: string): string {
  const size = estimateTokens(output)
  if (size < MICRO_TOOL_MIN_TOKENS) return output // too small to bother

  const lines = output.trim().split('\n')
  const lastLine = lines[lines.length - 1]?.trim() || ''

  // Extract exit code
  const exitMatch = lastLine.match(/\[exit code: (-?\d+)\]|\[退出码: (-?\d+)\]/)
  const exitCode = exitMatch?.[1] ?? exitMatch?.[2]

  // Extract build result
  const hasSuccess = output.includes('BUILD SUCCESSFUL')
  const hasFailed = output.includes('BUILD FAILED')

  let summary = ''
  if (name === 'trigger_build' || name === 'run_command') {
    if (hasSuccess) summary = '构建成功'
    else if (hasFailed) summary = '构建失败'
    else summary = '已执行'
    if (exitCode != null) summary += ` (exit ${exitCode})`
  } else if (name === 'read_file') {
    const firstLine = lines.find((l) => l.trim().length > 0)?.trim().slice(0, 80) || ''
    summary = firstLine ? `读取: ${firstLine}` : '读取文件'
  } else if (name === 'list_directory') {
    const count = lines.filter((l) => l.trim()).length
    summary = `${count} 个条目`
  } else if (name === 'grep') {
    const firstLine = lines.find((l) => l.trim().length > 0)?.trim().slice(0, 80) || ''
    summary = firstLine || '搜索完成'
  } else {
    const firstLine = lines.find((l) => l.trim().length > 0)?.trim().slice(0, 60) || ''
    summary = firstLine || output.trim().slice(0, 60)
  }

  return `[已压缩: ${name} — ${summary} — 原始 ${size} tokens]`
}

function pathHintFromArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; targetPath?: unknown }
    const path = typeof parsed.path === 'string'
      ? parsed.path
      : typeof parsed.targetPath === 'string'
        ? parsed.targetPath
        : ''
    return path ? ` path=${path}` : ''
  } catch {
    const m = raw.match(/"path"\s*:\s*"([^"]{1,120})"/)
    return m ? ` path=${m[1]}` : ''
  }
}

/** Shrink oversized tool_call arguments (write_file / edit_file payloads). */
export function compactToolCallArguments(call: ChatToolCall): ChatToolCall {
  const raw = call.function?.arguments || ''
  if (raw.length < MICRO_ARGS_MIN_CHARS) return call
  const name = call.function?.name || 'unknown'
  const hint = pathHintFromArgs(raw)
  const placeholder = JSON.stringify({
    _compacted: true,
    tool: name,
    note: `arguments truncated (${raw.length} chars)${hint}`
  })
  return {
    ...call,
    function: {
      name,
      arguments: placeholder
    }
  }
}

/**
 * Replace tool results older than MICRO_COMPACT_AGE assistant turns with
 * compact placeholders. Also shrink aged assistant tool_call arguments.
 * Never touches the most recent RECENT_WINDOW messages.
 */
export function microCompact(
  messages: ChatMessage[],
  _assistantTurnCount: number
): ChatMessage[] {
  if (messages.length <= RECENT_WINDOW) return messages

  const compacted = [...messages]
  const recentStart = Math.max(0, messages.length - RECENT_WINDOW)

  let assistantTurnsSeen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i >= recentStart) {
      // In recent window — count assistant turns but don't compact
      if (messages[i].role === 'assistant') assistantTurnsSeen++
      continue
    }

    if (messages[i].role === 'assistant') {
      const age = assistantTurnsSeen
      if (age >= MICRO_COMPACT_AGE && messages[i].tool_calls?.length) {
        compacted[i] = {
          ...messages[i],
          tool_calls: messages[i].tool_calls!.map(compactToolCallArguments)
        }
      }
      assistantTurnsSeen++
      continue
    }

    if (messages[i].role === 'tool') {
      // Age is derived from the actual message positions. A per-run counter is
      // reset between turns and previously made old session results immortal.
      const age = assistantTurnsSeen
      if (age >= MICRO_COMPACT_AGE) {
        const name = messages[i].name || 'unknown'
        compacted[i] = {
          role: 'tool',
          content: compactToolResult(name, messages[i].content || ''),
          tool_call_id: messages[i].tool_call_id,
          name
        }
      }
    }
  }

  return compacted
}

// ── Auto-compaction ──

const SUMMARIZE_SYSTEM_PROMPT = `你是一个上下文压缩器。你需要将以下对话历史压缩为一段简洁的结构化摘要。

保留以下关键信息：
- 用户的原始需求/任务
- 当前项目状态（已创建/修改了哪些文件）
- 构建/测试的结果（成功/失败，原因）
- 当前计划的进度（哪些步骤已完成，哪些待做）
- 重要的技术决策和注意事项
- 最近的错误及其修复方案

丢弃：
- 详细的代码内容（代码已在文件中，无需重复）
- 逐步的思考过程
- 重复的工具调用和结果
- 探索性读取的内容

输出格式：
## 任务
[用户原始需求，一句话]

## 项目状态
- 文件清单
- 构建结果

## 计划进度
- [完成] 步骤1
- [进行中] 步骤2
- [待做] 步骤3

## 关键决策/注意事项
- 技术选型和原因
- 遇到的问题和修复

## 当前状态
[Agent 当前正在做什么]`

/**
 * Build messages for the summarization call — send the full history
 * with a compact instruction.
 */
function buildSummarizeMessages(messages: ChatMessage[]): ChatMessage[] {
  // Find the system message to extract the original task context
  const userMsgs = messages.filter((m) => m.role === 'user')
  const firstUserMsg = userMsgs.length > 0 ? userMsgs[0].content : '(无)'

  return [
    { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
    { role: 'user', content: `原始任务: ${firstUserMsg.slice(0, 200)}\n\n请将以下对话历史压缩为结构化摘要:\n\n${messages.map((m) => {
      if (m.role === 'tool') {
        const name = m.name || 'tool'
        return `[${name}]: ${(m.content || '').slice(0, 300)}`
      }
      if (m.role === 'assistant' && m.tool_calls) {
        const names = m.tool_calls.map((tc) => tc.function.name).join(', ')
        return `[assistant → 调用: ${names}]`
      }
      return `[${m.role}]: ${(m.content || '').slice(0, 200)}`
    }).join('\n')}` }
  ]
}

export interface CompactionResult {
  summary: string
  tokenCount: { before: number; after: number }
  savedTranscript: ChatMessage[]
}

/**
 * Perform auto-compaction: ask the LLM to summarize the conversation,
 * save the full transcript, return a replacement summary message.
 */
export async function autoCompact(
  messages: ChatMessage[],
  modelCall: (msgs: ChatMessage[], tools: any[], onChunk: (t: string) => void) => Promise<{ text: string }>
): Promise<CompactionResult> {
  const before = estimatePromptTokens(messages)
  const summarizeMsgs = buildSummarizeMessages(messages)

  let summary = ''
  const result = await modelCall(summarizeMsgs, [], (_text) => {})
  summary = result.text || ''

  if (!summary.trim()) {
    // Fallback: manual compact
    summary = `[对话上下文过长，已自动压缩。原始 ${messages.length} 条消息，${before} tokens。请根据文件系统中的实际代码继续工作。]`
  }

  // Build the replacement: summary replaces all but the RECENT_WINDOW
  const recent = messages.slice(-RECENT_WINDOW)
  const sysMsg = messages.find((m) => m.role === 'system')
  const after = estimatePromptTokens([
    ...(sysMsg ? [sysMsg] : []),
    { role: 'system', content: `## 对话历史摘要\n${summary}` },
    ...recent
  ])

  return {
    summary,
    tokenCount: { before, after },
    savedTranscript: [...messages]
  }
}

// ── Main compaction entry point ──

export interface CompactConfig {
  contextWindow?: number
  compactFraction?: number
}

/**
 * Prepare messages for the API call. Applies micro-compaction and
 * triggers auto-compaction if the token budget is low.
 */
export async function prepareMessages(
  messages: ChatMessage[],
  assistantTurnCount: number,
  config: CompactConfig,
  modelCall: (msgs: ChatMessage[], tools: any[], onChunk: (t: string) => void) => Promise<{ text: string }>,
  onCompact?: (result: CompactionResult) => void
): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
  const threshold = compactThreshold(config.contextWindow, config.compactFraction || COMPACT_FRACTION)

  // Step 1: Always apply micro-compaction
  const prepared = microCompact(messages, assistantTurnCount)

  // Step 2: Check if auto-compaction is needed
  const estimated = estimatePromptTokens(prepared)
  if (estimated <= threshold) {
    return { messages: prepared, compacted: false }
  }

  // Step 3: Auto-compact
  const sysIdx = prepared.findIndex((m) => m.role === 'system')
  const nonSystem = sysIdx >= 0 ? prepared.slice(sysIdx + 1) : prepared
  const recent = nonSystem.slice(-RECENT_WINDOW)
  const oldMessages = sysIdx >= 0
    ? [prepared[sysIdx], ...nonSystem.slice(0, -RECENT_WINDOW)]
    : nonSystem.slice(0, -RECENT_WINDOW)

  const result = await autoCompact(oldMessages, modelCall)
  onCompact?.(result)

  // Build compacted message list
  const sysMsg = prepared.find((m) => m.role === 'system')
  const compacted: ChatMessage[] = []
  if (sysMsg) compacted.push(sysMsg)
  compacted.push({
    role: 'system',
    content:
      `## 上下文摘要\n${result.summary}\n\n` +
      `（完整对话已保存，共 ${result.tokenCount.before} tokens → ${result.tokenCount.after} tokens）`
  })
  compacted.push(...recent)

  return { messages: compacted, compacted: true }
}
