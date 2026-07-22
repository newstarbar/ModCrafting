import test from 'node:test'
import assert from 'node:assert/strict'
import { isMcHarnessReady, parseMcLogs } from '../src/renderer/src/utils/mc-phase-parser.ts'
import { isRunClientReadyResult, parseTriggerBuildMeta } from '../src/renderer/src/harness/tools.ts'
import { canToolResultAdvanceStep } from '../src/renderer/src/harness/step-evidence.ts'
import { MC_RUN_READY_SOAK_MS, waitForMcRunReady } from '../src/renderer/src/utils/mc-wait-playing.ts'
import type { ToolResult } from '../src/renderer/src/harness/tools.ts'

function installMcApiMock(): {
  pushLog: (instanceId: string, text: string) => void
  pushState: (instanceId: string, state: { status?: string; exitReason?: string }) => void
} {
  const logHandlers: Array<(id: string, text: string) => void> = []
  const stateHandlers: Array<(id: string, state: unknown) => void> = []
  ;(globalThis as { window?: Window }).window = {
    api: {
      onMcLog: (cb: (id: string, text: string) => void) => {
        logHandlers.push(cb)
        return () => {}
      },
      onMcStateChanged: (cb: (id: string, state: unknown) => void) => {
        stateHandlers.push(cb)
        return () => {}
      }
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  } as Window
  return {
    pushLog: (instanceId, text) => {
      for (const handler of logHandlers) handler(instanceId, text)
    },
    pushState: (instanceId, state) => {
      for (const handler of stateHandlers) handler(instanceId, state)
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('isMcHarnessReady is false for early LWJGL-only logs', () => {
  const logs = ['[INFO] Backend library: LWJGL version 3.3.3']
  assert.equal(isMcHarnessReady(logs, 'running'), false)
  assert.equal(parseMcLogs(logs, 'running').phase, 'launch')
})

test('isMcHarnessReady is true after Setting user main menu marker', () => {
  const logs = [
    '[INFO] Backend library: LWJGL',
    '[INFO] OpenAL initialized',
    '[INFO] Setting user: Dev'
  ]
  assert.equal(isMcHarnessReady(logs, 'running'), true)
  assert.equal(parseMcLogs(logs, 'running').phase, 'playing')
})

test('parseMcLogs detects mixin apply failed as error', () => {
  const logs = ['[ERROR] Mixin apply failed for mod example']
  const info = parseMcLogs(logs, 'running')
  assert.equal(info.hasError, true)
  assert.equal(info.phase, 'error')
})

test('parseTriggerBuildMeta marks ready as runClientStarted', () => {
  const meta = parseTriggerBuildMeta('游戏已进入主菜单。[MC_PHASE:ready]')
  assert.ok(meta)
  assert.equal(meta!.mcPhase, 'ready')
  assert.equal(meta!.runClientStarted, true)
})

test('parseTriggerBuildMeta does not mark playing as runClientStarted', () => {
  const meta = parseTriggerBuildMeta('已启动。[MC_PHASE:playing]')
  assert.ok(meta)
  assert.equal(meta!.runClientStarted, false)
})

test('step-evidence does not advance run step on MC_PHASE:playing alone', () => {
  const playingOnly: ToolResult = {
    output: '已在右侧游戏面板启动。[MC_PHASE:playing]',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    args: { task: 'runClient' },
    meta: { mcPhase: 'playing', runClientStarted: false }
  }
  assert.equal(
    canToolResultAdvanceStep(
      { id: '4', description: '启动游戏进行真实测试（runClient）', status: 'running' },
      playingOnly
    ).ok,
    false
  )
})

test('step-evidence advances run step on MC_PHASE:ready', () => {
  const ready: ToolResult = {
    output: '游戏已进入主菜单并完成稳定观察。[MC_PHASE:ready]',
    durationMs: 1,
    ok: true,
    toolName: 'trigger_build',
    args: { task: 'runClient' },
    meta: { mcPhase: 'ready', runClientStarted: true }
  }
  assert.equal(
    canToolResultAdvanceStep(
      { id: '4', description: '启动游戏进行真实测试（runClient）', status: 'running' },
      ready
    ).ok,
    true
  )
  assert.equal(isRunClientReadyResult(ready), true)
})

test('waitForMcRunReady completes after soak when stable', async () => {
  const api = installMcApiMock()
  const soakMs = 80
  const promise = waitForMcRunReady({ instanceId: 'mc-1', soakMs, timeoutMs: 60_000 })
  api.pushLog('mc-1', 'Setting user: Dev\n')
  api.pushState('mc-1', { status: 'running' })
  await delay(soakMs + 40)
  const result = await promise
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'ready')
})

test('waitForMcRunReady fails when mixin error appears during soak', async () => {
  const api = installMcApiMock()
  const soakMs = 300
  const promise = waitForMcRunReady({ instanceId: 'mc-2', soakMs, timeoutMs: 60_000 })
  api.pushLog('mc-2', 'Setting user: Dev\n')
  await delay(50)
  api.pushLog('mc-2', 'Mixin apply failed for example\n')
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(String(result.error), /错误|崩溃|失败|启动/)
})

test('MC_RUN_READY_SOAK_MS defaults to 5 seconds', () => {
  assert.equal(MC_RUN_READY_SOAK_MS, 5000)
})
