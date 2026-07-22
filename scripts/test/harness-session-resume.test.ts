import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreActivePlan, serializeDisplayMessages } from '../../src/renderer/src/utils/chat-persist.ts'
import { isResumeInput, resolveTurnIntent } from '../../src/renderer/src/harness/turn-intent.ts'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'

test('restoreActivePlan recovers incomplete plan from partial turnStatus', () => {
  const display = [
    {
      id: 'u1',
      role: 'user' as const,
      content: '做主菜单背景',
      timestamp: 1
    },
    {
      id: 'a1',
      role: 'assistant' as const,
      content: '执行中断',
      timestamp: 2,
      turnStatus: 'partial' as const,
      embeddedPlan: [
        { id: '1', description: '检查 Mixin', status: 'completed' as const },
        { id: '2', description: '扩展 ModConfig', status: 'error' as const },
        { id: '3', description: '创建 Handler', status: 'pending' as const }
      ]
    }
  ]
  const persisted = serializeDisplayMessages(display, null)
  const plan = restoreActivePlan(display, persisted)
  assert.ok(plan)
  assert.equal(plan!.anchorMsgId, 'a1')
  assert.equal(plan!.steps.length, 3)
  assert.equal(plan!.steps[1].status, 'error')
})

test('restoreActivePlan skips answered/completed turns', () => {
  const display = [
    {
      id: 'a1',
      role: 'assistant' as const,
      content: 'done',
      timestamp: 1,
      turnStatus: 'answered' as const,
      embeddedPlan: [
        { id: '1', description: '写文件', status: 'pending' as const }
      ]
    }
  ]
  const persisted = serializeDisplayMessages(display, null)
  assert.equal(restoreActivePlan(display, persisted), null)
})

test('isResumeInput accepts trailing punctuation', () => {
  assert.equal(isResumeInput('继续'), true)
  assert.equal(isResumeInput('继续。'), true)
  assert.equal(isResumeInput('继续！'), true)
  assert.equal(isResumeInput('请继续'), false)
})

test('resolveTurnIntent: 继续。 with incomplete plan → resume', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'running' },
    { id: '2', description: '构建', status: 'pending' }
  ])
  assert.equal(
    resolveTurnIntent('继续。', {
      phase: 'execute',
      planTracker: tracker,
      hasProject: true,
      composerMode: 'agent'
    }),
    'resume'
  )
})

test('PlanTracker.fromSteps treats error-like restore as first incomplete', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '检查', status: 'completed' },
    { id: '2', description: '扩展配置', status: 'pending' },
    { id: '3', description: '写 Handler', status: 'pending' }
  ])
  assert.equal(tracker.currentStep?.id, '2')
  assert.equal(tracker.allDone(), false)
})

test('hybrid write+mixins.json step stays write and keeps write_file', async () => {
  const { compilePlanFromText } = await import('../../src/renderer/src/harness/plan-compiler.ts')
  const { normalizeWorkflowSteps } = await import('../../src/renderer/src/harness/plan-normalizer.ts')
  const { isToolAllowedForStep } = await import('../../src/renderer/src/harness/step-policy.ts')

  const plan = JSON.stringify([
    {
      kind: 'write',
      description:
        '写入配置页面 ModConfigScreen.java；更新 Frame_coverClient.java；创建 frame-cover.mixins.json；更新 fabric.mod.json',
      targetPaths: [
        'src/client/java/com/example/frame_cover/config/ModConfigScreen.java',
        'src/client/java/com/example/frame_cover/Frame_coverClient.java',
        'src/main/resources/frame-cover.mixins.json',
        'src/main/resources/fabric.mod.json'
      ],
      evidence: 'ModConfigScreen 已创建'
    }
  ])
  const compiled = compilePlanFromText(plan)
  const hybrid = compiled.find((s) => /ModConfigScreen/.test(s.description))
  assert.ok(hybrid)
  assert.equal(hybrid!.kind, 'write')

  const [wf] = normalizeWorkflowSteps([{
    id: '7',
    description: hybrid!.description,
    status: 'running',
    kind: hybrid!.kind,
    targetPaths: hybrid!.targetPaths
  }])
  assert.equal(wf.kind, 'write')
  assert.equal(wf.allowedTools.includes('write_file'), true)
  assert.equal(
    isToolAllowedForStep(wf, {
      name: 'write_file',
      args: { path: 'src/client/java/com/example/frame_cover/config/ModConfigScreen.java', content: 'class X {}' }
    }),
    true
  )
})

test('persisted kind=mixin hybrid step is demoted to write on normalize (resume)', async () => {
  const { normalizeWorkflowSteps } = await import('../../src/renderer/src/harness/plan-normalizer.ts')
  const { isToolAllowedForStep } = await import('../../src/renderer/src/harness/step-policy.ts')
  const [wf] = normalizeWorkflowSteps([{
    id: '7',
    description:
      '写入配置页面 ModConfigScreen.java；更新 Frame_coverClient.java 注册按键；创建 frame-cover.mixins.json；更新 fabric.mod.json',
    status: 'error',
    kind: 'mixin',
    targetPaths: [
      'src/client/java/com/example/frame_cover/config/ModConfigScreen.java',
      'src/client/java/com/example/frame_cover/Frame_coverClient.java',
      'src/main/resources/frame-cover.mixins.json'
    ]
  }])
  assert.equal(wf.kind, 'write')
  assert.equal(wf.allowedTools.includes('write_file'), true)
  assert.equal(wf.allowedTools.includes('delete_file'), true)
  assert.equal(
    isToolAllowedForStep(wf, {
      name: 'write_file',
      args: { path: 'src/client/java/com/example/frame_cover/config/ModConfigScreen.java', content: 'class X {}' }
    }),
    true
  )
})

test('build step does not offer edit_file until repair (prevents edit loops)', async () => {
  const { normalizeWorkflowSteps } = await import('../../src/renderer/src/harness/plan-normalizer.ts')
  const { isToolAllowedForStep, createRejectedToolResult } = await import('../../src/renderer/src/harness/step-policy.ts')
  const [build] = normalizeWorkflowSteps([{
    id: '6',
    description: '构建项目（gradlew build）',
    status: 'running'
  }])
  assert.equal(build.kind, 'build')
  assert.equal(build.allowedTools.includes('edit_file'), false)
  assert.equal(build.allowedTools.includes('trigger_build'), true)
  assert.equal(
    isToolAllowedForStep(build, { name: 'edit_file', args: { path: 'src/A.java' } }),
    false
  )
  const rejected = createRejectedToolResult(build, { name: 'edit_file', args: { path: 'src/A.java' } })
  assert.match(rejected.output, /trigger_build/)
  assert.equal(
    isToolAllowedForStep(
      build,
      { name: 'edit_file', args: { path: 'src/A.java' } },
      { repairMode: true, repairWriteRequired: true }
    ),
    true
  )
})

test('pure Mixin java target still compiles as mixin', async () => {
  const { compilePlanFromText } = await import('../../src/renderer/src/harness/plan-compiler.ts')
  const compiled = compilePlanFromText(JSON.stringify([
    {
      kind: 'write',
      description: '编写 TitleScreenBackgroundMixin',
      targetPath: 'src/client/java/com/example/frame_cover/mixin/TitleScreenBackgroundMixin.java',
      evidence: 'validate'
    }
  ]))
  const step = compiled.find((s) => /TitleScreenBackgroundMixin/.test(s.description))
  assert.equal(step?.kind, 'mixin')
})

test('shouldShowPinnedPlan hides overlay after partial turn ends', async () => {
  const { shouldShowPinnedPlan } = await import('../../src/renderer/src/utils/plan-visibility.ts')
  const activePlan = {
    steps: [
      { id: '1', description: 'a', status: 'completed' as const },
      { id: '3', description: 'b', status: 'error' as const },
      { id: '4', description: 'c', status: 'pending' as const }
    ],
    anchorMsgId: 'a1',
    pinned: true
  }
  const messages = [
    {
      id: 'a1',
      role: 'assistant' as const,
      content: 'stopped',
      timestamp: 1,
      turnStatus: 'partial' as const,
      isStreaming: false,
      embeddedPlan: activePlan.steps
    }
  ]
  assert.equal(shouldShowPinnedPlan(activePlan, messages, false), false)
  assert.equal(
    shouldShowPinnedPlan(activePlan, [{ ...messages[0], turnStatus: undefined, isStreaming: true }], false),
    true
  )
  assert.equal(shouldShowPinnedPlan(activePlan, messages, true), true)
})
