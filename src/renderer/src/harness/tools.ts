// ======== Tool System ========
// Ported from Reasonix internal/tool/tool.go

import { logger } from '../utils/logger.ts'
import type { McPhase } from '../utils/mc-phase-parser.ts'
import type { FileDiff } from './events.ts'
import type { PlanTracker, PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'

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
  onProgress?: (chunk: string) => void
  planTracker?: PlanTracker | null
  onPlanStateChange?: (steps: PlanStepState[]) => void
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

function parseExitCode(output: string): number | null {
  const match = output.match(/\[exit code: (-?\d+)\]|\[退出码: (-?\d+)\]/)
  if (!match) return null
  return Number(match[1] ?? match[2])
}

function inferToolError(toolName: string, output: string, exitCode: number | null): string | undefined {
  if (/^(Error|No project open)/i.test(output)) return output
  if (/环境准备失败/.test(output)) return output
  if (exitCode !== null && exitCode !== 0) return output
  if (toolName === 'trigger_build' && /BUILD FAILED/i.test(output)) return output
  return undefined
}

/** Build a helpful error message when a file operation fails.
 *  Reads the project directory to suggest similar file names on ENOENT. */
export async function diagnoseFileError(
  toolName: string,
  projectPath: string | null,
  filePath: string,
  rawError: string,
  extra?: { oldString?: string; fileContent?: string }
): Promise<string> {
  const errLower = rawError.toLowerCase()

  // ── ENOENT: file not found ──
  if (errLower.includes('enoent') || errLower.includes('no such file')) {
    if (!projectPath) return `文件不存在: ${filePath}`
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    const baseName = filePath.substring(filePath.lastIndexOf('/') + 1).toLowerCase()

    let suggestion = ''
    try {
      // Try to list the parent directory
      const parentDir = dir || '.'
      const entries = await window.api.listDirectory(`${projectPath}/${parentDir}`)
      if (entries.length > 0) {
        // Find similar names
        const similar = entries
          .filter((e) => {
            const n = e.name.toLowerCase()
            return n.includes(baseName.slice(0, 4)) || baseName.includes(n.slice(0, 4))
          })
          .slice(0, 3)
          .map((e) => e.name + (e.isDirectory ? '/' : ''))
        if (similar.length > 0) {
          suggestion = `\n目录 "${parentDir}" 中的相似文件: ${similar.join(', ')}`
        } else {
          const allNames = entries.map((e) => e.name + (e.isDirectory ? '/' : '')).join(', ')
          suggestion = `\n目录 "${parentDir}" 内容: ${allNames.slice(0, 200)}`
        }
      }
    } catch { /* ignore */ }

    return `文件不存在: ${filePath}${suggestion}\n如果要创建新文件，请使用 write_file。`
  }

  // ── EISDIR: path is a directory ──
  if (errLower.includes('eisdir') || errLower.includes('illegal operation on a directory')) {
    return `"${filePath}" 是一个目录，不是文件。请用 list_directory 查看目录内容，或用正确的文件路径重试。`
  }

  // ── EACCES / EPERM: permission ──
  if (errLower.includes('eacces') || errLower.includes('eperm')) {
    return `权限不足: ${filePath}。文件可能被其他进程（如 Gradle、游戏）占用。请关闭相关进程后重试。`
  }

  // ── ENOSPC: disk full ──
  if (errLower.includes('enospc')) {
    return `磁盘空间不足，无法写入 ${filePath}。请清理磁盘后重试。`
  }

  // ── edit_file specific: old_string not found ──
  if (toolName === 'edit_file' && extra?.fileContent && extra?.oldString) {
    const oldLower = extra.oldString.toLowerCase()
    const lines = extra.fileContent.split('\n')
    // Find lines containing keywords from oldString
    const keywords = oldLower.split(/\s+/).filter((w: string) => w.length > 3)
    const contextLines: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (keywords.some((kw: string) => lines[i].toLowerCase().includes(kw))) {
        const start = Math.max(0, i - 3)
        const end = Math.min(lines.length, i + 4)
        for (let j = start; j < end; j++) {
          contextLines.push(`${j + 1} | ${lines[j]}`)
        }
        contextLines.push('---')
        if (contextLines.length >= 30) break
      }
    }
    if (contextLines.length > 0) {
      return `未找到目标文本。以下是文件中包含相关关键词的区域:\n${contextLines.join('\n')}\n请用 read_file 查看更多内容，然后调整 old_string 精确匹配。`
    }
    return `未找到目标文本。文件共 ${lines.length} 行。请用 read_file 查看文件内容后重试。`
  }

  // ── edit_file: multiple matches ──
  if (toolName === 'edit_file' && errLower.includes('multiple matches')) {
    return rawError // Already formatted by the tool
  }

  return rawError
}

function artifactPathFor(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === 'write_file' || toolName === 'read_file') {
    return typeof args.path === 'string' ? args.path : undefined
  }
  if (toolName === 'create_recipe' && typeof args.namespace === 'string' && typeof args.name === 'string') {
    return recipePath(args.namespace, args.name)
  }
  if (toolName === 'fabric_recipe_generate' && typeof args.namespace === 'string' && typeof args.name === 'string') {
    return recipePath(args.namespace, args.name)
  }
  if (toolName === 'fabric_data_assets_generate' && typeof args.namespace === 'string' && typeof args.name === 'string') {
    const kind = typeof args.kind === 'string' ? args.kind : 'item'
    return kind === 'block'
      ? `src/main/resources/assets/${args.namespace}/blockstates/${args.name}.json`
      : `src/main/resources/assets/${args.namespace}/models/item/${args.name}.json`
  }
  if (toolName === 'fabric_content_register' && typeof args.packagePath === 'string') {
    const kind = typeof args.kind === 'string' ? args.kind : 'item'
    const base = `src/main/java/${String(args.packagePath).replace(/\./g, '/')}`
    if (kind === 'block') return `${base}/ModBlocks.java`
    if (kind === 'block_entity') return `${base}/ModBlockEntities.java`
    return `${base}/ModItems.java`
  }
  if (toolName === 'fabric_template_generate' && typeof args.templateId === 'string') {
    const templateId = args.templateId
    const name = typeof args.name === 'string' ? args.name : 'generated'
    const className = name.replace(/-/g, '_')
    if (templateId === 'custom-block') {
      return `src/main/java/**/${className}Block.java`
    }
    if (templateId === 'custom-entity') {
      return `src/main/java/**/${className}Entity.java`
    }
    if (templateId === 'custom-tool' || templateId === 'custom-armor') {
      return `src/main/java/**/${className}*.java`
    }
    if (templateId === 'custom-food' || templateId === 'custom-item') {
      return `src/main/java/**/${className}Item.java`
    }
    return undefined
  }
  if (toolName === 'fabric_mixin_scaffold' && typeof args.mixinClass === 'string') {
    return `src/main/java/${String(args.mixinClass).replace(/\./g, '/')}.java`
  }
  return undefined
}

// Tool execution result
export interface ToolResult {
  output: string
  error?: string
  durationMs: number
  ok?: boolean
  toolName?: string
  args?: Record<string, unknown>
  artifactPath?: string
  exitCode?: number | null
  errorKind?: string
  fileDiff?: FileDiff
  meta?: {
    mcPhase?: McPhase
    runClientStarted?: boolean
  }
}

function parseTriggerBuildMeta(output: string): ToolResult['meta'] | undefined {
  const phaseMatch = output.match(/\[MC_PHASE:(\w+)\]/)
  if (!phaseMatch) return undefined
  return {
    mcPhase: phaseMatch[1] as McPhase,
    runClientStarted: phaseMatch[1] === 'playing'
  }
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
    const exitCode = parseExitCode(output)
    const inferredError = inferToolError(tool.name, output, exitCode)
    const meta = tool.name === 'trigger_build' ? parseTriggerBuildMeta(output) : undefined

    // Extract embedded FILE_DIFF metadata from write_file output
    let fileDiff: FileDiff | undefined
    let cleanedOutput = truncated
    const diffMatch = cleanedOutput.match(/<!-- FILE_DIFF (.*?) -->/)
    if (diffMatch) {
      try { fileDiff = JSON.parse(diffMatch[1]) } catch { /* ignore malformed */ }
      cleanedOutput = cleanedOutput.replace(/\s*<!-- FILE_DIFF .*? -->/, '').trim()
    }

    logger.tool(`Result: ${tool.name}`, {
      duration: `${duration}ms`,
      truncated: truncated.length < output.length,
      outputPreview: truncated.slice(0, 100)
    })

    return {
      output: cleanedOutput,
      error: inferredError ? truncateOutput(inferredError) : undefined,
      durationMs: duration,
      ok: !inferredError,
      toolName: tool.name,
      args,
      artifactPath: artifactPathFor(tool.name, args),
      exitCode,
      fileDiff,
      meta
    }
  } catch (err) {
    const duration = Date.now() - start
    let errMsg = err instanceof Error ? err.message : String(err)
    logger.tool(`Error: ${tool.name}`, errMsg)

    // File tools: diagnose the error with context
    if (tool.name === 'read_file' || tool.name === 'write_file' || tool.name === 'edit_file') {
      const filePath = typeof args.path === 'string' ? `${ctx.projectPath}/${args.path}` : ''
      errMsg = await diagnoseFileError(tool.name, ctx.projectPath, filePath, errMsg)
    }

    return {
      output: errMsg,
      error: errMsg,
      durationMs: duration,
      ok: false,
      toolName: tool.name,
      args,
      artifactPath: artifactPathFor(tool.name, args),
      exitCode: null,
      errorKind: 'exception'
    }
  }
}

// Batch execution — readOnly tools in parallel, writers sequentially
export async function executeBatch(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
  registry: Registry,
  ctx: ToolContext,
  onDispatch?: (name: string, id: string, args: Record<string, unknown>) => void,
  onResult?: (name: string, id: string, result: ToolResult) => void,
  onProgress?: (id: string, chunk: string) => void
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
        onDispatch?.(call.name, call.id, call.args)
        const tool = registry.get(call.name)
        if (tool) {
          const callCtx: ToolContext = {
            ...ctx,
            callId: call.id,
            onProgress: onProgress ? (chunk) => onProgress(call.id, chunk) : undefined
          }
          const result = await executeTool(tool, call.args, callCtx)
          results.set(call.id, result)
          onResult?.(call.name, call.id, result)
        }
      })
    )
  }

  // Execute writer calls serially
  for (const call of writerCalls) {
    onDispatch?.(call.name, call.id, call.args)
    const tool = registry.get(call.name)
    if (tool) {
      // Check preview
      const previewer = tool as unknown as Previewer
      const diff = previewer.preview?.(call.args) ?? null
      if (diff) {
        logger.tool(`Preview: ${call.name}`, diff)
      }
      const callCtx: ToolContext = {
        ...ctx,
        callId: call.id,
        onProgress: onProgress ? (chunk) => onProgress(call.id, chunk) : undefined
      }
      const result = await executeTool(tool, call.args, callCtx)
      // Attach fileDiff from preview if execute() didn't provide one
      if (!result.fileDiff && diff) {
        result.fileDiff = diff
      }
      results.set(call.id, result)
      onResult?.(call.name, call.id, result)
    }
  }

  return results
}
