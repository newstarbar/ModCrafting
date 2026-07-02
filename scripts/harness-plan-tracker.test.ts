import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { canToolResultAdvanceStep, inferStepKind } from '../src/renderer/src/harness/step-evidence.ts'
import { buildShapelessRecipeContent, recipePath } from '../src/renderer/src/harness/recipe-utils.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import { filterToolCallsForStep } from '../src/renderer/src/harness/step-policy.ts'
import { WorkflowEngine } from '../src/renderer/src/harness/workflow-engine.ts'
import { Registry } from '../src/renderer/src/harness/tools.ts'
import type { ToolResult } from '../src/renderer/src/harness/tools.ts'

test('PlanTracker.advance rejects stale step ids without moving current step', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '读取 src/main/resources/fabric.mod.json - 获取模组 ID', status: 'running' },
    { id: '2', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'pending' },
    { id: '3', description: '运行 gradlew build 构建项目', status: 'pending' }
  ])

  assert.equal(tracker.advance('1').ok, true)
  assert.equal(tracker.currentStep?.id, '2')

  const stale = tracker.advance('1')

  assert.equal(stale.ok, false)
  assert.equal(tracker.currentStep?.id, '2')
  assert.equal(tracker.snapshot()[1].status, 'running')
  assert.equal(tracker.snapshot()[2].status, 'pending')
})

test('PlanTracker.advanceCurrent lets host advance the current step explicitly', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '读取 src/main/resources/fabric.mod.json - 获取模组 ID', status: 'running' },
    { id: '2', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'pending' }
  ])

  const result = tracker.advanceCurrent('read_file evidence')

  assert.equal(result.ok, true)
  assert.equal(tracker.currentStep?.id, '2')
})

test('inferStepKind classifies common harness plan steps', () => {
  assert.equal(inferStepKind('读取 src/main/resources/fabric.mod.json - 获取模组 ID'), 'inspect')
  assert.equal(inferStepKind('创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件'), 'write')
  assert.equal(inferStepKind('运行 gradlew build 构建项目'), 'build')
  assert.equal(inferStepKind('运行 runClient 启动游戏'), 'run')
  assert.equal(inferStepKind('输出总结'), 'unknown')
})

test('tool evidence advances only matching step kinds and paths', () => {
  const writeResult: ToolResult = {
    output: 'Written',
    durationMs: 1,
    ok: true,
    toolName: 'write_file',
    artifactPath: 'src/main/resources/data/my-mod/recipes/dirt_to_diamond.json',
    args: { path: 'src/main/resources/data/my-mod/recipes/dirt_to_diamond.json' }
  }
  const blockedRead: ToolResult = {
    output: 'blocked: [loop guard]',
    error: 'blocked: [loop guard]',
    durationMs: 0,
    ok: false,
    toolName: 'read_file',
    args: { path: 'src/main/resources/fabric.mod.json' }
  }
  const buildResult: ToolResult = {
    output: 'BUILD SUCCESSFUL',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    exitCode: 0,
    args: { task: 'build' }
  }

  assert.equal(
    canToolResultAdvanceStep(
      { id: '2', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'running' },
      writeResult
    ).ok,
    true
  )
  assert.equal(
    canToolResultAdvanceStep(
      { id: '2', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'running' },
      blockedRead
    ).ok,
    false
  )
  assert.equal(
    canToolResultAdvanceStep(
      { id: '3', description: '运行 gradlew build 构建项目', status: 'running' },
      buildResult
    ).ok,
    true
  )
  assert.equal(
    canToolResultAdvanceStep(
      { id: '3', description: '运行 gradlew build 构建项目', status: 'running' },
      writeResult
    ).ok,
    false
  )
})

test('recipe utility creates a four dirt to diamond shapeless recipe', () => {
  const content = buildShapelessRecipeContent({
    ingredients: [{ item: 'minecraft:dirt', count: 4 }],
    result: { item: 'minecraft:diamond', count: 1 }
  })
  const parsed = JSON.parse(content)

  assert.equal(recipePath('my-mod', 'dirt_to_diamond'), 'src/main/resources/data/my-mod/recipes/dirt_to_diamond.json')
  assert.equal(parsed.type, 'minecraft:crafting_shapeless')
  assert.equal(parsed.ingredients.length, 4)
  assert.deepEqual(parsed.ingredients, [
    { item: 'minecraft:dirt' },
    { item: 'minecraft:dirt' },
    { item: 'minecraft:dirt' },
    { item: 'minecraft:dirt' }
  ])
  assert.deepEqual(parsed.result, { item: 'minecraft:diamond', count: 1 })
})

test('step policy rejects create_recipe while current step is build', () => {
  const steps = normalizeWorkflowSteps([
    { id: '1', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'completed' },
    { id: '2', description: '运行 gradlew build 构建项目', status: 'running' }
  ])
  const decision = filterToolCallsForStep(steps[1], [
    { name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond' }, id: 'call_1' },
    { name: 'trigger_build', args: { task: 'build' }, id: 'call_2' }
  ])

  assert.equal(decision.allowed.length, 1)
  assert.equal(decision.allowed[0].name, 'trigger_build')
  assert.equal(decision.rejected.length, 1)
  assert.equal(decision.rejected[0].errorKind, 'tool_not_allowed')
})

test('workflow engine completes recipe step after first create_recipe and does not execute repeats', async () => {
  const registry = new Registry()
  const executed: string[] = []
  registry.add({
    name: 'create_recipe',
    description: 'create recipe',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      executed.push(`${args.namespace}/${args.name}`)
      return '✅ Recipe written: src/main/resources/data/my-mod/recipes/dirt_to_diamond.json (200 bytes)'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'running' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps)
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    onToolDispatch: () => {},
    onToolResult: () => {},
    modelCall: async () => ({
      finishReason: undefined,
      toolCalls: [
        { name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } },
        { name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } }
      ],
      text: '',
      reasoning: ''
    })
  })

  const result = await engine.run([])

  assert.equal(result.allDone, true)
  assert.equal(executed.length, 1)
  assert.equal(tracker.allDone(), true)
})
