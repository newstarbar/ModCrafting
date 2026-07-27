import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactThreshold,
  compactToolCallArguments,
  effectiveContextWindow,
  estimatePromptTokens,
  microCompact,
  prepareMessages,
  RECENT_WINDOW,
  warnTokenThreshold
} from '../../src/renderer/src/harness/context-compact.ts'
import { contextPercentFromPrompt } from '../../src/renderer/src/utils/usage.ts'
import type { ChatMessage } from '../../src/renderer/src/harness/chat-message.ts'
import { contentAsText } from '../../src/renderer/src/harness/chat-message.ts'
import {
  MAX_SAME_TOOL_NOT_OFFERED,
  updateNotOfferedStreak
} from '../../src/renderer/src/harness/tool-not-offered-brake.ts'

test('effectiveContextWindow trusts model-declared sizes up to 1M', () => {
  assert.equal(effectiveContextWindow(1_000_000), 1_000_000)
  assert.equal(effectiveContextWindow(64_000), 64_000)
  assert.equal(compactThreshold(1_000_000), 500_000)
  assert.equal(warnTokenThreshold(1_000_000), 800_000)
})

test('microCompact never compresses blocked/Error tool outputs', () => {
  const blocked = 'blocked: [tool_not_offered] 工具 "mc_inspect" 未执行：该工具不在当前阶段/步骤的白名单中'
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'mc_inspect', arguments: '{}' }
      }]
    },
    { role: 'tool', name: 'mc_inspect', tool_call_id: 'c1', content: blocked },
    ...Array.from({ length: RECENT_WINDOW + 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `t${i}`
    } as ChatMessage))
  ]
  const compacted = microCompact(messages, 0)
  const toolMsg = compacted.find((m) => m.role === 'tool' && m.tool_call_id === 'c1')
  assert.equal(contentAsText(toolMsg?.content || ''), blocked)
})

test('contextPercentFromPrompt uses model-declared working window', () => {
  // DeepSeek V4 Flash claims 1M; 80k / 1M = 8%
  assert.equal(contextPercentFromPrompt(80_000, 'deepseek-v4-flash', 'deepseek'), 8)
  // 800k / 1M = 80%
  assert.equal(contextPercentFromPrompt(800_000, 'deepseek-v4-flash', 'deepseek'), 80)
  // Over working window clamps to 100
  assert.equal(contextPercentFromPrompt(1_500_000, 'deepseek-v4-flash', 'deepseek'), 100)
})

test('microCompact truncates aged write_file tool_call arguments', () => {
  const bigArgs = JSON.stringify({
    path: 'src/main/java/com/example/Big.java',
    content: 'A'.repeat(2000)
  })
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: { name: 'write_file', arguments: bigArgs }
      }]
    },
    { role: 'tool', name: 'write_file', tool_call_id: 'c1', content: 'Written' },
    // Enough later turns so the write is older than MICRO_COMPACT_AGE and outside RECENT_WINDOW
    ...Array.from({ length: RECENT_WINDOW + 4 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `t${i}`
    } as ChatMessage))
  ]

  const compacted = microCompact(messages, 0)
  const agedAssistant = compacted[1]
  assert.ok(agedAssistant.tool_calls?.[0])
  const args = agedAssistant.tool_calls![0].function.arguments
  assert.ok(args.length < bigArgs.length)
  assert.match(args, /_compacted/)
  assert.match(args, /Big\.java/)
})

test('compactToolCallArguments leaves small payloads alone', () => {
  const call = {
    id: 'c',
    type: 'function' as const,
    function: { name: 'read_file', arguments: '{"path":"a.java"}' }
  }
  assert.equal(compactToolCallArguments(call), call)
})

test('prepareMessages auto-compacts once estimate exceeds compact threshold', async () => {
  const bulky = 'x'.repeat(40_000) // ~10k tokens each
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system ' + bulky },
    { role: 'user', content: 'task ' + bulky },
    { role: 'assistant', content: 'ok ' + bulky },
    { role: 'user', content: 'more ' + bulky },
    { role: 'assistant', content: 'cont ' + bulky },
    { role: 'user', content: 'again ' + bulky },
    { role: 'assistant', content: 'done ' + bulky },
    { role: 'user', content: 'final ' + bulky }
  ]
  const estimated = estimatePromptTokens(messages)
  // Use 128k window so ~80k tokens exceeds the 64k compact threshold
  assert.ok(estimated > compactThreshold(128_000), `expected estimate ${estimated} > 64k`)

  let summarized = false
  const result = await prepareMessages(
    messages,
    0,
    { contextWindow: 128_000 },
    async () => {
      summarized = true
      return { text: '## 任务\n测试压缩\n## 当前状态\n已压缩' }
    }
  )

  assert.equal(summarized, true)
  assert.equal(result.compacted, true)
  assert.ok(estimatePromptTokens(result.messages) < estimated)
  assert.ok(result.messages.some((m) => (m.content || '').includes('上下文摘要')))
})

test('updateNotOfferedStreak brakes after 3 consecutive rounds or batch of 3', () => {
  const streak = new Map<string, number>()
  assert.deepEqual(
    updateNotOfferedStreak(streak, [
      { toolName: 'mc_inspect', errorKind: 'tool_not_offered', output: 'blocked' }
    ]),
    []
  )
  assert.equal(streak.get('mc_inspect'), 1)
  assert.deepEqual(
    updateNotOfferedStreak(streak, [
      { toolName: 'mc_inspect', errorKind: 'tool_not_offered', output: 'blocked' }
    ]),
    []
  )
  assert.deepEqual(
    updateNotOfferedStreak(streak, [
      { toolName: 'mc_inspect', errorKind: 'tool_not_offered', output: 'blocked' }
    ]),
    ['mc_inspect']
  )
  assert.ok((streak.get('mc_inspect') || 0) >= MAX_SAME_TOOL_NOT_OFFERED)

  const batch = new Map<string, number>()
  const braked = updateNotOfferedStreak(batch, [
    { toolName: 'grep', errorKind: 'tool_not_offered', output: 'a' },
    { toolName: 'grep', errorKind: 'tool_not_allowed', output: 'b' },
    { toolName: 'grep', errorKind: 'tool_not_offered', output: 'c' }
  ])
  assert.deepEqual(braked, ['grep'])
})
