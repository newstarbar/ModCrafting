import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import {
  resolveTurnIntent,
  buildSessionGoalBlock,
  isCodeExplainInput,
  isErrorReportInput
} from '../src/renderer/src/harness/turn-intent.ts'
import {
  compilePlanFromText,
  dropVagueSteps,
  isTemplateQuickCreateText,
  needsKnowledgeInspect,
  parseStructuredSteps
} from '../src/renderer/src/harness/plan-compiler.ts'
import { isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import type { WorkflowStep } from '../src/renderer/src/harness/workflow-types.ts'

function intentCtx(overrides: Partial<Parameters<typeof resolveTurnIntent>[1]> = {}) {
  return {
    phase: 'plan' as const,
    planTracker: null,
    hasProject: true,
    composerMode: 'agent' as const,
    ...overrides
  }
}

test('resolveTurnIntent: feature statement in agent mode → develop', () => {
  assert.equal(resolveTurnIntent('玩家可以进行二段跳', intentCtx()), 'develop')
})

test('resolveTurnIntent: question in agent mode stays read-only chat', () => {
  assert.equal(
    resolveTurnIntent('为什么这个 Mixin 不生效？', intentCtx({ composerMode: 'agent', hasProject: true })),
    'chat'
  )
})

test('resolveTurnIntent: same input in ask mode → chat', () => {
  assert.equal(resolveTurnIntent('玩家可以进行二段跳', intentCtx({ composerMode: 'ask' })), 'chat')
})

test('resolveTurnIntent: continue with incomplete plan → resume', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'running' },
    { id: '2', description: '构建', status: 'pending' }
  ])
  assert.equal(resolveTurnIntent('继续', intentCtx({ phase: 'execute', planTracker: tracker })), 'resume')
})

test('resolveTurnIntent: continue with plan candidate after plan_failed → resume', () => {
  assert.equal(
    resolveTurnIntent('继续', intentCtx({ phase: 'plan', planTracker: null, hasPlanCandidate: true })),
    'resume'
  )
  // No plan to resume: with a project open, prefer develop over silent chat.
  assert.equal(
    resolveTurnIntent('继续', intentCtx({ phase: 'plan', planTracker: null, hasPlanCandidate: false })),
    'develop'
  )
})

test('resolveTurnIntent: plan mode → plan_only', () => {
  assert.equal(resolveTurnIntent('添加二段跳', intentCtx({ composerMode: 'plan' })), 'plan_only')
})

test('resolveTurnIntent: what is mixin in ask → chat', () => {
  assert.equal(resolveTurnIntent('什么是 Mixin', intentCtx({ composerMode: 'ask' })), 'chat')
})

test('buildSessionGoalBlock includes goal text', () => {
  const block = buildSessionGoalBlock('为本模组添加二段跳')
  assert.match(block, /为本模组添加二段跳/)
  assert.match(block, /当前会话目标/)
})

test('compilePlanFromText: structured write steps append host terminal steps', () => {
  const text = `
1. [write] src/main/java/Example.java — 主类
2. [write] src/client/java/Client.java — 客户端
3. [write] src/main/java/Mixin.java — Mixin
`
  const compiled = compilePlanFromText(text)
  assert.ok(compiled.length >= 5)
  assert.ok(compiled.some((s) => /gradlew build/i.test(s.description)))
  assert.ok(compiled.some((s) => /runClient/i.test(s.description)))
})

test('resolveTurnIntent: code explain context → chat even with project', () => {
  const input = '--- 代码解释 ---\nFooItem (item)\n```java\nclass Foo {}\n```'
  assert.equal(resolveTurnIntent(input, intentCtx({ composerMode: 'agent' })), 'chat')
  assert.ok(isCodeExplainInput(input))
})

test('needsKnowledgeInspect: template quick create skips knowledge inspect', () => {
  const text = '我需要创建一个自定义方块模组，模板ID：custom-block。\n\n详细信息：\n硬度: 2'
  assert.ok(isTemplateQuickCreateText(text))
  const steps = parseStructuredSteps('1. [write] fabric_template_generate — 生成方块')
  assert.equal(needsKnowledgeInspect(steps, text), false)
})

test('compilePlanFromText: recipe-only plan skips knowledge inspect', () => {
  const text = '1. [recipe] data/mod/recipe/test.json — 测试配方'
  const steps = compilePlanFromText(text)
  assert.equal(needsKnowledgeInspect(parseStructuredSteps(text)), false)
  assert.ok(!steps[0].description.includes('fabric_docs_search'))
})

test('dropVagueSteps removes generic validation without path', () => {
  const filtered = dropVagueSteps([
    { id: '1', description: '确保编译通过' },
    { id: '2', description: '创建 src/main/java/Foo.java' }
  ])
  assert.equal(filtered.length, 1)
  assert.match(filtered[0].description, /Foo\.java/)
})

test('PlanTracker uses compiler terminal steps', () => {
  const tracker = PlanTracker.fromPlanText('1. [write] src/main/java/Foo.java — 主类')
  assert.ok(tracker.steps.length >= 3)
  assert.ok(tracker.steps.some((s) => /build/i.test(s.description)))
})

test('isErrorReportInput detects crash and build failures', () => {
  assert.ok(isErrorReportInput('--- 崩溃报告 ---\n---- Minecraft Crash Report ----\njava.lang.IllegalStateException'))
  assert.ok(isErrorReportInput('BUILD FAILED\nCompilation failed\nFoo.java:12: error: cannot find symbol'))
  assert.ok(isErrorReportInput('at knot//net.minecraft.client.gui.screen.Screen.render(Screen.java:1)'))
  assert.equal(isErrorReportInput('你好'), false)
  assert.equal(isErrorReportInput('为什么这个 Mixin 不生效？'), false)
})

test('resolveTurnIntent: crash report during execute → resume', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'completed' },
    { id: '2', description: '构建项目（gradlew build）', status: 'failed' },
    { id: '3', description: '启动游戏', status: 'pending' }
  ])
  const crash = `--- 崩溃报告 ---
---- Minecraft Crash Report ----
java.lang.IllegalStateException: setScreen on the wrong thread
	at knot//net.minecraft.client.gui.screen.Screen.ensureEventsAreInitialized(Screen.java:1347)`
  assert.equal(
    resolveTurnIntent(crash, intentCtx({ phase: 'execute', planTracker: tracker, composerMode: 'agent' })),
    'resume'
  )
})

test('resolveTurnIntent: BUILD FAILED with project and no plan → develop', () => {
  assert.equal(
    resolveTurnIntent(
      'BUILD FAILED\nsrc/main/java/Foo.java:10: error: cannot find symbol',
      intentCtx({ phase: 'plan', planTracker: null, hasProject: true })
    ),
    'develop'
  )
})

test('resolveTurnIntent: short greeting stays chat even with project', () => {
  assert.equal(resolveTurnIntent('谢谢', intentCtx({ hasProject: true })), 'chat')
  assert.equal(resolveTurnIntent('你好', intentCtx({ hasProject: true })), 'chat')
})

test('resolveTurnIntent: plain bug note with project → develop (not silent chat)', () => {
  assert.equal(
    resolveTurnIntent('F6后鼠标被强制做到屏幕中心，无法操作截图设置', intentCtx({ hasProject: true })),
    'develop'
  )
})

test('isToolAllowedForStep: delete_file allowed on build without repairMode', () => {
  const buildStep: WorkflowStep = {
    id: '6',
    title: '构建项目（gradlew build）',
    kind: 'build',
    status: 'pending',
    allowedTools: ['trigger_build', 'read_error_log'],
    maxAttempts: 3
  }
  assert.equal(
    isToolAllowedForStep(buildStep, {
      id: 'c1',
      name: 'delete_file',
      args: { path: 'src/main/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java' }
    }),
    true
  )
  assert.equal(
    isToolAllowedForStep(buildStep, {
      id: 'c2',
      name: 'delete_file',
      args: { path: 'src/main/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java' }
    }, { repairMode: false }),
    true
  )
})
