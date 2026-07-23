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
  description: '截取当前 Minecraft 客户端画面（观测桥）。返回路径/尺寸；视觉模型可能附带 base64。',
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

export const MC_OBSERVER_TOOLS: Tool[] = [
  mcScreenshotTool,
  mcInspectTool,
  mcInventoryTool,
  mcWorldTool,
  mcChatTool,
  mcCommandTool,
  mcInputTool
]

export const MC_READONLY_TOOLS = new Set([
  'mc_screenshot',
  'mc_inspect',
  'mc_inventory',
  'mc_world'
])

export const MC_WRITE_TOOLS = new Set(['mc_chat', 'mc_command', 'mc_input'])
