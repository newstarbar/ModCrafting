import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_PROVIDER_ID,
  inferProviderId,
  resolveSelection,
  providerDisplayLabel,
  findProviderByEndpoint,
} from '../src/shared/llm-providers.ts'
import { MODEL_PRESETS } from '../src/renderer/src/config/model-presets.ts'

test('resolveSelection returns correct endpoint for DeepSeek', () => {
  const sel = resolveSelection('deepseek', 'deepseek-chat')
  assert.equal(sel.endpoint, 'https://api.deepseek.com/v1')
  assert.equal(sel.modelId, 'deepseek-chat')
  assert.equal(sel.providerId, 'deepseek')
})

test('resolveSelection returns correct endpoint for DashScope', () => {
  const sel = resolveSelection('dashscope', 'qwen3.7-max')
  assert.equal(sel.endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(sel.modelId, 'qwen3.7-max')
})

test('inferProviderId matches endpoint URL', () => {
  assert.equal(
    inferProviderId('https://api.moonshot.cn/v1', 'moonshot-v1-8k'),
    'moonshot'
  )
})

test('inferProviderId falls back to custom for unknown endpoint', () => {
  assert.equal(
    inferProviderId('https://api.unknown.example/v1', 'some-model'),
    CUSTOM_PROVIDER_ID
  )
})

test('inferProviderId prefers saved provider id', () => {
  assert.equal(
    inferProviderId('https://api.unknown.example/v1', 'some-model', 'zhipu'),
    'zhipu'
  )
})

test('findProviderByEndpoint normalizes trailing slash', () => {
  const provider = findProviderByEndpoint('https://api.deepseek.com/v1/')
  assert.equal(provider?.id, 'deepseek')
})

test('providerDisplayLabel returns vendor name', () => {
  assert.equal(providerDisplayLabel('dashscope'), '通义千问')
  assert.equal(providerDisplayLabel(CUSTOM_PROVIDER_ID, 'https://api.example.com/v1'), 'api.example.com')
})

test('MODEL_PRESETS is non-empty and includes DeepSeek defaults', () => {
  assert.ok(MODEL_PRESETS.length > 0)
  assert.ok(MODEL_PRESETS.some((p) => p.id === 'deepseek-v4-flash' && p.providerId === 'deepseek'))
})
