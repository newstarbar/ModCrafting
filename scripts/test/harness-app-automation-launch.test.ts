import test from 'node:test'
import assert from 'node:assert/strict'
import { appAutomationLaunchArgs, isHiddenAppAutomationMode } from './app-automation-launch.ts'

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
