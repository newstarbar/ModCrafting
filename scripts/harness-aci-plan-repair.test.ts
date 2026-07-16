import test from 'node:test'
import assert from 'node:assert/strict'
import { FileSession } from '../src/renderer/src/harness/file-session.ts'
import { compilePlanFromText, parseJsonPlanSteps } from '../src/renderer/src/harness/plan-compiler.ts'
import { validateCompiledSteps } from '../src/renderer/src/harness/plan-validator.ts'
import { isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import { canToolResultAdvanceStep, patternMatchesPath } from '../src/renderer/src/harness/step-evidence.ts'
import { inferToolError } from '../src/renderer/src/harness/tools.ts'
import {
  collectDiskWriteEvidence,
  repairErrorSignature,
  stepEvidenceSatisfied
} from '../src/renderer/src/harness/workflow-engine.ts'
import { isActionablePlanText } from '../src/renderer/src/utils/plan-steps.ts'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
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

test('compilePlanFromText fills default evidence so missing evidence does not block execute', () => {
  const plan = [
    '1. [write] 截图核心：ScreenshotHandler — `src/client/java/com/example/frame_cover/screenshot/ScreenshotHandler.java`',
    '2. [mixin] TitleScreen 背景 — `src/client/java/com/example/frame_cover/mixin/TitleScreenBackgroundMixin.java`'
  ].join('\n')
  assert.equal(isActionablePlanText(plan), true)
  const compiled = compilePlanFromText(plan)
  const userSteps = compiled.filter((s) => !s.hostManaged)
  assert.ok(userSteps.length >= 2)
  assert.ok(userSteps.every((s) => Boolean(s.evidence?.trim())))
  // After compile, validation must not hard-fail on evidence (controller only blocks description/kind/targetPath)
  const issues = PlanTracker.validationIssuesFromText(plan)
  assert.equal(issues.some((i) => i.field === 'evidence'), false)
  assert.equal(issues.some((i) => i.field === 'targetPath' || i.field === 'kind' || i.field === 'description'), false)
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

test('edit_file miss / gate outputs are treated as tool errors (not write evidence)', () => {
  const miss = 'Error: 未找到 old_string。文件 src/A.java 共 95 行。请用 read_file 查看后重试。'
  const multi = 'Error: old_string 匹配了多处（至少第 1 行和第 8 行，共 2 处）。请提供更多上下文'
  const gate = 'blocked: [edit_gate] unbalanced braces。编辑未落盘，请修正后重试。'
  assert.equal(inferToolError('edit_file', miss, null), miss)
  assert.equal(inferToolError('edit_file', multi, null), multi)
  assert.equal(inferToolError('edit_file', gate, null), gate)
  assert.equal(inferToolError('edit_file', '已编辑 src/A.java: 第 1 行已替换（+3 行）', null), undefined)

  const step = {
    id: '2',
    description: '扩展 ModConfig',
    status: 'running' as const,
    kind: 'write' as const,
    targetPath: 'src/main/java/com/example/frame_cover/config/ModConfig.java'
  }
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: miss,
      ok: false,
      error: miss,
      toolName: 'edit_file',
      args: { path: step.targetPath },
      artifactPath: step.targetPath,
      durationMs: 1
    }).ok,
    false
  )
  assert.equal(
    canToolResultAdvanceStep(step, {
      output: '已编辑 src/main/java/com/example/frame_cover/config/ModConfig.java: 第 37 行已替换（+4 行）',
      ok: true,
      toolName: 'edit_file',
      args: { path: step.targetPath },
      artifactPath: step.targetPath,
      durationMs: 1
    }).ok,
    true
  )
})

test('directory targetPath matches write_file children (trailing slash)', () => {
  const dir = 'src/main/java/com/example/frame_cover/config/'
  const file = 'src/main/java/com/example/frame_cover/config/ModConfig.java'
  assert.equal(patternMatchesPath(dir, file), true)
  assert.equal(patternMatchesPath(dir.replace(/\/$/, ''), file), true)
  assert.equal(
    patternMatchesPath(dir, 'src/main/java/com/example/frame_cover/other/X.java'),
    false
  )

  const step = {
    id: '2',
    description: '配置系统：ModConfig / ConfigManager',
    status: 'running' as const,
    kind: 'write' as const,
    targetPath: dir,
    targetPaths: [dir]
  }
  const writeResult = {
    output: 'written',
    ok: true,
    toolName: 'write_file' as const,
    args: { path: file },
    artifactPath: file,
    artifactPaths: [file],
    durationMs: 1
  }
  assert.equal(canToolResultAdvanceStep(step, writeResult).ok, true)
  assert.equal(stepEvidenceSatisfied(step as WorkflowStep, [writeResult]), true)
})

test('stepEvidenceSatisfied requires every concrete targetPaths entry', () => {
  const step = {
    id: '2',
    description: '写配置类',
    status: 'running' as const,
    kind: 'write' as const,
    targetPaths: [
      'src/main/java/com/example/frame_cover/config/ModConfig.java',
      'src/main/java/com/example/frame_cover/config/ConfigManager.java'
    ]
  } as WorkflowStep
  const oneFile = {
    output: 'written',
    ok: true,
    toolName: 'write_file',
    args: { path: 'src/main/java/com/example/frame_cover/config/ModConfig.java' },
    artifactPath: 'src/main/java/com/example/frame_cover/config/ModConfig.java',
    durationMs: 1
  }
  const both = {
    ...oneFile,
    artifactPaths: [
      'src/main/java/com/example/frame_cover/config/ModConfig.java',
      'src/main/java/com/example/frame_cover/config/ConfigManager.java'
    ]
  }
  assert.equal(stepEvidenceSatisfied(step, [oneFile]), false)
  assert.equal(stepEvidenceSatisfied(step, [both]), true)
})

test('collectDiskWriteEvidence prefills directory and file targets from disk', async () => {
  const files = new Map<string, string[]>([
    ['/proj/src/main/java/com/example/frame_cover/config', ['ModConfig.java', 'ConfigManager.java']]
  ])
  const probe = {
    async exists(absPath: string) {
      return absPath.endsWith('Handler.java')
    },
    async listDirectory(absPath: string) {
      const names = files.get(absPath.replace(/\\/g, '/')) || []
      return names.map((name) => ({ name, isDirectory: false }))
    }
  }

  const dirStep = {
    id: '2',
    title: '配置',
    description: '配置系统',
    status: 'running' as const,
    kind: 'write' as const,
    targetPath: 'src/main/java/com/example/frame_cover/config/',
    targetPaths: ['src/main/java/com/example/frame_cover/config/'],
    allowedTools: [] as string[],
    maxAttempts: 3
  } as WorkflowStep

  const dirEvidence = await collectDiskWriteEvidence('/proj', dirStep, probe)
  assert.equal(dirEvidence.length, 1)
  assert.deepEqual(dirEvidence[0].artifactPaths, [
    'src/main/java/com/example/frame_cover/config/ModConfig.java',
    'src/main/java/com/example/frame_cover/config/ConfigManager.java'
  ])
  assert.equal(stepEvidenceSatisfied(dirStep, dirEvidence), true)

  const fileStep = {
    ...dirStep,
    targetPath: 'src/main/java/com/example/Handler.java',
    targetPaths: ['src/main/java/com/example/Handler.java']
  } as WorkflowStep
  const fileEvidence = await collectDiskWriteEvidence('/proj', fileStep, probe)
  assert.equal(fileEvidence.length, 1)
  assert.equal(fileEvidence[0].artifactPath, 'src/main/java/com/example/Handler.java')
  assert.equal(stepEvidenceSatisfied(fileStep, fileEvidence), true)

  const missing = await collectDiskWriteEvidence('/proj', {
    ...fileStep,
    targetPath: 'src/main/java/com/example/Missing.java',
    targetPaths: ['src/main/java/com/example/Missing.java']
  } as WorkflowStep, probe)
  assert.equal(missing.length, 0)
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
