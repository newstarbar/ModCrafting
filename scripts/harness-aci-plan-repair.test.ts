import test from 'node:test'
import assert from 'node:assert/strict'
import { FileSession } from '../src/renderer/src/harness/file-session.ts'
import { parseJsonPlanSteps } from '../src/renderer/src/harness/plan-compiler.ts'
import { validateCompiledSteps } from '../src/renderer/src/harness/plan-validator.ts'
import { isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import { canToolResultAdvanceStep } from '../src/renderer/src/harness/step-evidence.ts'
import { repairErrorSignature } from '../src/renderer/src/harness/workflow-engine.ts'
import { isActionablePlanText } from '../src/renderer/src/utils/plan-steps.ts'
import type { WorkflowStep } from '../src/renderer/src/harness/workflow-types.ts'

test('FileSession tracks read-before-edit paths', () => {
  const session = new FileSession()
  assert.equal(session.hasRead('src/Foo.java'), false)
  session.markRead('src\\Foo.java')
  assert.equal(session.hasRead('src/Foo.java'), true)
  assert.equal(session.hasRead('./src/Foo.java'), true)
  session.clear()
  assert.equal(session.hasRead('src/Foo.java'), false)
})

test('isActionablePlanText accepts JSON plans without numbered lines', () => {
  const text = JSON.stringify({
    steps: [
      {
        kind: 'write',
        description: '添加跳跃 Mixin',
        targetPath: 'src/main/java/com/example/JumpMixin.java',
        evidence: '类含 @Mixin LivingEntity'
      }
    ]
  })
  assert.equal(isActionablePlanText(text), true)
})

test('parseJsonPlanSteps preserves evidence field', () => {
  const text = `\`\`\`json
[
  {"kind":"write","description":"注册 Mixin","targetPath":"src/main/resources/m.mixins.json","evidence":"mixins.json 含 FooMixin"}
]
\`\`\``
  const steps = parseJsonPlanSteps(text)
  assert.ok(steps)
  assert.equal(steps![0].evidence, 'mixins.json 含 FooMixin')
})

test('plan-validator flags missing evidence on write steps', () => {
  const issues = validateCompiledSteps([
    { id: '1', description: '写文件', kind: 'write', targetPath: 'src/main/java/A.java' }
  ])
  assert.ok(issues.some((i) => i.field === 'evidence'))
})

test('repair mode allows edit_file on build steps', () => {
  const step: WorkflowStep = {
    id: '9',
    title: '构建项目',
    kind: 'build',
    status: 'running',
    allowedTools: ['trigger_build', 'read_error_log'],
    maxAttempts: 6
  }
  assert.equal(
    isToolAllowedForStep(step, { name: 'edit_file', args: { path: 'src/A.java' } }, undefined),
    false
  )
  assert.equal(
    isToolAllowedForStep(
      step,
      { name: 'edit_file', args: { path: 'src/A.java' } },
      { repairMode: true, repairWriteRequired: true }
    ),
    true
  )
})

test('inspect evidence accepts grep and fabric_docs_search', () => {
  const step = {
    id: '1',
    description: '确认 Yarn 签名',
    status: 'running' as const,
    kind: 'inspect' as const
  }
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: 'ok',
      ok: true,
      toolName: 'grep',
      durationMs: 1
    }).ok,
    true
  )
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: 'ok',
      ok: true,
      toolName: 'fabric_docs_search',
      durationMs: 1
    }).ok,
    true
  )
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: 'ok',
      ok: true,
      toolName: 'write_file',
      durationMs: 1
    }).ok,
    false
  )
})

test('write evidence requires targetPath match when set', () => {
  const step = {
    id: '1',
    description: '写 Handler',
    status: 'running' as const,
    kind: 'write' as const,
    targetPath: 'src/main/java/com/example/Handler.java'
  }
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: 'written',
      ok: true,
      toolName: 'edit_file',
      args: { path: 'src/main/java/com/example/Other.java' },
      artifactPath: 'src/main/java/com/example/Other.java',
      durationMs: 1
    }).ok,
    false
  )
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: 'written',
      ok: true,
      toolName: 'edit_file',
      args: { path: 'src/main/java/com/example/Handler.java' },
      artifactPath: 'src/main/java/com/example/Handler.java',
      durationMs: 1
    }).ok,
    true
  )
})

test('repairErrorSignature uses classifyFabricLog kind for MC logs', () => {
  const log = [
    'org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin apply failed',
    'at com.example.JumpMixin.handler(JumpMixin.java:42)',
    'Caused by: InvalidInjectionException'
  ].join('\n')
  const sig = repairErrorSignature(log, 'run')
  assert.match(sig, /^mixin-error\|/)
})

test('grep tool is registered via name contract in plan-readonly set (smoke)', async () => {
  // Lightweight: globToRegExp / FileSession used by grep-search; ensure module loads
  const { grepInProject } = await import('../src/renderer/src/harness/grep-search.ts')
  assert.equal(typeof grepInProject, 'function')
  const empty = await grepInProject({ projectPath: null, callId: 't' }, 'Foo')
  assert.match(empty, /No project open/)
})
