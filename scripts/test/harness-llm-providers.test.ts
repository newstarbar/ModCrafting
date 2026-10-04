import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CUSTOM_PROVIDER_ID,
  inferProviderId,
  resolveSelection,
  providerDisplayLabel,
  findProviderByEndpoint,
  buildProviderThinkingFields,
  thinkingProfileFor,
  supportsGlmReasoningEffort,
} from '../../src/shared/llm-providers.ts'
import { MODEL_PRESETS } from '../../src/renderer/src/config/model-presets.ts'
import {
  MAX_REASONING_HARD_CHARS,
  MAX_REASONING_SOFT_CHARS,
  LONG_REASONING_KICK
} from '../../src/renderer/src/harness/reasoning-limits.ts'

test('resolveSelection returns correct endpoint for DeepSeek', () => {
  const sel = resolveSelection('deepseek', 'deepseek-flash')
  assert.equal(sel.endpoint, 'https://api.deepseek.com/v1')
  assert.equal(sel.modelId, 'deepseek-flash')
  assert.equal(sel.providerId, 'deepseek')
})

test('resolveSelection returns correct endpoint for DashScope', () => {
  const sel = resolveSelection('dashscope', 'qwen3.8-max')
  assert.equal(sel.endpoint, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(sel.modelId, 'qwen3.8-max')
})

test('inferProviderId matches endpoint URL', () => {
  assert.equal(
    inferProviderId('https://api.moonshot.cn/v1', 'kimi-k3'),
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
  assert.ok(MODEL_PRESETS.some((p) => p.id === 'deepseek-flash' && p.providerId === 'deepseek'))
})

test('getModelPricing distinguishes DeepSeek Flash vs Pro', async () => {
  const { getModelPricing } = await import('../../src/shared/llm-providers.ts')
  const flash = getModelPricing('deepseek', 'deepseek-flash')
  const pro = getModelPricing('deepseek', 'deepseek-v4-pro')
  // 中文官网人民币标价（元 / 百万 tokens，闲时）
  assert.equal(flash.inputHit, 0.02)
  assert.equal(flash.inputMiss, 1)
  assert.equal(flash.output, 4)
  assert.equal(pro.inputHit, 0.15)
  assert.equal(pro.inputMiss, 4.5)
  assert.equal(pro.output, 13.5)
  assert.ok(pro.inputMiss > flash.inputMiss)
  assert.ok(pro.output > flash.output)
})

test('GLM-5.2 thinking fields use reasoning_effort high (not default max)', () => {
  assert.equal(thinkingProfileFor('glm-5.2')?.family.test('glm-5.2'), true)
  assert.equal(thinkingProfileFor('deepseek-v4-pro'), undefined)
  assert.equal(supportsGlmReasoningEffort('glm-5.2'), true)
  assert.equal(supportsGlmReasoningEffort('glm-5.3'), true)
  assert.equal(supportsGlmReasoningEffort('glm-5.1'), false)
  assert.deepEqual(buildProviderThinkingFields('glm-5.2'), {
    thinking: { type: 'enabled' },
    reasoning_effort: 'high'
  })
  assert.deepEqual(buildProviderThinkingFields('glm-5.1'), {
    thinking: { type: 'enabled' }
  })
  // A thinking model with no declared body fields must not gain any invented flag.
  assert.deepEqual(buildProviderThinkingFields('deepseek-flash'), {})
})

test('reasoning soft/hard caps guard against GLM Wait/Hmm rumination', () => {
  assert.ok(MAX_REASONING_SOFT_CHARS < MAX_REASONING_HARD_CHARS)
  assert.ok(MAX_REASONING_SOFT_CHARS >= 4000)
  assert.match(LONG_REASONING_KICK, /Wait\/Hmm|立即调用工具/)
})
