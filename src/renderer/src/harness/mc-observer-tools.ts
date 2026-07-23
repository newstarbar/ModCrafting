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
  description:
    'Capture the current Minecraft client framebuffer via the observer bridge. Returns path/size; may include base64 for vision models.',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
    'One-shot game inspection: player + current screen + widgets + crosshair. After runClient ready, use this (or mc_screenshot) to verify GUI/symptoms. For GUI buttons use mc_input click_widget/click_at.',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
  description: 'Read player hotbar, main inventory, armor and offhand via the observer bridge.',
  schema: {
    type: 'object',
    properties: {
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
  description: 'List nearby entities and sample nearby blocks around the player.',
  schema: {
    type: 'object',
    properties: {
      radius: { type: 'number', description: 'Search radius (1-64, default 8)' },
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
  description: 'Read recent chat or send a chat message (commands with leading / are allowed).',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'send'], description: 'read buffer or send message' },
      text: { type: 'string', description: 'Message to send when action=send' },
      limit: { type: 'number', description: 'Max messages when action=read (default 50)' },
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
  description: 'Execute a Minecraft command as the local player (auto-prefixes /). Singleplayer integrated server required for most commands.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command without or with leading /' },
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
    'Simulate client input. For GUI: click_at {x,y} or click_widget {index|label} to press screen buttons; key_press {key:"f6"} for hotkeys. World: forward/jump/use/attack/…',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description:
          'click_at|click_widget|key_press|key_down|key_up|mouse_click|mouse_move|scroll|forward|back|left|right|jump|sneak|sprint|use|attack|inventory|drop|swap_hands'
      },
      key: { type: 'string', description: 'Key for key_* (w/e/space/f6/esc/…)' },
      button: { type: 'string', description: 'left|right|middle' },
      x: { type: 'number', description: 'Scaled GUI X for click_at' },
      y: { type: 'number', description: 'Scaled GUI Y for click_at' },
      index: { type: 'number', description: 'Widget index from /v1/widgets for click_widget' },
      label: { type: 'string', description: 'Substring of widget message for click_widget' },
      dx: { type: 'number', description: 'Yaw delta for mouse_move' },
      dy: { type: 'number', description: 'Pitch delta for mouse_move' },
      delta: { type: 'number', description: 'Scroll delta' },
      durationMs: { type: 'number', description: 'Hold duration for press actions' },
      instanceId: { type: 'string', description: 'Optional MC instance id' }
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
