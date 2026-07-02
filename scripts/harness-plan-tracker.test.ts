import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { canToolResultAdvanceStep, inferStepKind } from '../src/renderer/src/harness/step-evidence.ts'
import { buildShapelessRecipeContent, recipePath } from '../src/renderer/src/harness/recipe-utils.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import { filterToolCallsForStep, isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import { WorkflowEngine } from '../src/renderer/src/harness/workflow-engine.ts'
import { Registry } from '../src/renderer/src/harness/tools.ts'
import type { ToolResult } from '../src/renderer/src/harness/tools.ts'
import { ensureDevTerminalSteps, parsePlanSteps } from '../src/renderer/src/utils/plan-steps.ts'
import { finalizeTerminalSteps } from '../src/renderer/src/harness/finalize-terminal.ts'
import { registerPanelBridge } from '../src/renderer/src/utils/panel-bridge.ts'
import { EventKind } from '../src/renderer/src/harness/events.ts'

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

test('workflow normalizer treats reading fabric.mod.json as inspect, not write', () => {
  const steps = normalizeWorkflowSteps([
    { id: '1', description: '读取 fabric.mod.json 文件获取模组 ID（如 `my_mod`），用于确定资源路径', status: 'running' }
  ])

  assert.equal(steps[0].kind, 'inspect')
  assert.deepEqual(steps[0].allowedTools, ['read_file', 'list_directory'])
})

test('recipe step allows reading fabric.mod.json but still requires create_recipe to complete', () => {
  const [step] = normalizeWorkflowSteps([
    { id: '2', description: '创建配方 JSON 文件 `resources/data/<modid>/recipes/dirt_to_diamond.json`', status: 'running' }
  ])

  assert.equal(step.kind, 'recipe')
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/fabric.mod.json' } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/other.json' } }), false)
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

test('workflow engine permits mod id read during recipe step before create_recipe', async () => {
  const registry = new Registry()
  const executed: string[] = []
  registry.add({
    name: 'read_file',
    description: 'read file',
    schema: { type: 'object' },
    readOnly: () => true,
    async execute(_ctx, args) {
      executed.push(`read:${args.path}`)
      return '{"id":"my-mod"}'
    }
  })
  registry.add({
    name: 'create_recipe',
    description: 'create recipe',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      executed.push(`recipe:${args.namespace}/${args.name}`)
      return '✅ Recipe written: src/main/resources/data/my-mod/recipes/dirt_to_diamond.json (200 bytes)'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '创建配方 JSON 文件 `resources/data/<modid>/recipes/dirt_to_diamond.json`', status: 'running' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps)
  let call = 0
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    onToolDispatch: () => {},
    onToolResult: () => {},
    modelCall: async () => {
      call++
      return {
        finishReason: undefined,
        toolCalls: call === 1
          ? [{ name: 'read_file', args: { path: 'src/main/resources/fabric.mod.json' } }]
          : [{ name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } }],
        text: '',
        reasoning: ''
      }
    }
  })

  const result = await engine.run([])

  assert.equal(result.allDone, true)
  assert.deepEqual(executed, ['read:src/main/resources/fabric.mod.json', 'recipe:my-mod/dirt_to_diamond'])
})

test('ensureDevTerminalSteps appends build and run when missing from dev plan', () => {
  const steps = parsePlanSteps(`1. 创建 src/main/java/MyMod.java
2. 创建 fabric.mod.json`)
  const ensured = ensureDevTerminalSteps(steps)

  assert.equal(ensured.length, 4)
  assert.match(ensured[2].description, /构建/)
  assert.match(ensured[3].description, /启动游戏|runClient/i)
})

test('ensureDevTerminalSteps does not duplicate when build and run already exist', () => {
  const steps = parsePlanSteps(`1. 运行 gradlew build
2. 启动游戏 runClient`)
  const ensured = ensureDevTerminalSteps(steps)

  assert.equal(ensured.length, 2)
})

test('run step does not advance on trigger_build build task', () => {
  const buildOnly: ToolResult = {
    output: '构建已在右侧高级面板完成。[退出码: 0]',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    exitCode: 0,
    args: { task: 'build' }
  }
  const runOk: ToolResult = {
    output: '已在右侧游戏面板启动并进入游戏。[MC_PHASE:playing]',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    args: { task: 'runClient' },
    meta: { mcPhase: 'playing', runClientStarted: true }
  }

  assert.equal(
    canToolResultAdvanceStep(
      { id: '4', description: '启动游戏进行真实测试（runClient）', status: 'running' },
      buildOnly
    ).ok,
    false
  )
  assert.equal(
    canToolResultAdvanceStep(
      { id: '4', description: '启动游戏进行真实测试（runClient）', status: 'running' },
      runOk
    ).ok,
    true
  )
})

test('finalizeTerminalSteps runs host build and run via panel bridge', async () => {
  const calls: string[] = []
  registerPanelBridge({
    switchTab: () => {},
    runBuild: async () => {
      calls.push('build')
      return { ok: true, exitCode: 0, failed: false }
    },
    startGameAndWait: async () => {
      calls.push('run')
      return { ok: true, instanceId: 'mc-1', phase: 'playing' }
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '创建 MyMod.java', status: 'completed' },
    { id: '2', description: '构建项目（gradlew build）', status: 'pending' },
    { id: '3', description: '启动游戏进行真实测试（runClient）', status: 'pending' }
  ])
  tracker.currentIndex = 1
  tracker.steps[1].status = 'running'

  const events: string[] = []
  await finalizeTerminalSteps({
    planTracker: tracker,
    projectPath: 'D:/fake',
    emit: (event) => {
      if (event.kind === EventKind.PlanState) events.push('plan')
    }
  })

  registerPanelBridge(null)
  assert.deepEqual(calls, ['build', 'run'])
  assert.equal(tracker.allDone(), true)
  assert.ok(events.length >= 2)
})
