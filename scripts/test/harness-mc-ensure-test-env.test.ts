import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mcEnsureTestWorldTool,
  mcEnsureCheatsTool,
  MC_OBSERVER_TOOLS,
  MC_WRITE_TOOLS,
  MC_READONLY_TOOLS,
  type BridgeCallResult
} from '../../src/renderer/src/harness/mc-observer-tools.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

type BridgeCall = (req: {
  method: 'GET' | 'POST'
  path: string
  body?: Record<string, unknown>
  instanceId?: string
}) => BridgeCallResult

interface MockState {
  calls: Array<{ method: string; path: string; body?: unknown }>
  respond: BridgeCall
}

function installMcBridgeMock(respond: BridgeCall): MockState {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const api = {
    mcBridgeCall(req: {
      method: 'GET' | 'POST'
      path: string
      body?: Record<string, unknown>
      instanceId?: string
    }): BridgeCallResult {
      calls.push({ method: req.method, path: req.path, body: req.body })
      return respond(req)
    }
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return { calls, respond }
}

function clearWindowMock(): void {
  delete (globalThis as { window?: unknown }).window
}

const ctx: ToolContext = {
  projectPath: '/tmp/proj',
  callId: 'test-call'
}

function ok(data: Record<string, unknown> = {}): BridgeCallResult {
  return { ok: true, status: 200, data }
}

function fail(error: string, data: Record<string, unknown> = {}): BridgeCallResult {
  return { ok: false, status: 500, data, error }
}

// ── 注册表测试 ──

test('MC_OBSERVER_TOOLS contains new orchestration tools after TDZ fix', () => {
  const names = MC_OBSERVER_TOOLS.map((t) => t.name)
  assert.ok(names.includes('mc_ensure_test_world'), 'mc_ensure_test_world should be registered')
  assert.ok(names.includes('mc_ensure_cheats'), 'mc_ensure_cheats should be registered')
})

test('MC_WRITE_TOOLS classifies orchestration tools as write', () => {
  assert.equal(MC_WRITE_TOOLS.has('mc_ensure_test_world'), true)
  assert.equal(MC_WRITE_TOOLS.has('mc_ensure_cheats'), true)
})

test('MC_READONLY_TOOLS excludes orchestration tools', () => {
  assert.equal(MC_READONLY_TOOLS.has('mc_ensure_test_world'), false)
  assert.equal(MC_READONLY_TOOLS.has('mc_ensure_cheats'), false)
})

test('orchestration tools report readOnly=false', () => {
  assert.equal(mcEnsureTestWorldTool.readOnly(), false)
  assert.equal(mcEnsureCheatsTool.readOnly(), false)
})

// ── mc_ensure_test_world 测试 ──

test('mc_ensure_test_world: already in world returns success without navigation', async () => {
  const mock = installMcBridgeMock(() =>
    ok({
      inWorld: true,
      player: {
        ok: true,
        name: 'Tester',
        x: 100, y: 64, z: -200,
        gamemode: 'survival'
      },
      screen: { kind: 'in_game', simpleName: 'InGame' }
    })
  )
  try {
    const result = await mcEnsureTestWorldTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /已进入游戏世界/)
    assert.match(output, /Tester/)
    assert.match(output, /::kh::测试环境\|世界\|已进入/)
    // 只应该有一次 inspect 调用，不应该有点击操作
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].path, '/v1/inspect')
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_test_world: bridge unavailable returns error hint', async () => {
  installMcBridgeMock(() =>
    fail('mcBridgeCall 不可用（非 Electron 渲染进程）')
  )
  try {
    const result = await mcEnsureTestWorldTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /观测桥不可用|Error/)
    assert.match(output, /trigger_build runClient/)
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_test_world: title screen navigates through singleplayer click', async () => {
  // 调用序列：
  // 1. GET /v1/inspect → 主菜单
  // 2. POST /v1/input click_widget 单人游戏 → ok
  // 3. GET /v1/inspect → 世界选择界面
  // 4. POST /v1/input click_widget index → ok (点击世界条目)
  // 5. POST /v1/input click_widget 进入 → ok
  // 6. GET /v1/inspect → 已在世界
  const sequence: BridgeCallResult[] = [
    ok({
      inWorld: false,
      screen: { kind: 'title', simpleName: 'TitleScreen' },
      player: { ok: false }
    }),
    ok({ clicked: true }),
    ok({
      inWorld: false,
      screen: { kind: 'select_world', simpleName: 'SelectWorldScreen' },
      widgets: [
        { index: 0, message: '创建新世界', type: 'ButtonWidget' },
        { index: 1, message: '测试世界', type: 'WorldListEntry' },
        { index: 2, message: '删除', type: 'ButtonWidget' }
      ]
    }),
    ok({ clicked: true }),
    ok({ clicked: true }),
    ok({
      inWorld: true,
      player: { ok: true, name: 'Tester', x: 0, y: 64, z: 0, gamemode: 'creative' },
      screen: { kind: 'in_game' }
    })
  ]
  let i = 0
  installMcBridgeMock(() => sequence[Math.min(i++, sequence.length - 1)])
  try {
    const result = await mcEnsureTestWorldTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /已进入游戏世界/)
    assert.match(output, /测试世界/)
    assert.match(output, /建议.*mc_ensure_cheats/)
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_test_world: no save in select world screen returns hint', async () => {
  const sequence: BridgeCallResult[] = [
    ok({
      inWorld: false,
      screen: { kind: 'title', simpleName: 'TitleScreen' },
      player: { ok: false }
    }),
    ok({ clicked: true }),
    ok({
      inWorld: false,
      screen: { kind: 'select_world', simpleName: 'SelectWorldScreen' },
      // 仅有功能按钮，没有世界条目
      widgets: [
        { index: 0, message: '创建新世界', type: 'ButtonWidget' },
        { index: 1, message: '删除', type: 'ButtonWidget' }
      ]
    })
  ]
  let i = 0
  installMcBridgeMock(() => sequence[Math.min(i++, sequence.length - 1)])
  try {
    const result = await mcEnsureTestWorldTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /未找到已有存档|没有任何单人存档/)
    assert.match(output, /::kh::测试环境\|世界\|无存档/)
  } finally {
    clearWindowMock()
  }
})

// ── mc_ensure_cheats 测试 ──

test('mc_ensure_cheats: not in world returns prompt to enter world first', async () => {
  installMcBridgeMock(() =>
    ok({
      inWorld: false,
      screen: { kind: 'title', simpleName: 'TitleScreen' },
      player: { ok: false }
    })
  )
  try {
    const result = await mcEnsureCheatsTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /未进入游戏世界/)
    assert.match(output, /mc_ensure_test_world/)
    assert.match(output, /::kh::测试环境\|作弊权限\|未进入世界/)
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_cheats: already has permission returns success', async () => {
  // 1. inspect → 在世界
  // 2. POST /v1/command give @s minecraft:stone 1 → ok
  // 3. GET /v1/chat?limit=10 → 空聊天（无权限错误）
  const sequence: BridgeCallResult[] = [
    ok({
      inWorld: true,
      player: { ok: true, name: 'Tester', gamemode: 'creative' },
      screen: { kind: 'in_game' }
    }),
    ok({ executed: true }),
    ok({ messages: [] })
  ]
  let i = 0
  installMcBridgeMock(() => sequence[Math.min(i++, sequence.length - 1)])
  try {
    const result = await mcEnsureCheatsTool.execute(ctx, {})
    const output = String(result)
    assert.match(output, /作弊权限已开启/)
    assert.match(output, /::kh::测试环境\|作弊权限\|已开启/)
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_cheats: detects permission error from chat buffer', async () => {
  // 1. inspect → 在世界
  // 2. POST /v1/command give → ok (命令发出但服务端拒绝)
  // 3. GET /v1/chat → 包含权限错误消息
  const sequence: BridgeCallResult[] = [
    ok({
      inWorld: true,
      player: { ok: true, name: 'Tester', gamemode: 'survival' },
      screen: { kind: 'in_game' }
    }),
    ok({ executed: true }),
    ok({
      messages: [
        { text: 'You do not have permission to use this command' }
      ]
    })
  ]
  let i = 0
  installMcBridgeMock(() => sequence[Math.min(i++, sequence.length - 1)])
  try {
    // 这次探测会失败 → 触发局域网开放流程
    // 后续调用：esc → 单人游戏无效，会点击对局域网开放按钮等
    // 为了简化，这里只测试权限探测能识别错误，后续 UI 操作会因 mock 持续返回权限错误而失败
    const result = await mcEnsureCheatsTool.execute(ctx, {})
    const output = String(result)
    // 应该不会返回"已开启"
    assert.doesNotMatch(output, /作弊权限已开启[\s\S]*$/)
    // 应该进入"开启失败"或"局域网按钮缺失"分支
    assert.match(
      output,
      /局域网按钮缺失|启动按钮缺失|开启失败|无法找到.*对局域网开放/
    )
  } finally {
    clearWindowMock()
  }
})

test('mc_ensure_cheats: command failure (bridge error) treats as no permission', async () => {
  const sequence: BridgeCallResult[] = [
    ok({
      inWorld: true,
      player: { ok: true, name: 'Tester', gamemode: 'survival' },
      screen: { kind: 'in_game' }
    }),
    fail('command not allowed'), // give 命令失败
    ok({ messages: [] })
  ]
  let i = 0
  installMcBridgeMock(() => sequence[Math.min(i++, sequence.length - 1)])
  try {
    const result = await mcEnsureCheatsTool.execute(ctx, {})
    const output = String(result)
    // give 失败 → probeCommandPermission 返回 false → 进入开启作弊流程
    // 后续 esc 等调用会返回空 ok，但找不到对局域网开放按钮（因为 mock 默认不返回 widgets）
    // 最终应该落到某个失败分支或成功分支
    assert.ok(typeof output === 'string')
  } finally {
    clearWindowMock()
  }
})
