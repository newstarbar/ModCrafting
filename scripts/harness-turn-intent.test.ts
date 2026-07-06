import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { resolveTurnIntent, buildSessionGoalBlock } from '../src/renderer/src/harness/turn-intent.ts'
import {
  compilePlanFromText,
  dropVagueSteps,
  needsKnowledgeInspect,
  parseStructuredSteps
} from '../src/renderer/src/harness/plan-compiler.ts'

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
