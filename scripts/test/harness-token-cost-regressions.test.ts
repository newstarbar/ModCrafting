import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import path from 'node:path'
import {
	defaultRoutingConfig,
	extractRoutingSignals,
	findRoutingPreset,
	resolveBindingForDifficulty
} from '../../src/shared/model-routing.ts'
import { createActiveToolSnapshot } from '../../src/renderer/src/harness/active-tool-snapshot.ts'
import { validateToolCalls } from '../../src/renderer/src/harness/tool-call-validator.ts'
import { Registry } from '../../src/renderer/src/harness/tools.ts'
import { registerModCraftingTools } from '../../src/renderer/src/harness/tool-definitions.ts'
import { canToolResultAdvanceStep } from '../../src/renderer/src/harness/step-evidence.ts'
import type { ToolResult } from '../../src/renderer/src/harness/tools.ts'

const root = path.resolve(import.meta.dirname, '..', '..')

test('prompt length no longer decides task difficulty', () => {
	// A pasted session goal used to clear a 180-char bar and escalate the whole run to Pro.
	const verboseFeature = extractRoutingSignals(
		`请帮我把潜影贝的飞弹攻击替换成苦力怕，需要新增一个 Mixin 注入到 ShootBulletGoal 的 start 方法，` +
			`在服务端于潜影贝位置生成苦力怕实体来替代原来的飞弹，然后注册到 mixins.json 并完成构建与游戏内测试验证。`,
		'feature'
	)
	assert.equal(verboseFeature.difficulty, 'simple')

	const complex = extractRoutingSignals('重构整个注册架构并处理并发迁移', 'feature')
	assert.equal(complex.difficulty, 'complex')

	const debugging = extractRoutingSignals('构建报错了', 'bugfix')
	assert.equal(debugging.difficulty, 'standard')
})

test('the shipped balanced default keeps the cheap model for simple and standard turns', () => {
	const config = defaultRoutingConfig()
	assert.equal(config.defaultSelection.mode, 'routed')
	assert.equal(config.defaultSelection.strategyId, 'balanced')
	const preset = findRoutingPreset(config, 'balanced')
	for (const roleId of ['planner', 'implementer', 'debugger', 'codeReviewer'] as const) {
		for (const difficulty of ['simple', 'standard'] as const) {
			const resolved = resolveBindingForDifficulty(preset.roles[roleId], difficulty)
			assert.equal(resolved.primary.modelId, 'deepseek-flash', `${roleId}/${difficulty} must not bill Pro`)
		}
		const escalated = resolveBindingForDifficulty(preset.roles[roleId], 'complex')
		assert.equal(escalated.primary.modelId, 'deepseek-v4-pro', `${roleId}/complex may escalate`)
	}
})

test('the single-model preset stays on the cheap tier instead of resolving to Pro', () => {
	const preset = findRoutingPreset(defaultRoutingConfig(), 'single')
	for (const roleId of ['planner', 'implementer', 'debugger', 'codeReviewer'] as const) {
		assert.equal(preset.roles[roleId].primary.modelId, 'deepseek-flash')
	}
})

test('the advertised tool catalog is byte-identical between rounds', () => {
	// Prompt caching bills the whole re-sent context when the serialized prefix moves.
	// Restrictions are enforced by the snapshot at validation time, so what we advertise
	// can — and must — stay constant.
	const registry = new Registry()
	registerModCraftingTools(registry)
	const advertised = registry.schemas()
	assert.ok(advertised.length >= 40)
	const first = JSON.stringify(advertised)
	assert.equal(JSON.stringify(registry.schemas()), first, 'registry.schemas() order must be deterministic')

	const planSnapshot = createActiveToolSnapshot({ registry, phase: 'plan', turnId: 'plan:1' })
	const executeSnapshot = createActiveToolSnapshot({ registry, phase: 'execute', turnId: 'execute:1' })
	assert.ok(planSnapshot.tools.length < executeSnapshot.tools.length, 'plan must stay narrower than execute')
	assert.equal(JSON.stringify(registry.schemas()), first, 'advertising must not drift with phase gates')
})

test('a gated tool is rejected without replaying the whole tool list', () => {
	const registry = new Registry()
	registerModCraftingTools(registry)
	// The incident burned its budget in execute: a build step rejects project writes, and the
	// rejection text — persisted into history and replayed every later round — used to answer
	// with the full allowed-tool list.
	const snapshot = createActiveToolSnapshot({ registry, phase: 'execute', turnId: 'execute:1', stepKind: 'build' })
	const rejected = validateToolCalls(
		[{ id: 'w1', name: 'edit_file', args: { path: 'a.java' }, rawArguments: '{"path":"a.java"}' }],
		snapshot,
		{ phase: 'execute', stepTitle: '构建项目（gradlew build）' }
	)
	const result = rejected.rejected.get('w1')
	assert.equal(result?.failureKind, 'tool_inactive')
	const output = result?.output || ''
	assert.ok(output.length < 320, `rejection text is replayed by every later round; got ${output.length} chars`)
	assert.ok(!/, .*, .*, .*, .*, /.test(output), 'must not enumerate every tool name')
	assert.match(output, /step/)
})

test('a plan-phase write rejection keeps its guidance short too', () => {
	const registry = new Registry()
	registerModCraftingTools(registry)
	const snapshot = createActiveToolSnapshot({ registry, phase: 'plan', turnId: 'plan:1' })
	const rejected = validateToolCalls(
		[{ id: 'w1', name: 'write_file', args: { path: 'a.java', content: 'x' }, rawArguments: '{"path":"a.java","content":"x"}' }],
		snapshot,
		{ phase: 'plan' }
	)
	assert.equal(rejected.rejected.get('w1')?.failureKind, 'tool_inactive')
})

test('execute-phase system prompt no longer pays for a second copy of the tool catalog', () => {
	const source = readFileSync(path.join(root, 'src', 'renderer', 'src', 'harness', 'controller.ts'), 'utf8')
	assert.ok(!source.includes('${toolDescs}'), 'tool prose must not be inlined alongside body.tools')
	assert.ok(!source.includes('const toolDescs'), 'the catalog builder is dead weight once schemas travel per request')
})

test('a write step can be satisfied by the validator named in its evidence contract', () => {
	const step = {
		id: '3',
		description: '在 my-mod.mixins.json 的 mixins 列表注册 ShulkerCreeperMixin',
		status: 'pending' as const,
		kind: 'write' as const,
		targetPath: 'src/main/resources/my-mod.mixins.json',
		evidence: 'fabric_mod_json_validate 通过'
	}
	const validation = { kind: 'mod_json' as const, valid: true, version: '1.21.4' as const, targetPath: step.targetPath, checkedAt: 1 }
	const validatorResult = { ok: true, toolName: 'fabric_mod_json_validate', validation } as unknown as ToolResult
	assert.equal(canToolResultAdvanceStep(step, validatorResult).ok, true, 'declared validator must satisfy the step')

	// The same validator must not satisfy a step that never declared it.
	const undeclared = { ...step, evidence: '构建通过' }
	assert.equal(canToolResultAdvanceStep(undeclared, validatorResult).ok, false)

	// A failing validation is never evidence.
	const failing = { ok: true, toolName: 'fabric_mod_json_validate', validation: { ...validation, valid: false } } as unknown as ToolResult
	assert.equal(canToolResultAdvanceStep(step, failing).ok, false)
})
