import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelAdapter } from '../../src/renderer/src/harness/model-adapter.ts'
import {
  assistantToolCallMessage,
  withoutReasoningEcho,
  type ChatMessage,
  type ModelToolCall
} from '../../src/renderer/src/harness/chat-message.ts'
import { isReasoningContinuityError, isRetryableFetchError } from '../../src/renderer/src/harness/fetch-retry.ts'

const CALL: ModelToolCall = {
  id: 'call_1',
  name: 'read_file',
  args: { path: 'a.java' },
  rawArguments: '{"path":"a.java"}'
}

function bodyOf(protocol: 'openai-chat' | 'anthropic-messages', messages: ChatMessage[]): Record<string, any> {
  const adapter = createModelAdapter({
    endpoint: protocol === 'anthropic-messages' ? 'https://api.example.com/v1/messages' : 'https://api.example.com/v1',
    model: 'thinking-model',
    providerId: 'custom',
    protocol
  })
  const request = adapter.buildRequest({
    endpoint: protocol === 'anthropic-messages' ? 'https://api.example.com/v1/messages' : 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'thinking-model',
    providerId: 'custom',
    protocol,
    messages,
    tools: [],
    maxTokens: 1024
  })
  return JSON.parse(String(request.init.body))
}

test('assistant tool-call turns carry the reasoning they produced', () => {
  const withReasoning = assistantToolCallMessage('thinking aloud', [CALL], '  step by step  ')
  assert.equal(withReasoning.reasoningContent, '  step by step  ')
  assert.equal(assistantToolCallMessage('', [CALL]).reasoningContent, undefined, 'no reasoning → no field')
})

test('openai-chat echoes reasoning_content only for turns that produced it', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    assistantToolCallMessage('answer', [CALL], 'private chain of thought'),
    toolResultTurn()
  ]
  const body = bodyOf('openai-chat', messages)
  assert.equal(body.messages[2].reasoning_content, 'private chain of thought')
  assert.equal(body.messages[2].reasoningContent, undefined, 'internal camelCase key must not reach the wire')
  assert.equal(body.messages[1].reasoning_content, undefined, 'nothing invented for turns without reasoning')
})

test('anthropic messages never receive the openai reasoning field', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    assistantToolCallMessage('answer', [CALL], 'private chain of thought')
  ]
  const body = bodyOf('anthropic-messages', messages)
  const serialized = JSON.stringify(body.messages)
  assert.ok(!serialized.includes('reasoning'), serialized)
  assert.ok(!serialized.includes('chain of thought'), serialized)
})

test('the continuity retry shape drops only the echoed reasoning', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'go' },
    assistantToolCallMessage('answer', [CALL], 'private chain of thought')
  ]
  const stripped = withoutReasoningEcho(messages)
  assert.equal(stripped[0], messages[0], 'untouched messages keep identity')
  assert.equal(stripped[1].reasoningContent, undefined)
  assert.equal(stripped[1].content, 'answer')
  assert.deepEqual(stripped[1].tool_calls, messages[1].tool_calls)
  assert.equal(messages[1].reasoningContent, 'private chain of thought', 'input is not mutated')
})

test('a reasoning_content rejection is classified, not retried or rate-limited', () => {
  const logged = new Error(
    'API error 400: {"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API.","type":"invalid_request_error","param":"messages.7.reasoning_content","code":"invalid_request_error"}}'
  )
  assert.equal(isReasoningContinuityError(logged), true)
  assert.equal(isRetryableFetchError(logged), false, 're-sending the same payload cannot help')
  assert.equal(isReasoningContinuityError(new Error('API error 400: {"error":{"type":"invalid_request_error","message":"unknown field"}}')), false)
  assert.equal(isReasoningContinuityError(new Error('API error 429: rate limit reached')), false)
  assert.equal(isReasoningContinuityError(new Error('reasoning_content is documented as optional')), false)
})

function toolResultTurn(): ChatMessage {
  return { role: 'tool', origin: 'tool', tool_call_id: CALL.id, name: CALL.name, content: 'ok' }
}
