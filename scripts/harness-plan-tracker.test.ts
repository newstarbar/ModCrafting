import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { canToolResultAdvanceStep, inferStepKind } from '../src/renderer/src/harness/step-evidence.ts'
import { buildShapelessRecipeContent, recipePath } from '../src/renderer/src/harness/recipe-utils.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import { filterToolCallsForStep, isRecipeCleanupCommand, isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import { WorkflowEngine, isTerminalFailure, buildDocSearchBlockedResult, buildEmptyToolCallInstruction, detectExistingHandlerHint } from '../src/renderer/src/harness/workflow-engine.ts'
import { Registry } from '../src/renderer/src/harness/tools.ts'
import type { ToolResult } from '../src/renderer/src/harness/tools.ts'
import { buildFabricAgentPolicyPrompt, FABRIC_KNOWLEDGE_SOURCES } from '../src/renderer/src/harness/fabric-agent-policy.ts'
import { buildFabricDocsSearchSummary, hasHighConfidenceLocalHit, isNoisyYarnResult, resolveTopicRouteFiles } from '../src/renderer/src/harness/fabric-knowledge.ts'
import { buildRecipeContent } from '../src/renderer/src/harness/recipe-utils.ts'
import { classifyFabricLog, validateFabricModJsonContent } from '../src/renderer/src/harness/fabric-utils.ts'
import { generateBuildGradle, generateFabricModJson } from '../src/renderer/src/project/scaffold.ts'
import { ensureDevTerminalSteps, parsePlanSteps, planHasActionableSteps, selectVisiblePlanText, isActionablePlanText } from '../src/renderer/src/utils/plan-steps.ts'
import { resolveTurnDoneStatus } from '../src/renderer/src/utils/turn-status.ts'
import { needsKnowledgeInspect } from '../src/renderer/src/harness/plan-compiler.ts'
import { finalizeTerminalSteps } from '../src/renderer/src/harness/finalize-terminal.ts'
import { registerPanelBridge } from '../src/renderer/src/utils/panel-bridge.ts'
import { EventKind } from '../src/renderer/src/harness/events.ts'
import { isRepeatGuardedToolCall } from '../src/renderer/src/harness/repeat-guard.ts'

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
    result: { item: 'minecraft:diamond', count: 1 },
    mcVersion: '1.21.4'
  })
  const parsed = JSON.parse(content)

  assert.equal(recipePath('my-mod', 'dirt_to_diamond', '1.21.4'), 'src/main/resources/data/my-mod/recipe/dirt_to_diamond.json')
  assert.equal(parsed.type, 'minecraft:crafting_shapeless')
  assert.equal(parsed.ingredients.length, 4)
  assert.deepEqual(parsed.ingredients, [
    'minecraft:dirt',
    'minecraft:dirt',
    'minecraft:dirt',
    'minecraft:dirt'
  ])
  assert.deepEqual(parsed.result, { id: 'minecraft:diamond', count: 1 })
})

test('recipe utility uses legacy plural folder before MC 1.21', () => {
  assert.equal(recipePath('my-mod', 'dirt_to_diamond', '1.20.4'), 'src/main/resources/data/my-mod/recipes/dirt_to_diamond.json')
  const content = buildShapelessRecipeContent({
    ingredients: [{ item: 'minecraft:dirt', count: 1 }],
    result: { item: 'minecraft:diamond', count: 1 },
    mcVersion: '1.20.4'
  })
  const parsed = JSON.parse(content)
  assert.deepEqual(parsed.ingredients, [{ item: 'minecraft:dirt' }])
  assert.deepEqual(parsed.result, { item: 'minecraft:diamond', count: 1 })
})

test('write step allows readonly knowledge tools', () => {
  const [step] = normalizeWorkflowSteps([
    { id: '2', description: '创建 src/main/java/MyMod.java 主类', status: 'running' }
  ])
  assert.equal(step.kind, 'write')
  assert.equal(isToolAllowedForStep(step, { name: 'fabric_docs_search', args: { keyword: 'recipe' } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'fabric_meta_version_check', args: { mcVersion: '1.21.4' } }), true)
})

test('dev plan prepends knowledge inspect step', () => {
  const ensured = ensureDevTerminalSteps(parsePlanSteps(`1. 创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件`))
  assert.match(ensured[0].description, /知识库|fabric_docs_search/i)
  const steps = normalizeWorkflowSteps(ensured.map((s, i) => ({
    id: s.id,
    description: s.description,
    status: i === 0 ? 'running' as const : 'pending' as const
  })))
  assert.equal(steps[0].kind, 'inspect')
  assert.ok(steps[0].allowedTools.includes('fabric_docs_search'))
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
  assert.ok(steps[0].allowedTools.includes('read_file'))
  assert.ok(steps[0].allowedTools.includes('list_directory'))
  assert.ok(steps[0].allowedTools.includes('fabric_mod_json_validate'))
})

test('recipe step allows reading fabric.mod.json and recipe json but rejects unrelated files', () => {
  const [step] = normalizeWorkflowSteps([
    { id: '2', description: '创建配方 JSON 文件 `resources/data/<modid>/recipes/dirt_to_diamond.json`', status: 'running' }
  ])

  assert.equal(step.kind, 'recipe')
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/fabric.mod.json' } }), true)
  assert.equal(
    isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/data/my_mod/recipe/dirt_to_diamond.json' } }),
    true
  )
  assert.equal(
    isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/data/my-mod/recipe/dirt_to_diamond.json' } }),
    true
  )
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/other.json' } }), false)
})

test('recipe troubleshooting step allows reading recipe json for path or format diagnosis', () => {
  const [step] = normalizeWorkflowSteps([
    { id: '1', description: '配方文件路径或格式错误', status: 'running' }
  ])

  assert.equal(step.kind, 'recipe')
  assert.equal(
    isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/data/my_mod/recipe/dirt_to_diamond.json' } }),
    true
  )
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/resources/fabric.mod.json' } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'read_file', args: { path: 'src/main/java/MyMod.java' } }), false)
})

test('recipe step allows list_directory and recipe cleanup run_command', () => {
  const [step] = normalizeWorkflowSteps([
    { id: '3', description: '调整配方：删除旧路径残留文件', status: 'running' }
  ])

  assert.equal(step.kind, 'recipe')
  assert.ok(step.allowedTools.includes('list_directory'))
  assert.ok(step.allowedTools.includes('run_command'))
  assert.equal(isToolAllowedForStep(step, { name: 'list_directory', args: { path: 'src/main/resources/data/my_mod/recipes/' } }), true)
  assert.equal(
    isToolAllowedForStep(step, {
      name: 'run_command',
      args: { command: 'rm src/main/resources/data/my-mod/recipes/dirt_to_diamond.json' }
    }),
    true
  )
  assert.equal(
    isToolAllowedForStep(step, { name: 'run_command', args: { command: 'rm -rf src' } }),
    false
  )
})

test('isRecipeCleanupCommand allows single recipe json delete and rejects destructive patterns', () => {
  assert.equal(
    isRecipeCleanupCommand('rm src/main/resources/data/my-mod/recipes/dirt_to_diamond.json'),
    true
  )
  assert.equal(
    isRecipeCleanupCommand('del src/main/resources/data/my_mod/recipe/old.json'),
    true
  )
  assert.equal(isRecipeCleanupCommand('rm -rf src'), false)
  assert.equal(isRecipeCleanupCommand('rm src/main/resources/data/*/recipes/*.json'), false)
  assert.equal(isRecipeCleanupCommand('rm src/main/java/MyMod.java'), false)
})

test('combined build+run plan line splits into separate build and run workflow steps', () => {
  const steps = normalizeWorkflowSteps([
    {
      id: '4',
      description: '重新构建项目 (`trigger_build build`) 并启动游戏测试 (`trigger_build runClient`)',
      status: 'running'
    }
  ])

  assert.equal(steps.length, 2)
  assert.equal(steps[0].id, '1')
  assert.equal(steps[0].kind, 'build')
  assert.equal(steps[0].status, 'running')
  assert.equal(steps[1].id, '2')
  assert.equal(steps[1].kind, 'run')
  assert.equal(steps[1].status, 'pending')
  assert.ok(steps[0].allowedTools.includes('fabric_docs_search'))
  assert.ok(steps[0].allowedTools.includes('read_error_log'))
  assert.ok(steps[1].allowedTools.includes('fabric_log_debugger'))
})

test('build and run steps allow matching trigger_build tasks only', () => {
  const [buildStep, runStep] = normalizeWorkflowSteps([
    {
      id: '4',
      description: '重新构建项目并启动游戏测试（trigger_build build / runClient）',
      status: 'running'
    }
  ])

  assert.equal(
    isToolAllowedForStep(buildStep, { name: 'trigger_build', args: { task: 'build' } }),
    true
  )
  assert.equal(
    isToolAllowedForStep(buildStep, { name: 'trigger_build', args: { task: 'runClient' } }),
    false
  )
  assert.equal(
    isToolAllowedForStep(runStep, { name: 'trigger_build', args: { task: 'runClient' } }),
    true
  )
  assert.equal(
    isToolAllowedForStep(runStep, { name: 'trigger_build', args: { task: 'build' } }),
    false
  )
})

test('repair mode allows write_file on build step but not without repair flag', () => {
  const [buildStep] = normalizeWorkflowSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
  ])

  assert.equal(
    isToolAllowedForStep(buildStep, { name: 'write_file', args: { path: 'src/main/java/Fix.java', content: 'x' } }),
    false
  )
  assert.equal(
    isToolAllowedForStep(
      buildStep,
      { name: 'write_file', args: { path: 'src/main/java/Fix.java', content: 'x' } },
      { repairMode: true }
    ),
    true
  )
})

test('repair write gate blocks trigger_build until write_file', () => {
  const [buildStep] = normalizeWorkflowSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
  ])

  assert.equal(
    isToolAllowedForStep(
      buildStep,
      { name: 'trigger_build', args: { task: 'build' } },
      { repairMode: true, repairWriteRequired: true }
    ),
    false
  )
  assert.equal(
    isToolAllowedForStep(
      buildStep,
      { name: 'trigger_build', args: { task: 'build' } },
      { repairMode: true, repairWriteRequired: false }
    ),
    true
  )
  assert.equal(
    isToolAllowedForStep(
      buildStep,
      { name: 'write_file', args: { path: 'src/main/java/Fix.java', content: 'x' } },
      { repairMode: true, repairWriteRequired: true }
    ),
    true
  )
  assert.equal(
    isToolAllowedForStep(
      buildStep,
      { name: 'read_error_log', args: {} },
      { repairMode: true, repairWriteRequired: true }
    ),
    true
  )
})

test('isTerminalFailure detects build tool failures', () => {
  const [buildStep] = normalizeWorkflowSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
  ])
  const failed: ToolResult = {
    output: 'BUILD FAILED\nsymbol not found',
    error: 'BUILD FAILED\nsymbol not found',
    durationMs: 1,
    ok: false,
    toolName: 'trigger_build',
    args: { task: 'build' },
    exitCode: 1
  }
  const ok: ToolResult = {
    output: 'BUILD SUCCESSFUL',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    args: { task: 'build' },
    exitCode: 0
  }

  assert.equal(isTerminalFailure(buildStep, failed), true)
  assert.equal(isTerminalFailure(buildStep, ok), false)
})

test('workflow engine repairs after build failure then completes build step', async () => {
  const registry = new Registry()
  let buildCalls = 0
  registry.add({
    name: 'trigger_build',
    description: 'build',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      buildCalls++
      if (buildCalls === 1) return 'BUILD FAILED\nerror: symbol not found'
      return 'BUILD SUCCESSFUL\n[退出码: 0]'
    }
  })
  registry.add({
    name: 'write_file',
    description: 'write',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute() {
      return 'Written src/main/java/Fix.java (10 bytes)'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps)
  let round = 0
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    onToolDispatch: () => {},
    onToolResult: () => {},
    modelCall: async () => {
      round++
      if (round === 1) {
        return {
          finishReason: undefined,
          toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
          text: '',
          reasoning: ''
        }
      }
      if (round === 2) {
        return {
          finishReason: undefined,
          toolCalls: [{ name: 'write_file', args: { path: 'src/main/java/Fix.java', content: 'fix' } }],
          text: '',
          reasoning: ''
        }
      }
      return {
        finishReason: undefined,
        toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
        text: '',
        reasoning: ''
      }
    }
  })

  const result = await engine.run([])

  assert.equal(result.allDone, true)
  assert.equal(buildCalls, 2)
  assert.equal(tracker.allDone(), true)
})

test('workflow engine blocks rebuild in repair until write_file then succeeds', async () => {
  const registry = new Registry()
  let buildCalls = 0
  registry.add({
    name: 'trigger_build',
    description: 'build',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      buildCalls++
      if (buildCalls === 1) return 'BUILD FAILED\nerror: symbol not found'
      return 'BUILD SUCCESSFUL\n[退出码: 0]'
    }
  })
  registry.add({
    name: 'write_file',
    description: 'write',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute() {
      return 'Written src/main/java/Fix.java (10 bytes)'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps)
  let round = 0
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    onToolDispatch: () => {},
    onToolResult: () => {},
    modelCall: async () => {
      round++
      if (round === 1) {
        return {
          finishReason: undefined,
          toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
          text: '',
          reasoning: ''
        }
      }
      if (round === 2) {
        return {
          finishReason: undefined,
          toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
          text: '',
          reasoning: ''
        }
      }
      if (round === 3) {
        return {
          finishReason: undefined,
          toolCalls: [{ name: 'write_file', args: { path: 'src/main/java/Fix.java', content: 'fix' } }],
          text: '',
          reasoning: ''
        }
      }
      return {
        finishReason: undefined,
        toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
        text: '',
        reasoning: ''
      }
    }
  })

  const result = await engine.run([])

  assert.equal(result.allDone, true)
  assert.equal(buildCalls, 2)
  assert.equal(tracker.allDone(), true)
  assert.equal(round, 4)
})

test('workflow engine ends with friendly partial after repair rounds exhausted', async () => {
  const registry = new Registry()
  registry.add({
    name: 'trigger_build',
    description: 'build',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute() {
      return 'BUILD FAILED\npersistent error'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '构建项目（gradlew build）', status: 'running' }
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
      toolCalls: [{ name: 'trigger_build', args: { task: 'build' } }],
      text: '',
      reasoning: ''
    })
  })

  const result = await engine.run([])

  assert.equal(result.allDone, false)
  assert.equal(result.partial, true)
  assert.match(result.finalContent, /修复|BUILD FAILED|未能自动完成/)
})

test('workflow engine completes recipe step only after evidence-backed complete_step', async () => {
  const registry = new Registry()
  const executed: string[] = []
  registry.add({
    name: 'create_recipe',
    description: 'create recipe',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      executed.push(`${args.namespace}/${args.name}`)
      return {
        output: '✅ Recipe validated: src/main/resources/data/my-mod/recipe/dirt_to_diamond.json',
        artifactPaths: ['src/main/resources/data/my-mod/recipe/dirt_to_diamond.json'],
        validation: { kind: 'recipe' as const, valid: true, version: '1.21.4' as const, checkedAt: 1 }
      }
    }
  })
  registry.add({
    name: 'complete_step',
    description: 'complete step',
    schema: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
    readOnly: () => false,
    async execute() { return '[STEP_COMPLETE_REQUEST:1]' }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '创建 data/<modid>/recipes/dirt_to_diamond.json 配方文件', status: 'running' }
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
          ? [
              { name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } },
              { name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } }
            ]
          : [{ name: 'complete_step', args: { stepId: '1' } }],
        text: '',
        reasoning: ''
      }
    }
  })

  const result = await engine.run([])

  assert.equal(result.allDone, true)
  assert.equal(executed.length, 2)
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
    name: 'complete_step',
    description: 'complete step',
    schema: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
    readOnly: () => false,
    async execute() { return '[STEP_COMPLETE_REQUEST:1]' }
  })
  registry.add({
    name: 'create_recipe',
    description: 'create recipe',
    schema: { type: 'object' },
    readOnly: () => false,
    async execute(_ctx, args) {
      executed.push(`recipe:${args.namespace}/${args.name}`)
      return {
        output: '✅ Recipe validated: src/main/resources/data/my-mod/recipe/dirt_to_diamond.json',
        artifactPaths: ['src/main/resources/data/my-mod/recipe/dirt_to_diamond.json'],
        validation: { kind: 'recipe' as const, valid: true, version: '1.21.4' as const, checkedAt: 1 }
      }
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
          : call === 2
            ? [{ name: 'create_recipe', args: { namespace: 'my-mod', name: 'dirt_to_diamond', ingredients: [{ item: 'minecraft:dirt', count: 4 }], result: 'minecraft:diamond' } }]
            : [{ name: 'complete_step', args: { stepId: '1' } }],
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

  assert.equal(ensured.length, 5)
  assert.match(ensured[0].description, /知识库|fabric_docs_search/i)
  assert.match(ensured[3].description, /构建/)
  assert.match(ensured[4].description, /启动游戏|runClient/i)
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
    output: '游戏已进入主菜单并完成稳定观察。[MC_PHASE:ready]',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    args: { task: 'runClient' },
    meta: { mcPhase: 'ready', runClientStarted: true }
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
      return { ok: true, instanceId: 'mc-1', phase: 'ready' }
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

test('fabric agent policy is product focused and includes Fabric guardrails', () => {
  const prompt = buildFabricAgentPolicyPrompt('execute')

  assert.match(prompt, /优先使用 Fabric API/)
  assert.match(prompt, /客户端\/服务端/)
  assert.match(prompt, /DataGen/)
  assert.doesNotMatch(prompt, /Cursor 配置/)
})

test('fabric knowledge sources include authoritative URLs for product runtime lookup', () => {
  const urls = FABRIC_KNOWLEDGE_SOURCES.map((source) => source.url)

  assert.ok(urls.includes('https://docs.fabricmc.net/zh_cn/develop/'))
  assert.ok(urls.includes('https://meta.fabricmc.net/'))
  assert.ok(urls.includes('https://minecraft.wiki/api.php'))
})

test('fabric docs search summary returns source URLs and keyword matches without writing files', async () => {
  const summary = await buildFabricDocsSearchSummary({ keyword: '方块实体', mcVersion: '1.21.4', limit: 3 })

  assert.match(summary, /方块实体/)
  assert.match(summary, /版本：1\.21\.4/)
})

test('topic routing maps CustomPayload queries to networking knowledge files', () => {
  const files = resolveTopicRouteFiles('CustomPayload ServerPlayNetworking C2S 1.21.4')
  assert.ok(files.includes('fabric/docs/networking.md'))
  assert.ok(files.includes('fabric/networking-snippets.md'))
})

test('topic routing maps player interact queries to events knowledge files', () => {
  const files = resolveTopicRouteFiles('UseBlockCallback 空手 右键')
  assert.ok(files.includes('fabric/docs/events.md'))
  assert.ok(files.includes('fabric/api-aliases.md'))
})

test('networking-snippets stays generic without session-specific player interact tuning', () => {
  const snippetsPath = path.join(process.cwd(), 'resources/agent-knowledge/fabric/networking-snippets.md')
  const aliasesPath = path.join(process.cwd(), 'resources/agent-knowledge/fabric/api-aliases.md')
  const snippets = fs.readFileSync(snippetsPath, 'utf-8')
  const aliases = fs.readFileSync(aliasesPath, 'utf-8')

  assert.doesNotMatch(snippets, /空手右键/)
  assert.doesNotMatch(snippets, /EggThrow/)
  assert.match(snippets, /ExampleC2SPayload/)
  assert.doesNotMatch(aliases, /玩家交互事件速查/)
})

test('bundled fabric knowledge is curated and excludes removed meta files', () => {
  const fabricRoot = path.join(process.cwd(), 'resources/agent-knowledge/fabric')
  const mdFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) mdFiles.push(path.relative(fabricRoot, full).replace(/\\/g, '/'))
    }
  }
  walk(fabricRoot)

  assert.ok(mdFiles.length <= 15, `expected ≤15 bundled markdown files, got ${mdFiles.length}: ${mdFiles.join(', ')}`)
  assert.ok(!mdFiles.includes('policies.md'))
  assert.ok(!mdFiles.includes('workflows.md'))
  assert.ok(!mdFiles.includes('templates.md'))
  assert.ok(!mdFiles.includes('sources.md'))
  assert.ok(!mdFiles.includes('yarn-reference.md'))
  assert.ok(mdFiles.includes('yarn-gotchas.md'))
  assert.ok(mdFiles.includes('networking-snippets.md'))
  assert.ok(mdFiles.includes('api-aliases.md'))
})

test('selectVisiblePlanText ignores reasoning numbered lists', () => {
  const reasoning = [
    '1. 监听 UseItemCallback，检查玩家是否空手',
    '2. 创建事件监听类',
    '3. 查阅 Fabric API 文档'
  ].join('\n')
  const visible = '我来先查看项目现有结构，再制定计划。'
  const selected = selectVisiblePlanText(visible, visible)
  assert.doesNotMatch(selected, /UseItemCallback/)
  assert.equal(parsePlanSteps(selected).length, 0)
  assert.equal(parsePlanSteps(reasoning).length, 3)
})

test('isActionablePlanText rejects reasoning-only plans without file paths', () => {
  const reasoningPlan = [
    '1. 玩家空手右键时投掷 EggEntity',
    '2. 创建事件监听类，注册 UseItemCallback',
    '3. 查阅 Fabric API 文档确认 UseItemCallback 的使用方式'
  ].join('\n')
  assert.equal(planHasActionableSteps(reasoningPlan), true)
  assert.equal(isActionablePlanText(reasoningPlan), false)
})

test('resolveTurnDoneStatus uses answered not partial when plan_failed', () => {
  const pendingSteps = [{ id: '1', description: 'fake step', status: 'pending' as const }]
  assert.equal(
    resolveTurnDoneStatus({
      hasError: false,
      finalSteps: pendingSteps,
      composerMode: 'agent',
      phase: 'plan_failed'
    }),
    'answered'
  )
  assert.equal(
    resolveTurnDoneStatus({
      hasError: false,
      finalSteps: pendingSteps,
      composerMode: 'agent'
    }),
    'partial'
  )
})

test('actionable plan with file paths passes isActionablePlanText', () => {
  const plan = [
    '1. [write] src/main/java/com/example/my_mod/EggThrowHandler.java — 空手右键投掷鸡蛋',
    '2. [write] src/main/java/com/example/my_mod/MyMod.java — 注册事件监听'
  ].join('\n')
  assert.equal(isActionablePlanText(plan), true)
  assert.equal(selectVisiblePlanText('', plan), plan)
})

test('hasHighConfidenceLocalHit prefers routed snippets over noisy yarn counts', () => {
  const noisyYarn = '[Yarn 映射 1613 个类命中，显示前 4 个]\n📦 ItemStack'
  const routed = '[主题路由 · networking-snippets.md]\n```java\nServerPlayNetworking.registerGlobalReceiver\n```'
  assert.equal(isNoisyYarnResult(noisyYarn), true)
  assert.equal(hasHighConfidenceLocalHit(routed, '', noisyYarn), true)
  assert.equal(hasHighConfidenceLocalHit('', '', noisyYarn), false)
})

test('write workflow step allows more attempts after search-heavy flows', () => {
  const steps = normalizeWorkflowSteps([
    { id: '1', description: 'src/main/java/com/example/Foo.java — 写入处理类', status: 'running' }
  ])
  assert.equal(steps[0].maxAttempts, 4)
})

test('doc search block message appears after write-step search limit', () => {
  const step = normalizeWorkflowSteps([
    { id: '1', description: 'src/main/java/com/example/Foo.java — 写入处理类', status: 'running' }
  ])[0]
  const blocked = buildDocSearchBlockedResult(step, { name: 'fabric_docs_search', args: { keyword: 'CustomPayload' } })
  assert.match(blocked.output, /doc_search_limit/)
  assert.match(blocked.output, /edit_file/)
})

test('empty tool call instruction names write_file target path', () => {
  const step = normalizeWorkflowSteps([
    { id: '1', description: 'src/main/java/com/example/network/Payload.java — 定义载荷', status: 'running' }
  ])[0]
  const instruction = buildEmptyToolCallInstruction(step)
  assert.match(instruction, /edit_file\("src\/main\/java\/com\/example\/network\/Payload\.java"/)
  assert.match(instruction, /complete_step/)
})

test('detectExistingHandlerHint triggers when reading unrelated handler source', () => {
  const step = normalizeWorkflowSteps([
    { id: '1', description: 'src/main/java/com/example/network/Payload.java — 定义载荷', status: 'running' }
  ])[0]
  const hint = detectExistingHandlerHint(step, {
    toolName: 'read_file',
    ok: true,
    output: 'UseBlockCallback.EVENT.register((player, world, hand, hitResult) -> ActionResult.SUCCESS);',
    args: { path: 'src/main/java/com/example/my_mod/EggThrowHandler.java' },
    durationMs: 1
  })
  assert.match(hint || '', /已有实现/)
  assert.match(hint || '', /complete_step/)
})

test('needsKnowledgeInspect includes player interaction keywords', () => {
  assert.equal(
    needsKnowledgeInspect([{ id: '1', description: 'src/client/java/com/example/ClientHandler.java — 检测右键', status: 'pending' }]),
    true
  )
})

test('workflow normalizer classifies FrameCapture write step despite 读取 in title', () => {
  const [step] = normalizeWorkflowSteps([
    {
      id: '2',
      description:
        'src/main/java/com/example/framecover/FrameCapture.java — 截图捕获工具类：读取当前帧缓冲，保存为 PNG 到 config/framecover/background.png',
      status: 'pending',
      kind: 'write'
    }
  ])
  assert.equal(step.kind, 'write')
  assert.ok(step.allowedTools.includes('write_file'))
  assert.ok(step.allowedTools.includes('delete_file'))
})

test('workflow normalizer preserves explicit inspect kind from plan compile', () => {
  const [step] = normalizeWorkflowSteps([
    {
      id: '1',
      description: '查询知识库确认当前 Minecraft/Fabric 版本 API 与资源格式（fabric_docs_search / fabric_meta_version_check）',
      status: 'pending',
      kind: 'inspect'
    }
  ])
  assert.equal(step.kind, 'inspect')
})

test('workflow normalizer allows product Fabric specialist tools for matching steps', () => {
  const steps = normalizeWorkflowSteps([
    { id: '1', description: '查询 Fabric 文档确认方块实体 API', status: 'running' },
    { id: '2', description: '生成有序合成配方', status: 'pending' },
    { id: '3', description: '校验 fabric.mod.json 配置', status: 'pending' }
  ])

  assert.equal(steps[0].kind, 'inspect')
  assert.ok(steps[0].allowedTools.includes('fabric_docs_search'))
  assert.equal(steps[1].kind, 'recipe')
  assert.ok(steps[1].allowedTools.includes('fabric_recipe_generate'))
  assert.equal(steps[2].kind, 'inspect')
  assert.ok(steps[2].allowedTools.includes('fabric_mod_json_validate'))
})

test('fabric recipe generator supports shaped crafting recipes', () => {
  const content = buildRecipeContent({
    type: 'shaped',
    pattern: ['##', ' S'],
    keys: {
      '#': { item: 'minecraft:cobblestone' },
      S: { item: 'minecraft:stick' }
    },
    result: { item: 'minecraft:stone_axe', count: 1 }
  })
  const parsed = JSON.parse(content)

  assert.equal(parsed.type, 'minecraft:crafting_shaped')
  assert.deepEqual(parsed.pattern, ['##', ' S'])
  assert.equal(parsed.key['#'], 'minecraft:cobblestone')
  assert.equal(parsed.key.S, 'minecraft:stick')
  assert.deepEqual(parsed.result, { id: 'minecraft:stone_axe', count: 1 })
})

test('fabric.mod.json validator reports missing icon and invalid entrypoints', () => {
  const result = validateFabricModJsonContent(JSON.stringify({
    schemaVersion: 1,
    id: 'bad mod',
    version: '${version}',
    name: 'Bad Mod',
    icon: 'icon.png',
    entrypoints: { main: [] },
    depends: { minecraft: '~1.21.4', java: '>=21' }
  }))

  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => /id/.test(issue)))
  assert.ok(result.issues.some((issue) => /entrypoints\.main/.test(issue)))
  assert.ok(result.warnings.some((warning) => /icon/.test(warning)))
})

test('fabric log classifier recognizes mixin and client-server classloading errors', () => {
  const mixin = classifyFabricLog('org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException')
  const side = classifyFabricLog('java.lang.RuntimeException: Attempted to load class net/minecraft/client/render/Screen for invalid dist DEDICATED_SERVER')

  assert.equal(mixin.kind, 'mixin-error')
  assert.equal(side.kind, 'side-error')
})

test('repeat guard does not block trigger_build or build-like run_command', () => {
  assert.equal(isRepeatGuardedToolCall('trigger_build', { task: 'build' }), false)
  assert.equal(isRepeatGuardedToolCall('trigger_build', { task: 'runClient' }), false)
  assert.equal(isRepeatGuardedToolCall('trigger_build', { task: 'runDatagen' }), false)
  assert.equal(isRepeatGuardedToolCall('run_command', { command: 'gradlew build' }), false)
  assert.equal(isRepeatGuardedToolCall('run_command', { command: './gradlew runClient' }), false)
})

test('repeat guard still blocks exploratory read_file and generic run_command', () => {
  assert.equal(isRepeatGuardedToolCall('read_file', { path: 'src/main/resources/fabric.mod.json' }), true)
  assert.equal(isRepeatGuardedToolCall('list_directory', { path: 'src' }), true)
  assert.equal(isRepeatGuardedToolCall('write_file', { path: 'foo.java', content: 'x' }), true)
  assert.equal(isRepeatGuardedToolCall('run_command', { command: 'dir' }), true)
})

test('scaffold build.gradle includes datagen run configuration and fabric.mod.json keeps Fabric constraints', () => {
  const versions = {
    minecraft_version: '1.21.4',
    loader_version: '0.16.10',
    fabric_version: '0.116.0+1.21.4',
    yarn_mappings: '1.21.4+build.1',
    loom_version: '1.17.12',
    gradle_version: '9.5.0'
  }
  const config = {
    projectDir: 'D:/fake',
    folderName: 'my-mod',
    displayName: 'My Mod',
    modId: 'my-mod',
    groupId: 'com.example',
    javaPackage: 'mymod',
    authors: 'ModCrafting',
    description: 'Test mod',
    modVersion: '1.0.0',
    versions
  }
  const buildGradle = generateBuildGradle(config)
  const modJson = JSON.parse(generateFabricModJson(config))

  assert.match(buildGradle, /runDatagen/)
  assert.match(buildGradle, /DataGen/)
  assert.equal(modJson.depends.java, '>=21')
  assert.deepEqual(modJson.mixins, [])
})

test('appendToolRoundHistory writes paired assistant.tool_calls and role:tool messages', async () => {
  const { appendToolRoundHistory } = await import('../src/renderer/src/harness/chat-message.ts')

  const messages: Array<Record<string, unknown>> = []
  const calls = [{
    id: 'call_abc',
    name: 'list_directory',
    args: { path: 'src' },
    rawArguments: '{"path":"src"}'
  }]
  const results = new Map([['call_abc', { output: 'src/main/java\nsrc/main/resources' }]])

  appendToolRoundHistory(messages as never, '', calls, results, '[SYSTEM: 继续下一步]')

  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, 'assistant')
  assert.deepEqual((messages[0].tool_calls as Array<{ id: string }>).map((tc) => tc.id), ['call_abc'])
  assert.equal(messages[1].role, 'tool')
  assert.equal(messages[1].tool_call_id, 'call_abc')
  assert.equal(messages[1].name, 'list_directory')
  assert.match(String(messages[1].content), /src\/main\/java/)
  assert.equal(messages[2].role, 'system')
  assert.match(String(messages[2].content), /继续下一步/)
})

test('isRetryableFetchError detects transient network failures', async () => {
  const { isRetryableFetchError } = await import('../src/renderer/src/harness/fetch-retry.ts')
  assert.equal(isRetryableFetchError(new Error('Failed to fetch')), true)
  assert.equal(isRetryableFetchError(new Error('API error 503: gateway')), true)
  assert.equal(isRetryableFetchError(new DOMException('Aborted', 'AbortError')), false)
  assert.equal(isRetryableFetchError(new Error('API error 401: unauthorized')), false)
})

test('workflow engine returns partial result after model network failure', async () => {
  const registry = new Registry()
  registry.add({
    name: 'read_file',
    description: 'read',
    schema: { type: 'object' },
    readOnly: () => true,
    async execute() {
      return 'file content'
    }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '读取 gradle.properties', status: 'running' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps)
  let calls = 0
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    onToolDispatch: () => {},
    onToolResult: () => {},
    modelCall: async () => {
      calls++
      if (calls <= 3) throw new Error('Failed to fetch')
      return {
        finishReason: undefined,
        toolCalls: [{ name: 'read_file', args: { path: 'gradle.properties' } }],
        text: '',
        reasoning: ''
      }
    }
  })

  const result = await engine.run([])

  assert.equal(result.partial, true)
  assert.equal(result.allDone, false)
  assert.match(result.finalContent, /网络错误中断/)
  assert.equal(tracker.allDone(), false)
})

test('normalizeSessionUsage fills defaults and clears turn-level fields', async () => {
  const { normalizeSessionUsage } = await import('../src/renderer/src/utils/usage.ts')

  const restored = normalizeSessionUsage({
    sessionTokens: 12_000,
    cacheHitTokens: 8000,
    cacheMissTokens: 2000,
    turns: 3,
    lastPromptTokens: 64_000,
    cost: 0.045,
    turnTokens: 999,
    turnCacheHitTokens: 111,
    turnCacheMissTokens: 222
  }, 'deepseek-v4-flash')

  assert.equal(restored.sessionTokens, 12_000)
  assert.equal(restored.cost, 0.045)
  assert.equal(restored.turnTokens, 0)
  assert.equal(restored.turnCacheHitTokens, 0)
  assert.equal(restored.turnCacheMissTokens, 0)
  assert.equal(restored.lastPromptTokens, 64_000)
  assert.ok(restored.contextPercent > 0)
})

test('normalizeSessionUsage returns empty usage for missing input', async () => {
  const { normalizeSessionUsage, EMPTY_USAGE } = await import('../src/renderer/src/utils/usage.ts')
  const restored = normalizeSessionUsage(undefined)
  assert.deepEqual(restored, EMPTY_USAGE)
})

test('session storage round-trips usage stats', async () => {
  const { saveSessions, loadSessions } = await import('../src/renderer/src/utils/session-storage.ts')
  const store: Record<string, string> = {}
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] }
    }
  })
  try {
    const projectPath = 'D:/test-project'
    saveSessions(projectPath, [{
      id: 'session-1',
      name: 'Test',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      usage: {
        sessionTokens: 5000,
        turnTokens: 0,
        cacheHitTokens: 3000,
        cacheMissTokens: 1000,
        turnCacheHitTokens: 0,
        turnCacheMissTokens: 0,
        turns: 2,
        contextPercent: 4,
        lastPromptTokens: 5000,
        cost: 0.0123
      }
    }])
    const loaded = loadSessions(projectPath)
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.usage?.sessionTokens, 5000)
    assert.equal(loaded[0]?.usage?.cost, 0.0123)
    assert.equal(loaded[0]?.usage?.cacheHitTokens, 3000)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
  }
})
