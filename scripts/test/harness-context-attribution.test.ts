import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContextAttribution,
  estimateTextTokens,
  isContextDuplicateNotable,
  toContextFrame,
  IMAGE_PART_TOKEN_ESTIMATE,
  CONTEXT_DUPLICATE_WARN_SHARE,
  type ContextCategory,
  type ContextAttribution
} from '../../src/renderer/src/utils/context-attribution.ts'
import { buildSessionMarkdown } from '../../src/renderer/src/utils/session-export-md.ts'
import type { ChatMessage } from '../../src/renderer/src/harness/chat-message.ts'

const LONG_UNIQUE = `mixins.json 注册清单 ${'X'.repeat(240)} 结束`

function sliceOf(attribution: ContextAttribution, category: ContextCategory) {
  return attribution.categories.find((entry) => entry.category === category)
}

function sumTokens(attribution: ContextAttribution): number {
  return attribution.categories.reduce((total, entry) => total + entry.tokens, 0)
}

test('CJK text is estimated at roughly one token per character', () => {
  assert.equal(estimateTextTokens('将潜影贝的飞弹攻击替换为苦力怕'), 15)
  assert.equal(estimateTextTokens('abcd'), 1)
  assert.equal(estimateTextTokens(''), 0)
})

test('category tokens are anchored to API prompt tokens with no drift', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你'.repeat(200) },
    { role: 'user', origin: 'user', content: '将潜影贝的飞弹攻击替换为苦力怕' },
    { role: 'tool', name: 'read_file', content: LONG_UNIQUE },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]
    }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 50_000, windowTokens: 1_000_000 })

  assert.equal(attribution.anchored, true)
  assert.equal(attribution.estimated, false)
  assert.equal(sumTokens(attribution), 50_000)
  assert.equal(attribution.measuredTokens + attribution.unaccountedTokens, 50_000)
  assert.equal(attribution.percent, 5)
})

test('estimates are never scaled up beyond what the snapshot proves', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'short' }]
  const attribution = buildContextAttribution(messages, { promptTokens: 100_000, windowTokens: 1_000_000 })

  assert.ok(attribution.unaccountedTokens > 90_000)
  assert.ok(sliceOf(attribution, 'unaccounted'))
  assert.ok(attribution.unaccountedShare > 0.9)
})

test('over-counted estimates scale down so categories cannot exceed the real prompt', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: '你'.repeat(9_000) }]
  const attribution = buildContextAttribution(messages, { promptTokens: 4_000, windowTokens: 1_000_000 })

  assert.equal(attribution.unaccountedTokens, 0)
  assert.equal(sumTokens(attribution), 4_000)
  assert.equal(attribution.categories.length, 1)
  assert.equal(attribution.categories[0].category, 'systemPrompt')
})

test('assistant echoing a tool result back as its own text is detected and quantified', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'tool', name: 'submit_plan', content: LONG_UNIQUE },
    { role: 'assistant', content: LONG_UNIQUE }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 20_000, windowTokens: 1_000_000 })
  const group = attribution.duplicates.find((entry) => entry.exact)

  assert.ok(group, 'expected an exact duplicate group')
  assert.equal(group!.count, 2)
  assert.ok(group!.wastedTokens > 0)
  assert.ok(group!.roles.includes('tool/submit_plan'))
  assert.ok(group!.roles.includes('assistant'))
  assert.ok(attribution.duplicateShare > 0, 'duplicate share must be reported')
  assert.equal(isContextDuplicateNotable(attribution), attribution.duplicateShare > CONTEXT_DUPLICATE_WARN_SHARE)
})

test('line-number gutters do not hide a near-duplicate read_file copy', () => {
  const body = 'import net.minecraft.entity.mob.CreeperEntity;'
  const numbered = body.repeat(8).split(';').join(';\n12 | ')
  const messages: ChatMessage[] = [
    { role: 'tool', name: 'read_file', content: numbered },
    { role: 'assistant', content: body.repeat(8) }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 30_000, windowTokens: 1_000_000 })

  assert.equal(attribution.duplicates.some((entry) => entry.exact), false)
  assert.equal(attribution.duplicates.some((entry) => entry.count === 2), true)
  assert.ok(attribution.duplicateWasteTokens > 0)
})

test('without API usage the attribution is flagged as estimate-only', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: '你'.repeat(500) },
    { role: 'user', origin: 'user', content: '将潜影贝的飞弹攻击替换为苦力怕' }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 0, windowTokens: 1_000_000 })

  assert.equal(attribution.anchored, false)
  assert.equal(attribution.estimated, true)
  assert.equal(attribution.percent, 0)
  assert.equal(attribution.unaccountedTokens, 0)
  assert.equal(sliceOf(attribution, 'unaccounted'), undefined)
  assert.equal(sumTokens(attribution), attribution.measuredTokens)
})

test('image parts never borrow their base64 length for token estimates', () => {
  const base64 = 'A'.repeat(200_000)
  const messages: ChatMessage[] = [
    {
      role: 'tool',
      name: 'mc_screenshot',
      content: [
        { type: 'text', text: '截图完成' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
      ]
    }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 0, windowTokens: 1_000_000 })

  assert.equal(sliceOf(attribution, 'imageParts')!.tokens, IMAGE_PART_TOKEN_ESTIMATE)
  assert.equal(sliceOf(attribution, 'toolResult')!.tokens, 4)
})

test('harness-injected user turns are separated from real user input', () => {
  const messages: ChatMessage[] = [
    { role: 'user', origin: 'harness', content: '只读勘探：用 list_directory 了解结构' },
    { role: 'user', content: '【系统】计划阶段禁止仅用文字结束。请立即调用 submit_plan 提交结构化计划' },
    { role: 'user', content: '计划已确认。当前执行步骤 #1：检查现有 Mixin\n类型: inspect\n允许工具: read_file' },
    { role: 'user', origin: 'user', content: '将潜影贝的飞弹攻击替换为苦力怕' }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 0, windowTokens: 1_000_000 })

  assert.ok(sliceOf(attribution, 'harnessInjected'))
  assert.ok(sliceOf(attribution, 'user'))
  assert.ok(sliceOf(attribution, 'harnessInjected')!.tokens > sliceOf(attribution, 'user')!.tokens)
  assert.equal(attribution.messageCount, 4)
})

test('empty and malformed inputs degrade to a zeroed attribution', () => {
  const inputs = [[] as ChatMessage[], undefined as unknown as ChatMessage[], null as unknown as ChatMessage[]]
  for (const messages of inputs) {
    const attribution = buildContextAttribution(messages, { promptTokens: 1_000, windowTokens: 0 })

    assert.equal(attribution.percent, 0)
    assert.equal(attribution.categories.length, 1)
    assert.equal(attribution.categories[0].category, 'unaccounted')
    assert.equal(attribution.duplicates.length, 0)
    assert.equal(attribution.topMessages.length, 0)
  }
})

test('tool results are aggregated per tool name for the breakdown view', () => {
  const messages: ChatMessage[] = [
    { role: 'tool', name: 'fabric_mixin_target_lookup', content: LONG_UNIQUE },
    { role: 'tool', name: 'fabric_mixin_target_lookup', content: `${LONG_UNIQUE}ZZZ` },
    { role: 'tool', name: 'read_file', content: '短结果' }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 0, windowTokens: 1_000_000 })

  assert.equal(attribution.byTool[0].name, 'fabric_mixin_target_lookup')
  assert.equal(attribution.byTool[0].count, 2)
  assert.ok(attribution.byTool[0].tokens > attribution.byTool[1].tokens)
})

test('toContextFrame keeps only the compact series fields', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys prompt' },
    { role: 'tool', name: 'grep', content: LONG_UNIQUE }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 8_000, windowTokens: 1_000_000 })
  const frame = toContextFrame(attribution, { phase: 'execute' })

  assert.equal(frame.phase, 'execute')
  assert.equal(frame.promptTokens, 8_000)
  assert.equal(frame.anchored, true)
  assert.equal('topMessages' in frame, false)
  assert.equal('duplicates' in frame, false)
  assert.ok(frame.categories.every((entry) => typeof entry.share === 'number'))
})

const EXPORT_MESSAGES = [
  {
    id: 'u1',
    role: 'user' as const,
    content: '将潜影贝的飞弹攻击替换为苦力怕',
    timestamp: 1
  },
  {
    id: 'a1',
    role: 'assistant' as const,
    content: '勘探完成',
    timestamp: 2,
    entries: [{ kind: 'text' as const, content: '勘探完成' }]
  }
]

test('session export prints the context accounting block when attribution exists', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'ModCrafting AI 助手\n'.repeat(20) },
    { role: 'tool', name: 'submit_plan', content: LONG_UNIQUE },
    { role: 'assistant', content: LONG_UNIQUE }
  ]
  const attribution = buildContextAttribution(messages, { promptTokens: 30_000, windowTokens: 1_000_000 })
  const md = buildSessionMarkdown({
    messages: EXPORT_MESSAGES as never,
    controllerMessages: messages,
    contextAttribution: attribution,
    contextAttributionHistory: [toContextFrame(attribution, { phase: 'execute' })]
  })

  assert.match(md, /### 上下文占用账目/)
  assert.match(md, /\| 分类 \| Token \| 占比 \| 字节 \|/)
  assert.match(md, /系统提示/)
  assert.match(md, /#### 重复内容/)
  assert.match(md, /#### 逐轮上下文序列/)
  // The 1.8x caveat is the whole point of printing this from raw objects.
  assert.match(md, /1\.8 倍/)
})

test('session export omits the accounting block without attribution', () => {
  const md = buildSessionMarkdown({
    messages: EXPORT_MESSAGES as never,
    controllerMessages: [{ role: 'system', content: 'sys' }]
  })

  assert.doesNotMatch(md, /### 上下文占用账目/)
})
