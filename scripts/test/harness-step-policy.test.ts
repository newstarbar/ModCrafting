import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRecipeInspectionPath,
  isProjectFileDeleteCommand,
  isRecipeCleanupCommand,
  isRepairWriteBlocked,
  isToolAllowedForStep,
  isToolSemanticallyAllowedForStep,
  filterToolCallsForStep,
  createRejectedToolResult,
  type ToolCallWithId,
  type ToolGateOptions
} from '../../src/renderer/src/harness/step-policy.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

// ─── helpers ───────────────────────────────────────────

function makeStep(overrides: Partial<WorkflowStep> & { id: string; kind: WorkflowStep['kind'] }): WorkflowStep {
  return {
    title: overrides.title ?? `Step ${overrides.id}`,
    status: 'running',
    allowedTools: overrides.allowedTools ?? [],
    maxAttempts: 3,
    ...overrides
  }
}

function makeCall(overrides: Partial<ToolCallWithId> & { name: string }): ToolCallWithId {
  return { args: {}, ...overrides }
}

// ─── isRecipeInspectionPath ─────────────────────────────

test('isRecipeInspectionPath allows fabric.mod.json at any depth', () => {
  assert.equal(isRecipeInspectionPath('src/main/resources/fabric.mod.json'), true)
  assert.equal(isRecipeInspectionPath('fabric.mod.json'), true)
  assert.equal(isRecipeInspectionPath('src\\main\\resources\\fabric.mod.json'), true)
})

test('isRecipeInspectionPath allows data namespace recipe paths', () => {
  assert.equal(isRecipeInspectionPath('data/example/recipes/copper_ingot.json'), true)
  assert.equal(isRecipeInspectionPath('src/main/resources/data/mymod/recipe/shaped.json'), true)
  assert.equal(isRecipeInspectionPath('data/test/recipe/nested.json'), true)
})

test('isRecipeInspectionPath rejects non-recipe paths', () => {
  assert.equal(isRecipeInspectionPath('src/main/java/Mod.java'), false)
  assert.equal(isRecipeInspectionPath('data/example/models/block.json'), false)
  assert.equal(isRecipeInspectionPath('README.md'), false)
})

// ─── isProjectFileDeleteCommand ─────────────────────────

test('isProjectFileDeleteCommand allows single file delete under src/', () => {
  assert.equal(isProjectFileDeleteCommand('rm src/main/java/Old.java'), true)
  assert.equal(isProjectFileDeleteCommand('del "src/main/resources/data.json"'), true)
  assert.equal(isProjectFileDeleteCommand("Remove-Item 'src/client/java/Client.java'"), true)
})

test('isProjectFileDeleteCommand rejects glob and recursive deletes', () => {
  assert.equal(isProjectFileDeleteCommand('rm -rf src/'), false)
  assert.equal(isProjectFileDeleteCommand('rm src/*.java'), false)
  assert.equal(isProjectFileDeleteCommand('rm src/?.java'), false)
  assert.equal(isProjectFileDeleteCommand('Remove-Item -Recurse src/'), false)
})

test('isProjectFileDeleteCommand rejects non-project paths', () => {
  assert.equal(isProjectFileDeleteCommand('rm C:/Windows/System32/file.dll'), false)
  assert.equal(isProjectFileDeleteCommand('rm /etc/passwd'), false)
  assert.equal(isProjectFileDeleteCommand('rm build/output.txt'), false)
})

test('isProjectFileDeleteCommand rejects empty and directory paths', () => {
  assert.equal(isProjectFileDeleteCommand(''), false)
  assert.equal(isProjectFileDeleteCommand('rm src/main/java/'), false)
})

// ─── isRecipeCleanupCommand ─────────────────────────────

test('isRecipeCleanupCommand allows single recipe JSON delete', () => {
  assert.equal(isRecipeCleanupCommand('rm data/example/recipes/old.json'), true)
  assert.equal(isRecipeCleanupCommand('del "data/mymod/recipe/shaped.json"'), true)
})

test('isRecipeCleanupCommand rejects non-recipe paths', () => {
  assert.equal(isRecipeCleanupCommand('rm src/main/java/Old.java'), false)
  assert.equal(isRecipeCleanupCommand('rm data/example/models/block.json'), false)
})

test('isRecipeCleanupCommand rejects glob patterns', () => {
  assert.equal(isRecipeCleanupCommand('rm data/example/recipes/*.json'), false)
})

// ─── isRepairWriteBlocked ───────────────────────────────

test('isRepairWriteBlocked returns false when repair mode is off', () => {
  const step = makeStep({ id: '1', kind: 'build' })
  const call = makeCall({ name: 'trigger_build' })
  assert.equal(isRepairWriteBlocked(step, call, {}), false)
  assert.equal(isRepairWriteBlocked(step, call, undefined), false)
})

test('isRepairWriteBlocked blocks trigger_build and run_command in build/run/game_test during repair', () => {
  const options: ToolGateOptions = { repairMode: true, repairWriteRequired: true }
  for (const kind of ['build', 'run', 'game_test'] as const) {
    const step = makeStep({ id: '1', kind })
    assert.equal(isRepairWriteBlocked(step, makeCall({ name: 'trigger_build' }), options), true)
    assert.equal(isRepairWriteBlocked(step, makeCall({ name: 'run_command' }), options), true)
  }
})

test('isRepairWriteBlocked does not block in write/recipe/mixin steps', () => {
  const options: ToolGateOptions = { repairMode: true, repairWriteRequired: true }
  for (const kind of ['write', 'recipe', 'mixin', 'inspect', 'answer'] as const) {
    const step = makeStep({ id: '1', kind })
    assert.equal(isRepairWriteBlocked(step, makeCall({ name: 'trigger_build' }), options), false)
  }
})

// ─── isToolAllowedForStep (core interaction paths) ──────

test('isToolAllowedForStep: write step allows write_file and edit_file', () => {
  const step = makeStep({ id: '1', kind: 'write', allowedTools: ['write_file', 'edit_file', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'write_file' })), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'edit_file' })), true)
})

test('isToolAllowedForStep: build step blocks write_file without repair mode', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['trigger_build', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'write_file' })), false)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'edit_file' })), false)
})

test('isToolAllowedForStep: build step allows write_file in repair mode', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['trigger_build', 'read_file'] })
  const opts: ToolGateOptions = { repairMode: true }
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'write_file' }), opts), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'edit_file' }), opts), true)
})

test('isToolAllowedForStep: build step allows trigger_build with task=build', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['trigger_build', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'trigger_build', args: { task: 'build' } })), true)
})

test('isToolAllowedForStep: build step rejects trigger_build with task=runClient', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['trigger_build', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'trigger_build', args: { task: 'runClient' } })), false)
})

test('isToolAllowedForStep: run step allows trigger_build with build or runClient', () => {
  const step = makeStep({ id: '1', kind: 'run', allowedTools: ['trigger_build', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'trigger_build', args: { task: 'build' } })), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'trigger_build', args: { task: 'runClient' } })), true)
})

test('isToolAllowedForStep: run step allows run_command with runClient', () => {
  const step = makeStep({ id: '1', kind: 'run', allowedTools: ['run_command', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'run_command', args: { command: 'gradlew runClient' } })), true)
})

test('isToolAllowedForStep: run step rejects run_command with arbitrary commands', () => {
  const step = makeStep({ id: '1', kind: 'run', allowedTools: ['run_command', 'read_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'run_command', args: { command: 'npm install' } })), false)
})

test('isToolAllowedForStep: build step allows gradle commands via run_command', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['run_command'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'run_command', args: { command: 'gradlew build' } })), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'run_command', args: { command: 'gradle build' } })), true)
})

test('isToolAllowedForStep: file inspection commands allowed in build/run steps', () => {
  const buildStep = makeStep({ id: '1', kind: 'build', allowedTools: ['run_command'] })
  const runStep = makeStep({ id: '2', kind: 'run', allowedTools: ['run_command'] })
  for (const cmd of ['dir', 'ls', 'cat build.log', 'type output.txt', 'Get-Content log.txt', 'Get-ChildItem', 'Test-Path file']) {
    assert.equal(isToolAllowedForStep(buildStep, makeCall({ name: 'run_command', args: { command: cmd } })), true, `build: ${cmd}`)
    assert.equal(isToolAllowedForStep(runStep, makeCall({ name: 'run_command', args: { command: cmd } })), true, `run: ${cmd}`)
  }
})

test('isToolAllowedForStep: recipe step restricts read_file to recipe inspection paths', () => {
  const step = makeStep({ id: '1', kind: 'recipe', allowedTools: ['read_file', 'fabric_recipe_generate'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'read_file', args: { path: 'data/mod/recipes/copper.json' } })), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'read_file', args: { path: 'src/main/java/Mod.java' } })), false)
})

test('isToolAllowedForStep: recipe step blocks write_file', () => {
  const step = makeStep({ id: '1', kind: 'recipe', allowedTools: ['write_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'write_file' })), false)
})

test('isToolAllowedForStep: mixin step allows write_file and edit_file', () => {
  const step = makeStep({ id: '1', kind: 'mixin', allowedTools: ['write_file', 'edit_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'write_file' })), true)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'edit_file' })), true)
})

test('isToolAllowedForStep: complete_step allowed in write/inspect steps via early return', () => {
  for (const kind of ['write', 'inspect'] as const) {
    const step = makeStep({ id: '1', kind, allowedTools: ['complete_step'] })
    assert.equal(isToolAllowedForStep(step, makeCall({ name: 'complete_step' })), true)
  }
})

test('isToolAllowedForStep: complete_step falls through to commandAllowedForStep default for terminal steps', () => {
  // When complete_step is in allowedTools for terminal steps, commandAllowedForStep
  // returns true by default (no explicit block). The workflow engine itself gates
  // auto-progression for build/run/game_test.
  for (const kind of ['build', 'run', 'game_test'] as const) {
    const step = makeStep({ id: '1', kind, allowedTools: ['complete_step'] })
    assert.equal(isToolAllowedForStep(step, makeCall({ name: 'complete_step' })), true)
  }
})

test('isToolAllowedForStep: mc_ tools only in run/game_test steps', () => {
  const runStep = makeStep({ id: '1', kind: 'run', allowedTools: ['mc_screenshot'] })
  const gameStep = makeStep({ id: '2', kind: 'game_test', allowedTools: ['mc_screenshot'] })
  const writeStep = makeStep({ id: '3', kind: 'write', allowedTools: ['mc_screenshot'] })
  // mc_screenshot passes the explicit-allowed check, but commandAllowedForStep
  // does not special-case it; it falls through to `return true`. The mc_ gate
  // is in isToolSemanticallyAllowedForStep.
  assert.equal(isToolAllowedForStep(runStep, makeCall({ name: 'mc_screenshot' })), true)
  assert.equal(isToolAllowedForStep(gameStep, makeCall({ name: 'mc_screenshot' })), true)
})

test('isToolAllowedForStep: knowledge tools allowed in write/recipe/mixin steps', () => {
  const writeStep = makeStep({ id: '1', kind: 'write', allowedTools: ['fabric_docs_search'] })
  assert.equal(isToolAllowedForStep(writeStep, makeCall({ name: 'fabric_docs_search' })), true)
})

test('isToolAllowedForStep: delete_file allowed in build/run steps', () => {
  const buildStep = makeStep({ id: '1', kind: 'build', allowedTools: ['delete_file'] })
  const runStep = makeStep({ id: '2', kind: 'run', allowedTools: ['delete_file'] })
  assert.equal(isToolAllowedForStep(buildStep, makeCall({ name: 'delete_file' })), true)
  assert.equal(isToolAllowedForStep(runStep, makeCall({ name: 'delete_file' })), true)
})

test('isToolAllowedForStep: delete_file in game_test requires repair mode', () => {
  const step = makeStep({ id: '1', kind: 'game_test', allowedTools: ['delete_file'] })
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'delete_file' })), false)
  assert.equal(isToolAllowedForStep(step, makeCall({ name: 'delete_file' }), { repairMode: true }), true)
})

// ─── isToolSemanticallyAllowedForStep ───────────────────

test('semantic gate: write_file blocked in build without repair', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: [] })
  assert.equal(isToolSemanticallyAllowedForStep(step, makeCall({ name: 'write_file' })), false)
  assert.equal(isToolSemanticallyAllowedForStep(step, makeCall({ name: 'write_file' }), { repairMode: true }), true)
})

test('semantic gate: mc_ tools only in run/game_test', () => {
  const runStep = makeStep({ id: '1', kind: 'run', allowedTools: [] })
  const writeStep = makeStep({ id: '2', kind: 'write', allowedTools: [] })
  assert.equal(isToolSemanticallyAllowedForStep(runStep, makeCall({ name: 'mc_screenshot' })), true)
  assert.equal(isToolSemanticallyAllowedForStep(writeStep, makeCall({ name: 'mc_screenshot' })), false)
})

test('semantic gate: fabric_recipe_generate only in recipe step', () => {
  const recipeStep = makeStep({ id: '1', kind: 'recipe', allowedTools: [] })
  const writeStep = makeStep({ id: '2', kind: 'write', allowedTools: [] })
  assert.equal(isToolSemanticallyAllowedForStep(recipeStep, makeCall({ name: 'fabric_recipe_generate' })), true)
  assert.equal(isToolSemanticallyAllowedForStep(writeStep, makeCall({ name: 'fabric_recipe_generate' })), false)
})

test('semantic gate: fabric_mixin_scaffold only in mixin step', () => {
  const mixinStep = makeStep({ id: '1', kind: 'mixin', allowedTools: [] })
  const writeStep = makeStep({ id: '2', kind: 'write', allowedTools: [] })
  assert.equal(isToolSemanticallyAllowedForStep(mixinStep, makeCall({ name: 'fabric_mixin_scaffold' })), true)
  assert.equal(isToolSemanticallyAllowedForStep(writeStep, makeCall({ name: 'fabric_mixin_scaffold' })), false)
})

test('semantic gate: trigger_build task routing matches build/run/game_test+repair', () => {
  const buildStep = makeStep({ id: '1', kind: 'build', allowedTools: [] })
  const runStep = makeStep({ id: '2', kind: 'run', allowedTools: [] })
  const gameStep = makeStep({ id: '3', kind: 'game_test', allowedTools: [] })
  assert.equal(isToolSemanticallyAllowedForStep(buildStep, makeCall({ name: 'trigger_build', args: { task: 'build' } })), true)
  assert.equal(isToolSemanticallyAllowedForStep(buildStep, makeCall({ name: 'trigger_build', args: { task: 'runClient' } })), false)
  assert.equal(isToolSemanticallyAllowedForStep(runStep, makeCall({ name: 'trigger_build', args: { task: 'runClient' } })), true)
  assert.equal(isToolSemanticallyAllowedForStep(gameStep, makeCall({ name: 'trigger_build', args: { task: 'build' } })), false)
  assert.equal(isToolSemanticallyAllowedForStep(gameStep, makeCall({ name: 'trigger_build', args: { task: 'build' } }), { repairMode: true }), true)
})

// ─── filterToolCallsForStep ─────────────────────────────

test('filterToolCallsForStep splits allowed and rejected calls', () => {
  const step = makeStep({ id: '1', kind: 'build', allowedTools: ['trigger_build', 'read_file'] })
  const calls = [
    makeCall({ name: 'trigger_build', args: { task: 'build' } }),
    makeCall({ name: 'write_file', args: { path: 'X.java', content: 'x' } }),
    makeCall({ name: 'read_file', args: { path: 'build.gradle' } })
  ]
  const result = filterToolCallsForStep(step, calls)
  assert.equal(result.allowed.length, 2)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].toolName, 'write_file')
  assert.equal(result.rejected[0].ok, false)
})

test('filterToolCallsForStep with empty calls returns empty arrays', () => {
  const step = makeStep({ id: '1', kind: 'write', allowedTools: ['read_file'] })
  const result = filterToolCallsForStep(step, [])
  assert.equal(result.allowed.length, 0)
  assert.equal(result.rejected.length, 0)
})

// ─── createRejectedToolResult ───────────────────────────

test('createRejectedToolResult includes step id and tool name', () => {
  const step = makeStep({ id: '42', kind: 'build', title: '构建项目' })
  const call = makeCall({ name: 'write_file' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /#42/)
  assert.match(result.output, /write_file/)
  assert.equal(result.errorKind, 'policy_deferred')
  assert.equal(result.ok, false)
})

test('createRejectedToolResult for complete_step in build step gives actionable hint', () => {
  const step = makeStep({ id: '5', kind: 'build', title: '构建' })
  const call = makeCall({ name: 'complete_step' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /trigger_build/)
})

test('createRejectedToolResult for complete_step in run step gives actionable hint', () => {
  const step = makeStep({ id: '6', kind: 'run', title: '运行' })
  const call = makeCall({ name: 'complete_step' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /mc_inspect|mc_screenshot/)
})

test('createRejectedToolResult for complete_step in game_test gives actionable hint', () => {
  const step = makeStep({ id: '7', kind: 'game_test', title: '测试' })
  const call = makeCall({ name: 'complete_step' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /mc_run_test/)
})

test('createRejectedToolResult for repair_write_blocked includes repair instruction', () => {
  const step = makeStep({ id: '8', kind: 'build', title: '修复构建' })
  const call = makeCall({ name: 'trigger_build' })
  const opts: ToolGateOptions = { repairMode: true, repairWriteRequired: true }
  const result = createRejectedToolResult(step, call, opts)
  assert.equal(result.errorKind, 'repair_write_required')
  assert.match(result.output, /修复模式/)
})

test('createRejectedToolResult for mc_ tools in non-run step hints game restriction', () => {
  const step = makeStep({ id: '9', kind: 'write', title: '写入' })
  const call = makeCall({ name: 'mc_screenshot' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /run\/game_test/)
})

test('createRejectedToolResult for recipe tools in non-recipe step hints recipe restriction', () => {
  const step = makeStep({ id: '10', kind: 'write', title: '写入' })
  const call = makeCall({ name: 'fabric_recipe_generate' })
  const result = createRejectedToolResult(step, call)
  assert.match(result.output, /recipe/)
})
