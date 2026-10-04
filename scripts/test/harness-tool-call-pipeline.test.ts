import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelAdapter } from '../../src/renderer/src/harness/model-adapter.ts'
import { ToolCallAssembler, assembleToolCalls } from '../../src/renderer/src/harness/tool-call-assembler.ts'
import { validateToolCalls } from '../../src/renderer/src/harness/tool-call-validator.ts'
import { createActiveToolSnapshot } from '../../src/renderer/src/harness/active-tool-snapshot.ts'
import { Registry } from '../../src/renderer/src/harness/tools.ts'
import type { NormalizedModelEvent } from '../../src/shared/harness-runtime.ts'

test('ToolCallAssembler joins OpenAI id-first and index-only argument chunks', () => {
  const adapter = createModelAdapter('https://api.example.test/v1', 'test-model', 'custom', 'openai-chat')
  const events: NormalizedModelEvent[] = [
    ...adapter.normalizeEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_real', function: { name: 'read_file', arguments: '' } }] } }] }),
    ...adapter.normalizeEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/main/X.java"}' } }] } }] }),
    ...adapter.normalizeEvent({ choices: [{ finish_reason: 'tool_calls', delta: {} }] })
  ]
  const calls = assembleToolCalls(events, { protocol: 'openai-chat', modelId: 'test-model' }, 'tool_calls')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_real')
  assert.equal(calls[0].name, 'read_file')
  assert.deepEqual(calls[0].args, { path: 'src/main/X.java' })
  assert.equal(calls[0].complete, true)
  const validation = validateToolCalls(calls.map((call) => ({ ...call, rawArguments: call.rawArguments, args: call.args })), [{
    name: 'read_file', description: 'read', parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }
  }], { phase: 'plan' })
  assert.equal(validation.accepted.length, 1)
})

test('ToolCallAssembler aliases a delayed index to a first chunk that only has id/name', () => {
  const calls = assembleToolCalls([
    { type: 'tool_call_start', toolCall: { providerId: 'call_delayed', nameDelta: 'read_file' } },
    { type: 'tool_call_delta', toolCall: { providerIndex: 0, argumentsDelta: '{"path":"src/main/Delayed.java"}' } },
    { type: 'tool_call_end', toolCall: { providerIndex: 0 } }
  ], { protocol: 'openai-chat', modelId: 'test-model' }, 'tool_calls')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_delayed')
  assert.equal(calls[0].providerIndex, 0)
  assert.deepEqual(calls[0].args, { path: 'src/main/Delayed.java' })
})

test('ToolCallAssembler keeps interleaved calls separate and delays local ids until finish', () => {
  const calls = assembleToolCalls([
    { type: 'tool_call_delta', toolCall: { providerIndex: 1, argumentsDelta: '{"path":"B"}' } },
    { type: 'tool_call_start', toolCall: { providerIndex: 0, providerId: 'a', nameDelta: 'read_file', argumentsDelta: '{"path":"A"}' } },
    { type: 'tool_call_delta', toolCall: { providerIndex: 1, providerId: 'b', nameDelta: 'read_file' } },
    { type: 'tool_call_end', toolCall: { providerIndex: 0 } },
    { type: 'tool_call_end', toolCall: { providerIndex: 1 } }
  ], { protocol: 'openai-chat', modelId: 'test-model' })
  assert.deepEqual(calls.map((call) => [call.id, call.args.path]), [['a', 'A'], ['b', 'B']])
})

test('incomplete provider arguments are not misclassified as inactive tools', () => {
  const calls = assembleToolCalls([
    { type: 'tool_call_start', toolCall: { providerIndex: 0, providerId: 'call_1', nameDelta: 'read_file' } }
  ], { protocol: 'openai-chat', modelId: 'test-model' }, 'length')
  const validation = validateToolCalls(calls.map((call) => ({ ...call, rawArguments: call.rawArguments, args: call.args })), [{
    name: 'read_file', description: 'read', parameters: { type: 'object', required: ['path'] }
  }], { phase: 'plan' })
  const rejected = validation.rejected.get('call_1')!
  assert.equal(rejected.failureKind, 'arguments_incomplete')
  assert.notEqual(rejected.failureKind, 'tool_inactive')
})

test('finish_reason length never executes a syntactically partial call', () => {
  const calls = assembleToolCalls([
    { type: 'tool_call_start', toolCall: { providerIndex: 0, nameDelta: 'read_file', argumentsDelta: '{"path":"src/' } }
  ], { protocol: 'openai-chat', modelId: 'test-model' }, 'length')
  assert.equal(calls[0].complete, false)
  assert.equal(calls[0].failureKind, 'arguments_incomplete')
})

test('identifier-less sequential provider chunks receive a stable completion id', () => {
  const calls = assembleToolCalls([
    { type: 'tool_call_start', toolCall: { nameDelta: 'read_file', argumentsDelta: '{"path":"' } },
    { type: 'tool_call_delta', toolCall: { argumentsDelta: 'src/X.java"}' } },
    { type: 'tool_call_end', toolCall: {} }
  ], { protocol: 'openai-chat', modelId: 'test-model', providerId: 'custom' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].id, /^custom_tool_0$/)
  assert.deepEqual(calls[0].args, { path: 'src/X.java' })
})

test('Anthropic adapter normalizes tool_use/input_json_delta and preserves one protocol boundary', () => {
  const adapter = createModelAdapter({ endpoint: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', providerId: 'minimax', protocol: 'anthropic-messages' })
  const request = adapter.buildRequest({ endpoint: 'https://api.minimaxi.com/anthropic', apiKey: 'secret-key', model: 'MiniMax-M3', providerId: 'minimax', protocol: 'anthropic-messages', messages: [{ role: 'user', content: 'read a file' }], tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }], maxTokens: 100, stream: true })
  assert.match(request.url, /\/v1\/messages$/)
  assert.equal((request.init.headers as Record<string, string>)['x-api-key'], 'secret-key')
  const events = [
    ...adapter.normalizeEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'read_file', input: {} } }),
    ...adapter.normalizeEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"X"}' } }),
    ...adapter.normalizeEvent({ type: 'content_block_stop', index: 0 }),
    ...adapter.normalizeEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })
  ]
  const calls = assembleToolCalls(events, { protocol: 'anthropic-messages', modelId: 'MiniMax-M3', providerId: 'minimax' }, 'tool_use')
  assert.equal(calls[0].id, 'tool_1')
  assert.deepEqual(calls[0].args, { path: 'X' })
})

test('snapshot validation distinguishes unknown tools from inactive registered tools', () => {
  const registry = new Registry()
  const snapshot = createActiveToolSnapshot({ registry, phase: 'plan', turnId: 'plan:1' })
  const unknown = validateToolCalls([{ id: 'unknown', name: 'not_registered', args: {}, rawArguments: '{}' }], snapshot, { phase: 'plan' })
  assert.equal(unknown.rejected.get('unknown')?.failureKind, 'tool_unknown')
})
