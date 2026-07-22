import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRepairInstruction,
  computeRepairBudget,
  countGradleErrorEntries,
  extractClientInMainMigrations,
  mainToClientPath,
  MAX_FREE_REPAIR_DIAG_ROUNDS,
  uniqueGradleErrorFiles
} from '../src/renderer/src/harness/workflow-engine.ts'
import { appendToolRoundHistory } from '../src/renderer/src/harness/chat-message.ts'
import { buildRepairPrompt } from '../src/renderer/src/utils/log-parser.ts'
import { microCompact, compactToolCallArguments } from '../src/renderer/src/harness/context-compact.ts'
import type { ChatMessage } from '../src/renderer/src/harness/chat-message.ts'

const CLIENT_IN_MAIN_LOG = [
  'BUILD FAILED',
  'src/main/java/com/example/frame_cover/config/ModConfigScreen.java:6: error: 程序包net.minecraft.client不存在',
  'src/main/java/com/example/frame_cover/mixin/MouseMixin.java:3: error: 程序包net.minecraft.client不存在',
  'src/main/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java:4: error: 程序包net.minecraft.client.gui不存在',
  '  59 个错误'
].join('\n')

test('computeRepairBudget scales with unique error files', () => {
  assert.equal(computeRepairBudget('BUILD FAILED\nno files'), 3)
  const budget = computeRepairBudget(CLIENT_IN_MAIN_LOG)
  assert.equal(budget, Math.min(10, Math.max(3, 3 + 2)))
  assert.ok(uniqueGradleErrorFiles(CLIENT_IN_MAIN_LOG).length >= 3)
})

test('countGradleErrorEntries detects progress when errors drop', () => {
  const a = countGradleErrorEntries(CLIENT_IN_MAIN_LOG)
  const fewer = CLIENT_IN_MAIN_LOG.replace(
    'src/main/java/com/example/frame_cover/mixin/MouseMixin.java:3: error: 程序包net.minecraft.client不存在\n',
    ''
  )
  const b = countGradleErrorEntries(fewer)
  assert.ok(a > b)
})

test('extractClientInMainMigrations lists main paths needing move', () => {
  const mains = extractClientInMainMigrations(CLIENT_IN_MAIN_LOG)
  assert.ok(mains.some((p) => p.includes('ModConfigScreen.java')))
  assert.equal(
    mainToClientPath('src/main/java/com/example/frame_cover/config/ModConfigScreen.java'),
    'src/client/java/com/example/frame_cover/config/ModConfigScreen.java'
  )
})

test('buildRepairInstruction prioritizes write+delete for splitEnvironment', () => {
  const text = buildRepairInstruction(CLIENT_IN_MAIN_LOG, 'build')
  assert.match(text, /write_file/)
  assert.match(text, /delete_file/)
  assert.match(text, /src\/client\/java/)
  assert.doesNotMatch(text, /edit_file 优先/)
  assert.match(text, /批量迁移|强制顺序/)
})

test('buildRepairPrompt is tool-oriented not paste-full-code', () => {
  const prompt = buildRepairPrompt(
    [{ type: 'gradle-error', message: 'BUILD FAILED', detail: 'compile failed', file: 'A.java', line: 1 }],
    'BUILD FAILED\nerror: foo'
  )
  assert.match(prompt, /trigger_build/)
  assert.match(prompt, /write_file|edit_file/)
  assert.doesNotMatch(prompt, /以注释形式指明文件路径/)
  assert.doesNotMatch(prompt, /给出完整的修正代码/)
})

test('appendToolRoundHistory does not push role:system instruction', () => {
  const messages: ChatMessage[] = []
  const returned = appendToolRoundHistory(
    messages,
    '',
    [{ id: 'c1', name: 'read_file', args: { path: 'a.java' }, rawArguments: '{"path":"a.java"}' }],
    new Map([['c1', { output: 'ok' }]]),
    '【修复】继续 write_file'
  )
  assert.equal(messages.length, 2)
  assert.ok(messages.every((m) => m.role !== 'system'))
  assert.equal(returned, '【修复】继续 write_file')
})

test('MAX_FREE_REPAIR_DIAG_ROUNDS is 2', () => {
  assert.equal(MAX_FREE_REPAIR_DIAG_ROUNDS, 2)
})

test('microCompact leaves already-compacted tool results stable', () => {
  const compactedContent = '[已压缩: read_file — 读取: package com.example]'
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'tool', content: compactedContent, tool_call_id: 't1', name: 'read_file' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a4' },
    { role: 'user', content: 'recent' }
  ]
  const once = microCompact(messages, 4)
  const toolIdx = once.findIndex((m) => m.role === 'tool')
  assert.ok(toolIdx >= 0)
  assert.equal(once[toolIdx].content, compactedContent)
  const twice = microCompact(once, 5)
  assert.equal(twice[toolIdx].content, compactedContent)
})

test('compactToolCallArguments is idempotent', () => {
  const call = {
    id: 'x',
    type: 'function' as const,
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path: 'a.java', content: 'x'.repeat(500) })
    }
  }
  const a = compactToolCallArguments(call)
  const b = compactToolCallArguments(a)
  assert.equal(a.function.arguments, b.function.arguments)
  assert.match(a.function.arguments, /_compacted/)
})
