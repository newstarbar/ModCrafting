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

test('effectiveContextWindow caps 1M models at 128k', () => {
  assert.equal(effectiveContextWindow(1_000_000), 128_000)
  assert.equal(effectiveContextWindow(64_000), 64_000)
  assert.equal(compactThreshold(1_000_000), 64_000)
  assert.equal(warnTokenThreshold(1_000_000), 102_400)
})

test('contextPercentFromPrompt uses latest prompt against model limit', () => {
  // DeepSeek V4 Flash is registered as 1M
  assert.equal(contextPercentFromPrompt(80_000, 'deepseek-v4-flash', 'deepseek'), 8)
  // Summing multi-step prompts must NOT be used — 10×80k would show 80%
  assert.equal(contextPercentFromPrompt(800_000, 'deepseek-v4-flash', 'deepseek'), 80)
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

test('prepareMessages auto-compacts 1M window once estimate exceeds ~64k', async () => {
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
  assert.ok(estimated > compactThreshold(1_000_000), `expected estimate ${estimated} > 64k`)

  let summarized = false
  const result = await prepareMessages(
    messages,
    0,
    { contextWindow: 1_000_000 },
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
