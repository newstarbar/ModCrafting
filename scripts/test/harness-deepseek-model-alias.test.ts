import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	getCatalogVisionSupport,
	getModelContextWindow,
	getModelPricing,
	inferProviderId,
	isKnownModel,
	LLM_PROVIDERS,
	normalizeModelId,
	resolveSelection
} from '../../src/shared/llm-providers.ts'
import { contextWindowLimit } from '../../src/renderer/src/utils/usage.ts'
import { isVisionCapableModel } from '../../src/renderer/src/harness/chat-message.ts'
import { defaultRoutingConfig, normalizeRoutingConfig } from '../../src/shared/model-routing.ts'

const FLASH = { inputHit: 0.02, inputMiss: 1, output: 4 }
const PRO = { inputHit: 0.15, inputMiss: 4.5, output: 13.5 }

test('retired DeepSeek ids fold onto the canonical deepseek-flash', () => {
	assert.equal(normalizeModelId('deepseek', 'deepseek-v4-flash'), 'deepseek-flash')
	assert.equal(normalizeModelId('deepseek', 'deepseek-v4-flash-vision-exp'), 'deepseek-flash')
	assert.equal(normalizeModelId('deepseek', 'DeepSeek-V4-Flash'), 'deepseek-flash')
	assert.equal(normalizeModelId('deepseek', 'deepseek-flash'), 'deepseek-flash')
	assert.equal(normalizeModelId('deepseek', 'deepseek-v4-pro'), 'deepseek-v4-pro')
	// providerId is unknown on some call paths; a retired id must still fold.
	assert.equal(normalizeModelId(undefined, 'deepseek-v4-flash'), 'deepseek-flash')
	// A custom endpoint id is chosen literally by the user and must survive verbatim.
	assert.equal(normalizeModelId('custom', 'deepseek-v4-flash'), 'deepseek-v4-flash')
	assert.equal(normalizeModelId('dashscope', 'deepseek-v4-flash'), 'deepseek-v4-flash')
})

test('the retired id is no longer selectable but still resolves through the catalog', () => {
	const deepseek = LLM_PROVIDERS.find((provider) => provider.id === 'deepseek')
	assert.ok(deepseek)
	assert.deepEqual(deepseek.models.map((model) => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
	assert.equal(isKnownModel('deepseek-v4-flash', 'deepseek'), true)
	assert.equal(inferProviderId('', 'deepseek-v4-flash'), 'deepseek')
})

test('retired ids bill at Flash, and an unknown id never bills at the Pro premium', () => {
	assert.deepEqual(getModelPricing('deepseek', 'deepseek-v4-flash'), FLASH)
	assert.deepEqual(getModelPricing('deepseek', 'deepseek-v4-flash-vision-exp'), FLASH)
	assert.deepEqual(getModelPricing('deepseek', 'deepseek-flash'), FLASH)
	assert.deepEqual(getModelPricing('deepseek', 'deepseek-v4-pro'), PRO)
	// Guards the removed `model.includes('pro')` branch: a substring must not buy the 4.5 rate.
	assert.deepEqual(getModelPricing('deepseek', 'deepseek-v4-progress'), FLASH)
	assert.deepEqual(getModelPricing(undefined, 'deepseek-v4-flash-vision-exp'), FLASH)
})

test('dropping the catalog entry does not regress vision or context window for retired ids', () => {
	assert.equal(getCatalogVisionSupport('deepseek-v4-flash', 'deepseek'), true)
	assert.equal(getCatalogVisionSupport('deepseek-v4-flash'), true)
	assert.equal(isVisionCapableModel('deepseek-v4-flash', 'deepseek'), true)
	assert.equal(isVisionCapableModel('deepseek-v4-pro', 'deepseek'), false)
	assert.equal(getModelContextWindow('deepseek-v4-flash', 'deepseek'), 1_000_000)
	assert.equal(getModelContextWindow('deepseek-flash'), 1_000_000)
	// usage.ts keeps its own fallback for endpoints outside the catalog.
	assert.equal(contextWindowLimit('deepseek-flash'), 1_000_000)
	assert.equal(contextWindowLimit('deepseek-v4-pro'), 1_000_000)
})

test('resolveSelection keeps the canonical id on the wire and in the label', () => {
	const selection = resolveSelection('deepseek', 'deepseek-v4-flash')
	assert.equal(selection.modelId, 'deepseek-flash')
	assert.equal(selection.endpoint, 'https://api.deepseek.com/v1')
})

test('persisted routing config is folded onto canonical ids instead of resurrecting retired ones', () => {
	const normalized = normalizeRoutingConfig({
		...defaultRoutingConfig(),
		defaultSelection: {
			mode: 'routed',
			strategyId: 'balanced',
			taskTemplateId: 'auto',
			model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
		}
	})
	assert.deepEqual(normalized.defaultSelection.model, { providerId: 'deepseek', modelId: 'deepseek-flash' })

	// A selection pointing at a model the catalog does not serve is dropped rather than sent.
	const dropped = normalizeRoutingConfig({
		...defaultRoutingConfig(),
		defaultSelection: {
			mode: 'routed',
			strategyId: 'balanced',
			taskTemplateId: 'auto',
			model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash-vision-exp' }
		}
	})
	assert.equal(dropped.defaultSelection.model?.modelId, 'deepseek-flash')

	const unknown = normalizeRoutingConfig({
		...defaultRoutingConfig(),
		defaultSelection: {
			mode: 'routed',
			strategyId: 'balanced',
			taskTemplateId: 'auto',
			model: { providerId: 'deepseek', modelId: 'deepseek-not-a-model' }
		}
	})
	assert.equal(unknown.defaultSelection.model, undefined)
})
