// ======== Tool System ========
// Ported from Reasonix internal/tool/tool.go

import { logger } from '../utils/logger'
import type { FileDiff } from './events'

// A single tool that the agent can call
export interface Tool {
  name: string
  description: string
  schema: Record<string, unknown> // JSON Schema
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string>
  readOnly(): boolean
}

// Optional preview interface for write tools
export interface Previewer {
  preview(args: Record<string, unknown>): FileDiff | null
}

// Context passed to every tool execution
export interface ToolContext {
  projectPath: string | null
  callId: string
  abortSignal?: AbortSignal
}

const MAX_TOOL_OUTPUT = 32 * 1024 // 32KB max output

function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT) return output
  const half = MAX_TOOL_OUTPUT / 2
  return (
    output.slice(0, half) +
    `\n\n...[TRUNCATED ${output.length - MAX_TOOL_OUTPUT} bytes]...\n\n` +
    output.slice(-half)
  )
}

// Tool execution result
export interface ToolResult {
  output: string
  error?: string
  durationMs: number
}

// ======== Registry ========

export class Registry {
  private tools = new Map<string, Tool>()
  private order: string[] = []

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    this.tools.set(tool.name, tool)
    this.order.push(tool.name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.order]
  }

  schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.order.map((name) => {
      const t = this.tools.get(name)!
      return {
        name: t.name,
        description: t.description,
        parameters: t.schema as Record<string, unknown>
      }
    })
  }

  len(): number {
    return this.tools.size
  }
}

// ======== Execute helpers ========

// Extract tool call XML from AI output (ModCrafting format)
export function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed.name) {
        calls.push({ name: parsed.name, args: parsed.args || {} })
      }
    } catch {
      // skip malformed
    }
  }
  return calls
}

// Execute a single tool
export async function executeTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const start = Date.now()
  logger.tool(`Executing: ${tool.name}`, args)

  try {
    const output = await tool.execute(ctx, args)
    const duration = Date.now() - start
    const truncated = truncateOutput(output)

    logger.tool(`Result: ${tool.name}`, {
      duration: `${duration}ms`,
      truncated: truncated.length < output.length,
      outputPreview: truncated.slice(0, 100)
    })

    return { output: truncated, durationMs: duration }
  } catch (err) {
    const duration = Date.now() - start
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.tool(`Error: ${tool.name}`, errMsg)
    return { output: errMsg, error: errMsg, durationMs: duration }
  }
}

// Batch execution — readOnly tools in parallel, writers sequentially
export async function executeBatch(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
  registry: Registry,
  ctx: ToolContext,
  onDispatch?: (name: string, id: string) => void,
  onResult?: (name: string, id: string, result: ToolResult) => void
): Promise<Map<string, ToolResult>> {
  const results = new Map<string, ToolResult>()

  // Split into readOnly and writers
  const readOnlyCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = []
  const writerCalls: Array<{ name: string; args: Record<string, unknown>; id: string }> = []

  for (const call of calls) {
    const id = call.id || `call_${Math.random().toString(36).slice(2, 8)}`
    const tool = registry.get(call.name)
    if (tool?.readOnly()) {
      readOnlyCalls.push({ ...call, id })
    } else {
      writerCalls.push({ ...call, id })
    }
  }

  // Execute readOnly calls in parallel
  if (readOnlyCalls.length > 0) {
    await Promise.all(
      readOnlyCalls.map(async (call) => {
        onDispatch?.(call.name, call.id)
        const tool = registry.get(call.name)
        if (tool) {
          const result = await executeTool(tool, call.args, ctx)
          results.set(call.id, result)
          onResult?.(call.name, call.id, result)
        }
      })
    )
  }

  // Execute writer calls serially
  for (const call of writerCalls) {
    onDispatch?.(call.name, call.id)
    const tool = registry.get(call.name)
    if (tool) {
      // Check preview
      const previewer = tool as unknown as Previewer
      const diff = previewer.preview?.(call.args) ?? null
      if (diff) {
        logger.tool(`Preview: ${call.name}`, diff)
      }
      const result = await executeTool(tool, call.args, ctx)
      results.set(call.id, result)
      onResult?.(call.name, call.id, result)
    }
  }

  return results
}
