import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { canToolResultAdvanceStep, inferStepKind } from '../src/renderer/src/harness/step-evidence.ts'
import { buildShapelessRecipeContent, recipePath } from '../src/renderer/src/harness/recipe-utils.ts'
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
