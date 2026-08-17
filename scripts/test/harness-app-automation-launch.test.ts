import test from 'node:test'
import assert from 'node:assert/strict'
import { appAutomationFixedRoutingConfig, appAutomationLaunchArgs, isAppAutomationTurnDone, isHiddenAppAutomationMode, shouldContinueAppAutomation } from './app-automation-launch.ts'

const base = {
  profile: 'C:/temp/profile',
  discovery: 'C:/temp/automation.json',
  artifacts: 'C:/temp/artifacts'
}

test('app automation is foreground-visible by default', () => {
  const args = appAutomationLaunchArgs({ ...base, hidden: false, liveProvider: true })
  assert.equal(args.includes('--automation-hidden'), false)
  assert.equal(args.includes('--automation-live-provider'), true)
})

test('app automation only enables hidden mode explicitly', () => {
  const args = appAutomationLaunchArgs({ ...base, hidden: true, liveProvider: false })
  assert.equal(args.includes('--automation-hidden'), true)
  assert.equal(args.includes('--automation-live-provider'), false)
})

test('npm forwarded hidden configuration remains compatible', () => {
  assert.equal(isHiddenAppAutomationMode(['node', 'runner.ts'], { npm_config_hidden: 'true' }), true)
  assert.equal(isHiddenAppAutomationMode(['node', 'runner.ts', '--hidden'], {}), true)
  assert.equal(isHiddenAppAutomationMode(['node', 'runner.ts'], {}), false)
})

test('app automation pins all roles to the provider under test', () => {
  const config = appAutomationFixedRoutingConfig({ providerId: 'minimax', model: 'MiniMax-M3' })
  assert.deepEqual(config.defaultSelection, {
    mode: 'fixed', strategyId: 'single', taskTemplateId: 'auto',
    model: { providerId: 'minimax', modelId: 'MiniMax-M3' }
  })
  assert.equal(config.hardLimits.maxReadonlyConcurrency, 1)
})

test('automation turn completion accepts terminal UI messages after controller error cleanup', () => {
  assert.equal(isAppAutomationTurnDone({
    chat: { controller: { running: false, messages: [] }, ui: { messageCount: 2, activeAssistantStreaming: false } }
  }), true)
  assert.equal(isAppAutomationTurnDone({
    chat: { controller: { running: true, messages: [] }, ui: { messageCount: 2, activeAssistantStreaming: true } }
  }), false)
})

test('game automation continues a partial plan within its bounded budget', () => {
  const partial = { chat: { controller: { running: false, planSteps: [{ status: 'completed' }, { status: 'error' }] } } }
  assert.equal(shouldContinueAppAutomation(partial, 0, 8), true)
  assert.equal(shouldContinueAppAutomation(partial, 8, 8), false)
  assert.equal(shouldContinueAppAutomation({ chat: { controller: { running: false, planSteps: [] } } }, 0, 8), false)
})
