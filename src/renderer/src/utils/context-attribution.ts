import type { ChatMessage, ChatContentPart } from '../harness/chat-message.ts'
import { stableTextHash, normalizeDiagnosticMessage } from '../../../shared/harness-diagnostics.ts'

/**
 * Context-window attribution.
 *
 * The status bar already shows a single percentage from API-reported prompt
 * tokens, which hides the real problem on 1M-window models: a session can sit
 * at 2% while a quarter of it is the assistant echoing a tool result back as
 * its own text. This module splits the visible message list into categories
 * and quantifies duplication.
 */

export type ContextCategory =
  | 'systemPrompt'
  | 'harnessInjected'
  | 'user'
  | 'toolResult'
  | 'assistantText'
  | 'assistantToolArgs'
  | 'imageParts'
  | 'unaccounted'

export interface ContextSlice {
  category: ContextCategory
  tokens: number
  bytes: number
  share: number
}

export interface ContextToolAggregate {
  name: string
  tokens: number
  bytes: number
  count: number
}

export interface ContextTopMessage {
  index: number
  role: string
  name?: string
  category: ContextCategory
  tokens: number
  bytes: number
  preview: string
}

export interface ContextDuplicateGroup {
  fingerprint: string
  count: number
  wastedTokens: number
  wastedBytes: number
  roles: string[]
  sample: string
  exact: boolean
}

export interface ContextAttribution {
  anchored: boolean
  estimated: boolean
  promptTokens: number
  windowTokens: number
  percent: number
  measuredTokens: number
  unaccountedTokens: number
  unaccountedShare: number
  categories: ContextSlice[]
  byTool: ContextToolAggregate[]
  topMessages: ContextTopMessage[]
  duplicates: ContextDuplicateGroup[]
  duplicateWasteTokens: number
  duplicateShare: number
  messageCount: number
  computedAt: number
}

export interface ContextAttributionFrame {
  computedAt: number
  phase?: string
  promptTokens: number
  percent: number
  categories: Array<{ category: ContextCategory; tokens: number; share: number }>
  duplicateShare: number
  anchored: boolean
}

export const CONTEXT_HISTORY_LIMIT = 60
export const CONTEXT_ATTRIBUTION_ENABLED = true
export const CONTEXT_DUPLICATE_WARN_SHARE = 0.15
export const CONTEXT_TOP_LIMIT = 10

/** Providers bill image parts as a large fixed token block; base64 must never be length-estimated. */
export const IMAGE_PART_TOKEN_ESTIMATE = 1024

/**
 * Providers tokenize CJK at roughly one token per character, while the
 * `len / 4` heuristic in context-compact.ts (documented as compaction-only)
 * under-counts Chinese by ~4x. Attribution must not inherit that bias or the
 * `unaccounted` residual swallows the real categories.
 */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++
  }
  const other = text.length - cjk
  return cjk + Math.ceil(other / 4)
}

function byteLength(text: string): number {
  return text ? new TextEncoder().encode(text).length : 0
}

export const HARNESS_INJECTED_PREFIXES = [
  '【工作流步骤】',
  '【修复模式】',
  '【系统】',
  '【强制写入】',
  '【磁盘提示】',
  '[SYSTEM:',
  '计划已确认。当前执行步骤',
  '你刚才的回复不符合计划格式要求'
]

const HARNESS_INJECTED_MARKERS = ['只执行当前步骤', '当前步骤 #']

export const CONTEXT_CATEGORY_LABELS: Record<ContextCategory, string> = {
  systemPrompt: '系统提示',
  harnessInjected: '宿主注入指令',
  user: '用户输入',
  toolResult: '工具结果',
  assistantText: '助手正文',
  assistantToolArgs: '工具调用参数',
  imageParts: '图片输入',
  unaccounted: '未随快照持久化（每步注入 + 工具 schema）'
}

interface MessageRecord {
  index: number
  role: string
  name?: string
  category: ContextCategory
  tokens: number
  bytes: number
  dupText: string
}

function textOf(content: string | ChatContentPart[] | undefined | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  let out = ''
  for (const part of content) {
    if (part.type === 'text') out += part.text
  }
  return out
}

function imageCountOf(content: string | ChatContentPart[] | undefined | null): number {
  if (!content || typeof content === 'string') return 0
  return content.filter((part) => part.type === 'image_url').length
}

function isHarnessInjected(message: ChatMessage, text: string): boolean {
  if (message.origin === 'harness') return true
  const head = text.slice(0, 64)
  if (HARNESS_INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) return true
  return HARNESS_INJECTED_MARKERS.some((marker) => text.includes(marker))
}

function classify(message: ChatMessage): ContextCategory {
  const role = (message.role || '').toLowerCase()
  if (role === 'system') return 'systemPrompt'
  if (role === 'tool') return 'toolResult'
  if (role === 'assistant') return 'assistantText'
  if (role === 'user') {
    return isHarnessInjected(message, textOf(message.content)) ? 'harnessInjected' : 'user'
  }
  return 'user'
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

/**
 * Near-duplicate key: a re-typed copy usually drops the line-number gutter and
 * may re-wrap lines, so gutters, paths, digits and all whitespace are removed.
 * The gutter match must also fire when the pipe ends the text, otherwise a
 * trailing `12 |` survives trimming and the copy goes undetected.
 * Callers must treat these matches as approximate (flagged `exact: false`).
 */
function nearKey(text: string): string {
  return normalizeDiagnosticMessage(text.replace(/^[ \t]*\d+[ \t]*\|/gm, '')).replace(/\s+/g, '')
}

function collectRecords(messages: ChatMessage[]): MessageRecord[] {
  const records: MessageRecord[] = []
  messages.forEach((message, index) => {
    const role = (message.role || '').toLowerCase()
    const text = textOf(message.content)
    const images = imageCountOf(message.content)
    const base: MessageRecord = {
      index,
      role,
      name: message.name,
      category: classify(message),
      tokens: estimateTextTokens(text),
      bytes: byteLength(text),
      dupText: text
    }
    if (base.tokens > 0 || base.bytes > 0 || images > 0) records.push(base)
    if (images > 0) {
      records.push({
        index,
        role,
        name: message.name,
        category: 'imageParts',
        tokens: images * IMAGE_PART_TOKEN_ESTIMATE,
        bytes: 0,
        dupText: ''
      })
    }
    if (role === 'assistant' && message.tool_calls?.length) {
      const args = JSON.stringify(message.tool_calls)
      const tokens = estimateTextTokens(args)
      if (tokens > 0) {
        records.push({
          index,
          role,
          name: message.name,
          category: 'assistantToolArgs',
          tokens,
          bytes: byteLength(args),
          dupText: args
        })
      }
    }
  })
  return records
}

interface DupPass {
  groups: ContextDuplicateGroup[]
  consumed: Set<number>
}

function groupDuplicates(records: MessageRecord[], exact: boolean): DupPass {
  const buckets = new Map<string, MessageRecord[]>()
  for (const record of records) {
    if (record.category === 'imageParts') continue
    const trimmed = record.dupText.trim()
    if (trimmed.length < 200) continue
    const key = exact ? trimmed : nearKey(record.dupText)
    if (!exact && key.length < 80) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(record)
    else buckets.set(key, [record])
  }
  const groups: ContextDuplicateGroup[] = []
  const consumed = new Set<number>()
  for (const [key, members] of buckets) {
    if (members.length < 2) continue
    if (!exact && members.some((member) => consumed.has(member.index))) continue
    const first = members[0]
    const wasted = members.length - 1
    groups.push({
      fingerprint: stableTextHash(exact ? `e:${key}` : `n:${key}`),
      count: members.length,
      wastedTokens: first.tokens * wasted,
      wastedBytes: first.bytes * wasted,
      roles: [...new Set(members.map((member) => `${member.role}${member.name ? `/${member.name}` : ''}`))],
      sample: preview(first.dupText),
      exact
    })
    members.forEach((member) => consumed.add(member.index))
  }
  return { groups, consumed }
}

export interface BuildContextAttributionOptions {
  /** API-reported prompt tokens for the request this message list was sent as. */
  promptTokens: number
  windowTokens: number
}

export function buildContextAttribution(
  messages: ChatMessage[],
  options: BuildContextAttributionOptions
): ContextAttribution {
  const promptTokens = Number.isFinite(options.promptTokens) && options.promptTokens > 0
    ? Math.round(options.promptTokens)
    : 0
  const windowTokens = Number.isFinite(options.windowTokens) && options.windowTokens > 0
    ? Math.round(options.windowTokens)
    : 0

  const records = collectRecords(Array.isArray(messages) ? messages : [])

  const byCategory = new Map<ContextCategory, { tokens: number; bytes: number }>()
  for (const record of records) {
    const slot = byCategory.get(record.category) || { tokens: 0, bytes: 0 }
    slot.tokens += record.tokens
    slot.bytes += record.bytes
    byCategory.set(record.category, slot)
  }

  const realCategories: ContextCategory[] = [
    'systemPrompt',
    'harnessInjected',
    'user',
    'toolResult',
    'assistantText',
    'assistantToolArgs',
    'imageParts'
  ]

  let measuredTokens = 0
  for (const category of realCategories) measuredTokens += byCategory.get(category)?.tokens || 0

  // Estimates are only scaled *down* to fit the real prompt. Scaling up would
  // silently charge the system prompt for per-step injections and tool schemas
  // that never reach the controller snapshot.
  const scale = promptTokens > 0 && measuredTokens > promptTokens ? promptTokens / measuredTokens : 1
  const scaledTokens = new Map<ContextCategory, number>()
  let scaledSum = 0
  for (const category of realCategories) {
    const value = Math.round((byCategory.get(category)?.tokens || 0) * scale)
    scaledTokens.set(category, value)
    scaledSum += value
  }
  const unaccountedTokens = promptTokens > 0 ? Math.max(0, promptTokens - scaledSum) : 0

  const total = scaledSum + unaccountedTokens
  // `unaccounted` is always rendered last: it is real prompt tokens with no
  // known composition, so leading with it would push every explainable
  // category to the far edge of the bar.
  const rankedCategories: ContextSlice[] = realCategories
    .map((category) => {
      const tokens = scaledTokens.get(category) || 0
      return {
        category,
        tokens,
        bytes: Math.round((byCategory.get(category)?.bytes || 0) * scale),
        share: total > 0 ? tokens / total : 0
      }
    })
    .filter((slice) => slice.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const categories: ContextSlice[] = unaccountedTokens > 0
    ? rankedCategories.concat({
        category: 'unaccounted',
        tokens: unaccountedTokens,
        bytes: 0,
        share: total > 0 ? unaccountedTokens / total : 0
      })
    : rankedCategories

  const byTool = new Map<string, ContextToolAggregate>()
  for (const record of records) {
    if (record.category !== 'toolResult') continue
    const name = record.name || 'tool'
    const slot = byTool.get(name) || { name, tokens: 0, bytes: 0, count: 0 }
    slot.tokens += record.tokens
    slot.bytes += record.bytes
    slot.count += 1
    byTool.set(name, slot)
  }

  const exactPass = groupDuplicates(records, true)
  const nearPass = groupDuplicates(records.filter((r) => !exactPass.consumed.has(r.index)), false)
  const duplicates = [...exactPass.groups, ...nearPass.groups]
    .map((group) => ({
      ...group,
      wastedTokens: Math.round(group.wastedTokens * scale),
      wastedBytes: Math.round(group.wastedBytes * scale)
    }))
    .sort((a, b) => b.wastedTokens - a.wastedTokens)
    .slice(0, 12)

  const duplicateWasteTokens = duplicates.reduce((sum, group) => sum + group.wastedTokens, 0)
  // Duplication lives inside what the snapshot can actually see. Dividing by the
  // whole prompt would let the `unaccounted` block dilute the signal on 1M-window
  // models and report a real 27% echo as "safe".
  const duplicateDenominator = scaledSum > 0 ? scaledSum : total

  return {
    anchored: promptTokens > 0,
    estimated: promptTokens <= 0,
    promptTokens,
    windowTokens,
    percent: promptTokens > 0 && windowTokens > 0
      ? Math.min(100, Math.round((promptTokens / windowTokens) * 100))
      : 0,
    measuredTokens: scaledSum,
    unaccountedTokens,
    unaccountedShare: total > 0 ? unaccountedTokens / total : 0,
    categories,
    byTool: [...byTool.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
    topMessages: [...records]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, CONTEXT_TOP_LIMIT)
      .map((record) => ({
        index: record.index,
        role: record.role,
        name: record.name,
        category: record.category,
        tokens: Math.round(record.tokens * scale),
        bytes: Math.round(record.bytes * scale),
        preview: preview(record.dupText)
      })),
    duplicates,
    duplicateWasteTokens,
    duplicateShare: duplicateDenominator > 0 ? duplicateWasteTokens / duplicateDenominator : 0,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    computedAt: Date.now()
  }
}

/** Compact per-round record for the in-memory growth series (never persisted). */
export function toContextFrame(
  attribution: ContextAttribution,
  meta?: { phase?: string }
): ContextAttributionFrame {
  return {
    computedAt: attribution.computedAt,
    phase: meta?.phase,
    promptTokens: attribution.promptTokens,
    percent: attribution.percent,
    categories: attribution.categories.map((slice) => ({
      category: slice.category,
      tokens: slice.tokens,
      share: Number(slice.share.toFixed(4))
    })),
    duplicateShare: Number(attribution.duplicateShare.toFixed(4)),
    anchored: attribution.anchored
  }
}

export function isContextDuplicateNotable(attribution: ContextAttribution | null | undefined): boolean {
  if (!attribution) return false
  return attribution.duplicateShare > CONTEXT_DUPLICATE_WARN_SHARE
}

export function formatContextBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
