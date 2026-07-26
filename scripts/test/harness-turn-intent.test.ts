import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import {
  buildSessionGoalBlock,
  isCodeExplainInput,
  isStructuralErrorReport,
  isNarrowResumeInput,
  buildUserSymptomBlock,
  buildCrossTurnDiagnosisRetain
} from '../../src/renderer/src/harness/turn-intent.ts'
import {
  compilePlanFromText,
  dropVagueSteps,
  isTemplateQuickCreateText,
  needsKnowledgeInspect,
  parseStructuredSteps
} from '../../src/renderer/src/harness/plan-compiler.ts'
import { isToolAllowedForStep } from '../../src/renderer/src/harness/step-policy.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

test('isNarrowResumeInput accepts trailing punctuation', () => {
  assert.equal(isNarrowResumeInput('继续'), true)
  assert.equal(isNarrowResumeInput('继续。'), true)
  assert.equal(isNarrowResumeInput('请继续'), false)
})

test('isStructuralErrorReport detects crash and build failures', () => {
  assert.ok(
    isStructuralErrorReport(
      '--- 崩溃报告 ---\n---- Minecraft Crash Report ----\njava.lang.IllegalStateException'
    )
  )
  assert.ok(
    isStructuralErrorReport(
      'BUILD FAILED\nCompilation failed\nFoo.java:12: error: cannot find symbol'
    )
  )
  assert.ok(
    isStructuralErrorReport(
      'at knot//net.minecraft.client.gui.screen.Screen.render(Screen.java:1)'
    )
  )
  assert.equal(isStructuralErrorReport('你好'), false)
  assert.equal(isStructuralErrorReport('为什么这个 Mixin 不生效？'), false)
})

test('isCodeExplainInput detects marker', () => {
  const input = '--- 代码解释 ---\nFooItem (item)\n```java\nclass Foo {}\n```'
  assert.ok(isCodeExplainInput(input))
})

test('buildSessionGoalBlock includes goal', () => {
  assert.match(buildSessionGoalBlock('做二段跳'), /当前会话目标/)
  assert.match(buildSessionGoalBlock('做二段跳'), /二段跳/)
})

test('buildUserSymptomBlock reminds menu ≠ fixed', () => {
  const block = buildUserSymptomBlock('还是模糊的')
  assert.match(block, /用户待验证症状/)
  assert.match(block, /MC_PHASE:menu/)
  assert.match(block, /不代表该症状已修复/)
  assert.match(block, /mc_ensure_test_world/)
  assert.equal(buildUserSymptomBlock(null), '')
})

test('buildCrossTurnDiagnosisRetain keeps prior user feedback (not only system+1)', () => {
  const retained = buildCrossTurnDiagnosisRetain({
    system: { role: 'system', content: 'sys', origin: 'harness' },
    messages: [
      { role: 'system', content: 'sys', origin: 'harness' },
      { role: 'user', content: 'F6报错 wrong thread', origin: 'user' },
      { role: 'assistant', content: '已把 takeScreenshot 移回主线程并完成构建。', origin: 'assistant' },
      { role: 'user', content: '还是模糊的', origin: 'user' }
    ],
    taskId: 'task_test'
  })
  assert.ok(retained.length >= 3, `expected more than system+user, got ${retained.length}`)
  assert.equal(retained[0].role, 'system')
  assert.ok(retained.some((m) => m.role === 'user' && /跨轮诊断摘要/.test(m.content)))
  assert.ok(retained.some((m) => m.role === 'user' && m.content === '还是模糊的'))
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

test('compilePlanFromText: ops-only runClient plan is not stripped to empty', () => {
  const compiled = compilePlanFromText('1. 启动游戏进行真实测试（runClient）')
  assert.equal(compiled.length, 1)
  assert.match(compiled[0].description, /runClient/i)
})

test('compilePlanFromText: ops-only build+run plan keeps both terminals', () => {
  const compiled = compilePlanFromText(
    '1. 构建项目（gradlew build）\n2. 启动游戏进行真实测试（runClient）'
  )
  assert.equal(compiled.length, 2)
  assert.match(compiled[0].description, /build|构建/i)
  assert.match(compiled[1].description, /runClient/i)
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

test('verifyTargetFromClassification: Preview hints match MainMenuPreviewScreen', async () => {
  const {
    verifyTargetFromClassification,
    matchesVerifyTarget,
    formatVerifyTargetBlock,
    isWrongScreenVerifyFinding,
    formatVerifyRepairKick
  } = await import('../../src/renderer/src/harness/verify-target.ts')
  const target = verifyTargetFromClassification({
    label: '打开 F6 预览屏（MainMenuPreviewScreen）',
    hotkey: 'f6',
    screenNameHints: ['Preview', 'MainMenuPreviewScreen'],
    openSteps: ['mc_input key_press f6', 'mc_inspect']
  })
  assert.ok(target)
  assert.equal(target!.hotkey, 'f6')
  assert.match(target!.label, /Preview|预览/)
  assert.equal(
    matchesVerifyTarget(
      JSON.stringify({ screen: { simpleName: 'TitleScreen', kind: 'title' } }),
      target!
    ),
    false
  )
  assert.equal(
    matchesVerifyTarget(
      JSON.stringify({ screen: { simpleName: 'ConfigScreen', kind: 'generic' } }),
      target!
    ),
    false
  )
  assert.equal(
    matchesVerifyTarget(
      JSON.stringify({ screen: { simpleName: 'MainMenuPreviewScreen', kind: 'generic' } }),
      target!
    ),
    true
  )
  assert.match(formatVerifyTargetBlock(target!), /检测目标/)

  const finding = isWrongScreenVerifyFinding(
    JSON.stringify({ screen: { simpleName: 'ConfigScreen', kind: 'generic' } }),
    target!
  )
  assert.ok(finding)
  assert.equal(finding!.actual, 'ConfigScreen')
  assert.equal(
    isWrongScreenVerifyFinding(
      JSON.stringify({ screen: { simpleName: 'TitleScreen', kind: 'title' } }),
      target!
    ),
    null
  )
  assert.match(formatVerifyRepairKick(finding!), /进入修复/)
})

test('getToolLabelZh: mc tools and input actions use Chinese', async () => {
  const { getToolLabelZh } = await import('../../src/renderer/src/harness/tool-labels.ts')
  assert.equal(getToolLabelZh('mc_inspect'), '游戏内检视')
  assert.equal(getToolLabelZh('mc_input', { action: 'key_press', key: 'f6' }), '游戏按键 F6')
  assert.equal(getToolLabelZh('mc_input', { action: 'click_widget', label: '模组' }), '点击控件「模组」')
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
