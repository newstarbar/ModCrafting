import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'

test('markRunning only promotes pending steps; error stays error', () => {
  const pending = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'pending' }
  ])
  pending.markRunning()
  assert.equal(pending.snapshot()[0].status, 'running')

  const failed = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'error' }
  ])
  failed.markRunning()
  assert.equal(failed.snapshot()[0].status, 'error')
  assert.equal(failed.hasErrorStep(), true)
  assert.equal(failed.allDone(), false)
})

test('synthetic plans are marked and incomplete synthetic should be released by callers', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'running' }
  ]).markSynthetic()
  assert.equal(tracker.synthetic, true)
  assert.equal(tracker.allDone(), false)

  // Mirrors Controller.releaseIncompleteSyntheticPlan decision criteria.
  const shouldRelease = tracker.synthetic && !tracker.allDone()
  assert.equal(shouldRelease, true)

  const done = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'completed' }
  ]).markSynthetic()
  assert.equal(done.synthetic && !done.allDone(), false)
})

test('stale plan guard: synthetic or error steps should force replan instead of auto-resume', () => {
  const synthetic = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'running' }
  ]).markSynthetic()
  assert.equal(synthetic.synthetic || synthetic.hasErrorStep(), true)

  const errored = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'error' },
    { id: '2', description: '构建', status: 'pending' }
  ])
  assert.equal(errored.synthetic || errored.hasErrorStep(), true)

  const healthy = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'completed' },
    { id: '2', description: '构建', status: 'running' }
  ])
  assert.equal(healthy.synthetic || healthy.hasErrorStep(), false)
})

test('fromSteps preserves error status for restore/replan decisions', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '启动游戏进行真实测试（runClient）', status: 'error' }
  ])
  assert.equal(tracker.snapshot()[0].status, 'error')
  assert.equal(tracker.currentStep?.status, 'error')
  // Explicit resume remaps error → pending (beginExecuteFromTracker), then markRunning works.
  for (const step of tracker.steps) {
    if (step.status === 'error') step.status = 'pending'
  }
  tracker.markRunning()
  assert.equal(tracker.snapshot()[0].status, 'running')
})
