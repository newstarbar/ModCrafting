import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePlanFromText } from '../../src/renderer/src/harness/plan-compiler.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { canonicalizePlanSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'

// ─── compilePlanFromText: test_design inserted after run when game-test needed ───

test('compilePlanFromText: needsGameTest inserts test_design before game_test', () => {
  const text = '1. 实现物品注册\n2. 构建项目'
  const steps = compilePlanFromText(text)
  const kinds = steps.map((s) => s.kind ?? s.description.includes('构建') ? 'build' : s.description.includes('测试') ? 'game_test' : 'write')
  const terminalKinds = steps.filter((s) => s.hostManaged).map((s) => s.kind)
  assert.ok(terminalKinds.includes('test_design'), `expected test_design in ${JSON.stringify(terminalKinds)}`)
  assert.ok(terminalKinds.includes('game_test'), `expected game_test in ${JSON.stringify(terminalKinds)}`)
  const tdIdx = terminalKinds.indexOf('test_design')
  const gtIdx = terminalKinds.indexOf('game_test')
  assert.ok(tdIdx < gtIdx, 'test_design must come before game_test')
})

test('compilePlanFromText: [test_design] structured step is preserved', () => {
  const text = '1. [test_design] 设计合成配方测试场景\n2. 构建项目'
  const steps = compilePlanFromText(text)
  const td = steps.find((s) => s.kind === 'test_design')
  assert.ok(td, 'test_design step must be preserved')
  assert.ok(td!.hostManaged !== true, 'structured test_design is not hostManaged')
})

test('compilePlanFromText: test_design has HOST_TEST_DESIGN_DESC', () => {
  const text = '1. 实现物品\n2. 构建'
  const steps = compilePlanFromText(text)
  const td = steps.find((s) => s.kind === 'test_design')
  assert.ok(td, 'must have test_design step')
  assert.ok(/设计游戏测试场景|test_design/i.test(td!.description), `expected design desc, got: ${td!.description}`)
})

test('compilePlanFromText: pure build/run plan skips test_design', () => {
  const text = '1. 编译项目\n2. 运行测试\n3. 验证结果'
  const steps = compilePlanFromText(text)
  const kinds = steps.map((s) => s.kind)
  assert.ok(!kinds.includes('test_design'), 'pure build/run plan should not inject test_design')
})

// ─── canonicalizePlanSteps: test_design ordering ───

test('canonicalizePlanSteps: inserts test_design before game_test when needed', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '写代码', status: 'pending' },
    { id: '2', description: '构建项目（gradlew build）', status: 'pending', kind: 'build' },
    { id: '3', description: '启动游戏（runClient）', status: 'pending', kind: 'run' },
    { id: '4', description: '执行确定性游戏测试', status: 'pending', kind: 'game_test' },
  ]
  const normalized = canonicalizePlanSteps(raw)
  const kinds = normalized.map((s) => s.kind)
  const tdIdx = kinds.indexOf('test_design')
  const gtIdx = kinds.indexOf('game_test')
  assert.ok(tdIdx >= 0, 'canonicalizePlanSteps must inject test_design')
  assert.ok(tdIdx < gtIdx, 'test_design must come before game_test')
})

test('canonicalizePlanSteps: error status on test_design resets to pending', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '设计测试场景', status: 'error', kind: 'test_design' },
    { id: '2', description: '构建', status: 'pending', kind: 'build' },
    { id: '3', description: '运行', status: 'pending', kind: 'run' },
  ]
  const normalized = canonicalizePlanSteps(raw)
  const td = normalized.find((s) => s.kind === 'test_design')
  assert.equal(td?.status, 'pending', 'test_design with error resets to pending')
})

// ─── normalizeWorkflowSteps: test_design validation type ───

test('normalizeWorkflowSteps: test_design has validation type test_design_ready', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '设计游戏测试场景', status: 'pending', kind: 'test_design' },
    { id: '2', description: '构建', status: 'pending', kind: 'build' },
  ]
  const steps = normalizeWorkflowSteps(raw)
  const td = steps.find((s) => s.kind === 'test_design')
  assert.ok(td, 'must have test_design step')
  assert.equal(td!.validation?.type, 'test_design_ready')
})

test('normalizeWorkflowSteps: test_design maxAttempts = 8', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '设计测试场景', status: 'pending', kind: 'test_design' },
  ]
  const steps = normalizeWorkflowSteps(raw)
  assert.equal(steps[0].maxAttempts, 8)
})

test('normalizeWorkflowSteps: inferKind maps test_design description to test_design kind', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '设计游戏测试场景（读代码 → mc_test_scenario 注册）', status: 'pending' },
  ]
  const steps = normalizeWorkflowSteps(raw)
  assert.equal(steps[0].kind, 'test_design')
})

test('normalizeWorkflowSteps: inferKind maps mc_run_test to game_test (not test_design)', () => {
  const raw: import('../../src/renderer/src/harness/plan-tracker.ts').PlanStepState[] = [
    { id: '1', description: '执行确定性游戏测试（mc_run_test）', status: 'pending' },
  ]
  const steps = normalizeWorkflowSteps(raw)
  assert.equal(steps[0].kind, 'game_test')
})
