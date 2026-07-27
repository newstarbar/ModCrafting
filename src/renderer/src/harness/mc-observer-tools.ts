import type { Tool, ToolContext } from './tools'

export type BridgeCallResult = {
  ok: boolean
  status: number
  data: Record<string, unknown>
  error?: string
}

export async function callMcBridge(
  method: 'GET' | 'POST',
  apiPath: string,
  body?: Record<string, unknown>,
  instanceId?: string
): Promise<BridgeCallResult> {
  if (typeof window === 'undefined' || !window.api?.mcBridgeCall) {
    return { ok: false, status: 0, data: {}, error: 'mcBridgeCall 不可用（非 Electron 渲染进程）' }
  }
  return window.api.mcBridgeCall({
    method,
    path: apiPath,
    body,
    instanceId: instanceId || undefined
  })
}

export function formatBridgeResult(result: BridgeCallResult, omitKeys: string[] = ['base64']): string {
  if (!result.ok && Object.keys(result.data || {}).length === 0) {
    return `Error: ${result.error || '观测桥调用失败'}`
  }
  const data = { ...result.data }
  for (const key of omitKeys) {
    if (key in data) {
      const val = data[key]
      if (typeof val === 'string' && val.length > 0) {
        data[key] = `[omitted ${val.length} chars]`
      } else {
        delete data[key]
      }
    }
  }
  if (!result.ok) {
    return `Error: ${result.error || data.error || '观测桥调用失败'}\n${JSON.stringify(data, null, 2)}`
  }
  return JSON.stringify(data, null, 2)
}

function optionalInstanceId(args: Record<string, unknown>): string | undefined {
  const id = args.instanceId
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

export const mcScreenshotTool: Tool = {
  name: 'mc_screenshot',
  description: '截取当前 Minecraft 客户端画面（观测桥）。返回路径/尺寸；视觉模型可能附带 base64。无论模型是否支持视觉，截图都会保存并在任务总结中展示。非视觉模型请配合 mc_inspect 做数据化验证。',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const result = await callMcBridge('GET', '/v1/screenshot', undefined, optionalInstanceId(args))
    const output = formatBridgeResult(result)
    const base64 = typeof result.data.base64 === 'string' ? result.data.base64 : undefined
    const shotPath = typeof result.data.path === 'string' ? result.data.path : undefined
    return {
      output,
      artifactPaths: shotPath ? [shotPath] : undefined,
      imageBase64: base64,
      imageMimeType: base64 ? 'image/png' : undefined
    }
  }
}

export const mcInspectTool: Tool = {
  name: 'mc_inspect',
  description:
    '一次性检视：玩家 + 当前界面 + 控件 + 准星。ready 后用此或 mc_screenshot 验证症状；点按钮用 mc_input click_widget/click_at。仅 TitleScreen 不算验证完成。',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const result = await callMcBridge('GET', '/v1/inspect', undefined, optionalInstanceId(args))
    return formatBridgeResult(result)
  }
}

export const mcInventoryTool: Tool = {
  name: 'mc_inventory',
  description: '读取玩家快捷栏、主背包、盔甲与副手（观测桥）。',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const result = await callMcBridge('GET', '/v1/inventory', undefined, optionalInstanceId(args))
    return formatBridgeResult(result)
  }
}

export const mcWorldTool: Tool = {
  name: 'mc_world',
  description: '列出附近实体并采样玩家周围方块。',
  schema: {
    type: 'object',
    properties: {
      radius: { type: 'number', description: '搜索半径（1-64，默认 8）' },
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => true,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const radius = typeof args.radius === 'number' ? args.radius : Number(args.radius || 8)
    const q = Number.isFinite(radius) ? `?radius=${encodeURIComponent(String(radius))}` : ''
    const result = await callMcBridge('GET', `/v1/nearby${q}`, undefined, optionalInstanceId(args))
    return formatBridgeResult(result)
  }
}

export const mcChatTool: Tool = {
  name: 'mc_chat',
  description: '读取近期聊天，或发送聊天/命令（以 / 开头的命令可用）。',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'send'], description: 'read=读缓冲；send=发送' },
      text: { type: 'string', description: 'action=send 时的消息内容' },
      limit: { type: 'number', description: 'action=read 时最多条数（默认 50）' },
      instanceId: { type: 'string', description: '可选实例 id' }
    },
    required: ['action']
  },
  // send is a write; keep sequential even for read to avoid racing with send
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const action = String(args.action || 'read')
    const instanceId = optionalInstanceId(args)
    if (action === 'send') {
      const text = String(args.text || '')
      const result = await callMcBridge('POST', '/v1/chat', { text }, instanceId)
      return formatBridgeResult(result)
    }
    const limit = typeof args.limit === 'number' ? args.limit : Number(args.limit || 50)
    const q = Number.isFinite(limit) ? `?limit=${encodeURIComponent(String(limit))}` : ''
    const result = await callMcBridge('GET', `/v1/chat${q}`, undefined, instanceId)
    return formatBridgeResult(result)
  }
}
export const mcCommandTool: Tool = {
  name: 'mc_command',
  description: '以本地玩家执行 Minecraft 命令（自动补 /）。多数命令需要单人集成服务端。',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '命令（可带或不带前导 /）' },
      instanceId: { type: 'string', description: '可选实例 id' }
    },
    required: ['command']
  },
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const command = String(args.command || '')
    const result = await callMcBridge('POST', '/v1/command', { command }, optionalInstanceId(args))
    return formatBridgeResult(result)
  }
}

export const mcInputTool: Tool = {
  name: 'mc_input',
  description:
    '模拟客户端输入。GUI：click_at {x,y} 或 click_widget {index|label} 点按钮；key_press {key:"f6"} 热键。世界：前进/跳跃/使用/攻击等。验证 GUI 时必须点进待测界面，不能停在 TitleScreen。',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'click_at|click_widget|key_press|key_down|key_up|mouse_click|mouse_move|scroll|forward|back|left|right|jump|sneak|sprint|use|attack|inventory|drop|swap_hands'
      },
      key: { type: 'string', description: 'key_* 用按键（w/e/space/f6/esc/…）' },
      button: { type: 'string', description: 'left|right|middle' },
      x: { type: 'number', description: 'click_at 的缩放 GUI X' },
      y: { type: 'number', description: 'click_at 的缩放 GUI Y' },
      index: { type: 'number', description: 'click_widget 的控件序号（来自 inspect/widgets）' },
      label: { type: 'string', description: 'click_widget 的按钮文案子串' },
      dx: { type: 'number', description: 'mouse_move 偏航增量' },
      dy: { type: 'number', description: 'mouse_move 俯仰增量' },
      delta: { type: 'number', description: '滚轮增量' },
      durationMs: { type: 'number', description: '按住时长（毫秒）' },
      instanceId: { type: 'string', description: '可选实例 id' }
    },
    required: ['action']
  },
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>) {
    const body: Record<string, unknown> = {
      action: args.action,
      key: args.key,
      button: args.button,
      x: args.x,
      y: args.y,
      index: args.index,
      label: args.label,
      message: args.label,
      dx: args.dx,
      dy: args.dy,
      delta: args.delta,
      durationMs: args.durationMs
    }
    const result = await callMcBridge('POST', '/v1/input', body, optionalInstanceId(args))
    // F-keys often open screens asynchronously (screenshot → preview). Brief settle wait.
    const action = String(args.action || '').toLowerCase()
    const key = String(args.key || '').toLowerCase()
    if (
      (action === 'key_press' || action === 'key_down') &&
      /^f([1-9]|1[0-2])$/.test(key)
    ) {
      await new Promise((r) => setTimeout(r, 900))
    }
    if (action === 'click_widget' || action === 'click_at') {
      await new Promise((r) => setTimeout(r, 250))
    }
    return formatBridgeResult(result)
  }
}

// ── 测试环境编排辅助 ──

const POLL_INTERVAL_MS = 500
const WORLD_ENTER_TIMEOUT_MS = 30_000
const LAN_OPEN_TIMEOUT_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 从 inspect 结果中提取状态摘要 */
function parseInspectState(inspect: BridgeCallResult): {
  inWorld: boolean
  screenKind: string
  screenClass: string
  playerOk: boolean
  gamemode?: string
} {
  const data = inspect.data || {}
  const screen = (data.screen as Record<string, unknown>) || {}
  const player = (data.player as Record<string, unknown>) || {}
  return {
    inWorld: Boolean(data.inWorld ?? screen.inWorld ?? player.ok),
    screenKind: String(screen.kind || 'unknown'),
    screenClass: String(screen.simpleName || screen.className || ''),
    playerOk: Boolean(player.ok),
    gamemode: typeof player.gamemode === 'string' ? player.gamemode : undefined
  }
}

/** 等待直到进入世界或超时 */
async function waitForInWorld(instanceId?: string): Promise<BridgeCallResult> {
  const deadline = Date.now() + WORLD_ENTER_TIMEOUT_MS
  let last: BridgeCallResult = { ok: false, status: 0, data: {} }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    last = await callMcBridge('GET', '/v1/inspect', undefined, instanceId)
    if (parseInspectState(last).inWorld) return last
  }
  return last
}

/** 检测聊天缓冲中是否有权限错误信号 */
function chatIndicatesPermissionError(messages: Array<Record<string, unknown>>): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false
  // 检查最近 10 条消息
  const recent = messages.slice(-10)
  for (const m of recent) {
    const text = String(m.text || '').toLowerCase()
    if (
      text.includes('没有权限') ||
      text.includes('no permission') ||
      text.includes('not allowed') ||
      text.includes('unknown or incomplete command') ||
      text.includes('未知的或不完整的命令') ||
      text.includes('you do not have permission') ||
      text.includes('you don\'t have permission') ||
      text.includes('你没有权限')
    ) {
      return true
    }
  }
  return false
}

/** 尝试执行一个需要权限的命令并检测是否权限不足 */
async function probeCommandPermission(instanceId?: string): Promise<boolean> {
  // give 命令需要 OP 权限；成功时无聊天反馈，失败时有错误消息
  const give = await callMcBridge('POST', '/v1/command', { command: 'give @s minecraft:stone 1' }, instanceId)
  if (!give.ok) return false
  // 等待服务端处理并发送聊天反馈
  await sleep(800)
  const chat = await callMcBridge('GET', '/v1/chat?limit=10', undefined, instanceId)
  if (!chat.ok) return true // 无法读聊天，假设有权限
  const messages = (chat.data.messages as Array<Record<string, unknown>>) || []
  return !chatIndicatesPermissionError(messages)
}

// ── mc_ensure_test_world：进入/创建测试世界 ──

export const mcEnsureTestWorldTool: Tool = {
  name: 'mc_ensure_test_world',
  description:
    '确保已进入 Minecraft 测试世界：检测当前状态，若在主菜单则自动进入已有世界；若已在世界则直接返回。' +
    '用途：功能测试前必须先进入世界，不能停在主菜单。runClient 后调用本工具进入世界，再触发功能场景。' +
    '注意：本工具不创建新世界（创建世界需要手动操作）。如果没有任何存档，会返回明确提示让用户手动创建。',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const instanceId = optionalInstanceId(args)

    // 1. 检测当前状态
    const inspect = await callMcBridge('GET', '/v1/inspect', undefined, instanceId)
    if (!inspect.ok) {
      return formatBridgeResult(inspect) + '\n[note] 观测桥不可用，请确认游戏已通过 trigger_build runClient 启动。'
    }

    const state = parseInspectState(inspect)

    // 2. 已在世界中 → 直接返回
    if (state.inWorld && state.playerOk) {
      const player = (inspect.data.player as Record<string, unknown>) || {}
      return [
        '已进入游戏世界，无需重复进入。',
        `玩家：${player.name || 'unknown'} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || 'unknown'}`,
        '提示：现在可以执行功能测试场景（如 mc_command 生成生物、mc_input 移动玩家），再用 mc_screenshot/mc_inspect 验证效果。',
        '::kh::测试环境|世界|已进入'
      ].join('\n')
    }

    // 3. 在主菜单 → 尝试进入单人世界
    if (state.screenKind === 'title' || state.screenClass === 'TitleScreen') {
      // a. 点击"单人游戏"
      const clickSingleplayer = await callMcBridge(
        'POST',
        '/v1/input',
        { action: 'click_widget', label: '单人游戏' },
        instanceId
      )
      if (!clickSingleplayer.ok) {
        return [
          '当前在主菜单，但无法找到"单人游戏"按钮。',
          formatBridgeResult(clickSingleplayer),
          '提示：可能是多人游戏界面。请用 mc_input click_widget 手动进入单人世界列表。',
          '::kh::测试环境|世界|主菜单阻塞'
        ].join('\n')
      }
      await sleep(1000)

      // b. 检测是否进入世界选择界面
      const afterClick = await callMcBridge('GET', '/v1/inspect', undefined, instanceId)
      const afterState = parseInspectState(afterClick)

      if (afterState.inWorld) {
        // 某些情况点击会直接进入世界
        return '已进入游戏世界。提示：现在可以执行功能测试场景。'
      }

      if (afterState.screenKind !== 'select_world' && afterState.screenClass !== 'SelectWorldScreen') {
        return [
          '点击"单人游戏"后未进入世界选择界面，当前界面：' + afterState.screenKind + ' / ' + afterState.screenClass,
          '提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动操作。',
          '::kh::测试环境|世界|选择界面阻塞'
        ].join('\n')
      }

      // c. 在世界选择界面，查找并点击第一个世界条目
      // widgets 可能是数组、也可能是 { widgets: [...] } 嵌套结构、也可能在 screen.widgets 中
      const widgetsRaw = afterClick.data.widgets
      const screenRaw = (afterClick.data.screen as Record<string, unknown>) || {}
      const widgetList: Array<Record<string, unknown>> = Array.isArray(widgetsRaw)
        ? widgetsRaw
        : Array.isArray((widgetsRaw as { widgets?: Array<Record<string, unknown>> })?.widgets)
          ? (widgetsRaw as { widgets: Array<Record<string, unknown>> }).widgets
          : Array.isArray((screenRaw as { widgets?: Array<Record<string, unknown>> })?.widgets)
            ? (screenRaw as { widgets: Array<Record<string, unknown>> }).widgets
            : []
      // 世界条目通常是 ButtonWidget 或 WorldListWidget，message 含世界名
      // 先尝试点击列表中的第一个可点击条目
      const worldEntry = widgetList.find((w) => {
        const msg = String(w.message || '')
        const type = String(w.type || '')
        // 排除明显的功能按钮（创建新世界、删除等）
        return msg.length > 0 && !msg.includes('创建') && !msg.includes('新建') &&
          !msg.includes('删除') && !msg.includes('编辑') && !msg.includes('重建') &&
          !msg.includes('create') && !msg.includes('delete') && !msg.includes('edit') &&
          (type.includes('Button') || type.includes('Entry') || type.includes('World'))
      })

      if (!worldEntry) {
        return [
          '在世界选择界面未找到已有存档。',
          '提示：当前没有任何单人存档。请手动创建一个世界（创建时建议开启作弊权限），或用 mc_input click_widget label="创建新世界" 进入创建流程。',
          '::kh::测试环境|世界|无存档'
        ].join('\n')
      }

      // 点击世界条目
      const clickWorld = await callMcBridge(
        'POST',
        '/v1/input',
        { action: 'click_widget', index: worldEntry.index },
        instanceId
      )
      if (!clickWorld.ok) {
        return '点击世界条目失败：' + formatBridgeResult(clickWorld)
      }
      await sleep(500)

      // d. 点击"进入世界"按钮（或"选定世界"）
      const enterResult = await callMcBridge(
        'POST',
        '/v1/input',
        { action: 'click_widget', label: '进入' },
        instanceId
      )
      if (!enterResult.ok) {
        // 可能按钮文案不同，尝试其它匹配
        const altResult = await callMcBridge(
          'POST',
          '/v1/input',
          { action: 'click_widget', label: '选定' },
          instanceId
        )
        if (!altResult.ok) {
          return [
            '无法找到"进入世界"按钮。',
            '提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动点击进入按钮。',
            '::kh::测试环境|世界|进入按钮缺失'
          ].join('\n')
        }
      }

      // e. 等待进入世界
      const worldInspect = await waitForInWorld(instanceId)
      const worldState = parseInspectState(worldInspect)

      if (worldState.inWorld) {
        const player = (worldInspect.data.player as Record<string, unknown>) || {}
        return [
          '已进入游戏世界：' + (worldEntry.message || 'unknown'),
          `玩家：${player.name || 'unknown'} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || 'unknown'}`,
          '提示：现在可以执行功能测试场景（如 mc_command 生成生物、mc_input 移动玩家），再用 mc_screenshot/mc_inspect 验证效果。',
          '建议：若需要执行命令，先调用 mc_ensure_cheats 确保作弊权限已开启。',
          '::kh::测试环境|世界|已进入'
        ].join('\n')
      }

      return [
        '等待进入世界超时（30s）。',
        '提示：可能是世界加载缓慢。请用 mc_inspect 检视当前状态，或等待后重试。',
        '::kh::测试环境|世界|进入超时'
      ].join('\n')
    }

    // 4. 在其它界面 → 返回当前状态
    return [
      `当前不在主菜单也不在世界中，界面：${state.screenKind} / ${state.screenClass}`,
      '提示：请用 mc_inspect 检视当前界面，用 mc_input 手动操作返回主菜单或进入世界。',
      '::kh::测试环境|世界|未知界面'
    ].join('\n')
  }
}

// ── mc_ensure_cheats：确保作弊权限 ──

export const mcEnsureCheatsTool: Tool = {
  name: 'mc_ensure_cheats',
  description:
    '确保当前单人世界已开启作弊权限（可执行 /give /gamemode /summon 等命令）。' +
    '检测逻辑：执行 give 命令 → 读聊天缓冲 → 若权限不足则通过"对局域网开放"自动开启作弊。' +
    '用途：mc_command 执行需要权限的命令前调用本工具；或功能测试需要生成生物/给予物品/切换模式时先调用。',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: '可选实例 id' }
    }
  },
  readOnly: () => false,
  async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const instanceId = optionalInstanceId(args)

    // 1. 确认在世界中
    const inspect = await callMcBridge('GET', '/v1/inspect', undefined, instanceId)
    if (!inspect.ok) {
      return formatBridgeResult(inspect) + '\n[note] 观测桥不可用。'
    }
    const state = parseInspectState(inspect)
    if (!state.inWorld) {
      return [
        '未进入游戏世界，无法确保作弊权限。',
        '提示：请先调用 mc_ensure_test_world 进入世界，再调用本工具。',
        '::kh::测试环境|作弊权限|未进入世界'
      ].join('\n')
    }

    // 2. 探测当前权限
    const hasPermission = await probeCommandPermission(instanceId)
    if (hasPermission) {
      return [
        '作弊权限已开启，可执行 /give /gamemode /summon 等命令。',
        '提示：现在可以用 mc_command 执行测试场景命令（如 summon minecraft:zombie 给予 @s minecraft:diamond_sword）。',
        '::kh::测试环境|作弊权限|已开启'
      ].join('\n')
    }

    // 3. 权限不足 → 通过"对局域网开放"开启作弊
    // a. 按 Esc 打开游戏菜单
    const escResult = await callMcBridge(
      'POST',
      '/v1/input',
      { action: 'key_press', key: 'escape' },
      instanceId
    )
    if (!escResult.ok) {
      return '按 Esc 打开菜单失败：' + formatBridgeResult(escResult)
    }
    await sleep(600)

    // b. 点击"对局域网开放"
    const lanClick = await callMcBridge(
      'POST',
      '/v1/input',
      { action: 'click_widget', label: '对局域网开放' },
      instanceId
    )
    if (!lanClick.ok) {
      // 可能已经在局域网模式，或文案不同
      // 尝试英文文案
      const lanClickEn = await callMcBridge(
        'POST',
        '/v1/input',
        { action: 'click_widget', label: 'Open to LAN' },
        instanceId
      )
      if (!lanClickEn.ok) {
        return [
          '无法找到"对局域网开放"按钮。可能原因：1) 已经在局域网模式 2) 当前是服务端世界 3) 菜单文案不同。',
          '提示：请用 mc_inspect 检视当前菜单，用 mc_input click_widget 手动开启作弊。',
          '::kh::测试环境|作弊权限|局域网按钮缺失'
        ].join('\n')
      }
    }
    await sleep(500)

    // c. 点击"允许作弊"选项（切换为开）
    const cheatToggle = await callMcBridge(
      'POST',
      '/v1/input',
      { action: 'click_widget', label: '允许作弊' },
      instanceId
    )
    // 即使点击失败也继续（可能默认已开或文案不同）
    if (cheatToggle.ok) {
      await sleep(300)
    }

    // d. 点击"启动对局域网开放"按钮
    const startLan = await callMcBridge(
      'POST',
      '/v1/input',
      { action: 'click_widget', label: '启动' },
      instanceId
    )
    if (!startLan.ok) {
      // 尝试"开始对局域网开放"
      const altStart = await callMcBridge(
        'POST',
        '/v1/input',
        { action: 'click_widget', label: '开始' },
        instanceId
      )
      if (!altStart.ok) {
        return [
          '无法找到"启动对局域网开放"按钮。',
          '提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动启动。',
          '::kh::测试环境|作弊权限|启动按钮缺失'
        ].join('\n')
      }
    }

    // e. 等待返回游戏（局域网开放后自动关闭菜单）
    await sleep(1000)

    // f. 再次探测权限
    const recheckPermission = await probeCommandPermission(instanceId)
    if (recheckPermission) {
      return [
        '已通过"对局域网开放"开启作弊权限，现在可执行 /give /gamemode /summon 等命令。',
        '提示：现在可以用 mc_command 执行测试场景命令。',
        '::kh::测试环境|作弊权限|已开启'
      ].join('\n')
    }

    return [
      '尝试通过"对局域网开放"开启作弊权限，但验证仍失败。',
      '提示：可能是命令执行有其它问题（非权限问题）。请用 mc_command 执行命令后 mc_chat read 检查反馈。',
      '::kh::测试环境|作弊权限|开启失败'
    ].join('\n')
  }
}

// ── 工具注册表（必须在所有工具定义之后，避免 TDZ） ──

export const MC_OBSERVER_TOOLS: Tool[] = [
  mcScreenshotTool,
  mcInspectTool,
  mcInventoryTool,
  mcWorldTool,
  mcChatTool,
  mcCommandTool,
  mcInputTool,
  mcEnsureTestWorldTool,
  mcEnsureCheatsTool
]

export const MC_READONLY_TOOLS = new Set([
  'mc_screenshot',
  'mc_inspect',
  'mc_inventory',
  'mc_world'
])

export const MC_WRITE_TOOLS = new Set([
  'mc_chat',
  'mc_command',
  'mc_input',
  'mc_ensure_test_world',
  'mc_ensure_cheats'
])
