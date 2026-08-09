// ======== Tool System ========
// Ported from Reasonix internal/tool/tool.go

import { logger } from '../utils/logger.ts'
import type { McPhase } from '../utils/mc-phase-parser.ts'
import type { FileDiff, GuiLayoutElement, GuiLayoutType } from './events.ts'
import type { PlanTracker, PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'
import type { FileSession } from './file-session.ts'
import { getBuiltinToolPolicy, type ToolPolicy } from './tool-policy.ts'

// A single tool that the agent can call
export interface Tool {
  name: string
  description: string
  schema: Record<string, unknown> // JSON Schema
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload>
  readOnly(): boolean
  /** Declarative execution and capability metadata. Built-ins may inherit the central catalogue. */
  policy?: ToolPolicy
}

export interface ToolValidationEvidence {
  kind: 'recipe' | 'mixin' | 'game'
  valid: boolean
  version: '1.21.4'
  targetPath?: string
  checkedAt: number
  /** Present for deterministic in-game test sessions. */
  verdict?: 'PASS' | 'FAIL' | 'INCONCLUSIVE'
}

export interface ToolExecutionPayload {
  output: string
  artifactPaths?: string[]
  validation?: ToolValidationEvidence
  /** Optional PNG/JPEG base64 for vision-capable models (e.g. mc_screenshot). */
  imageBase64?: string
  imageMimeType?: string
}

// Optional preview interface for write tools
export interface Previewer {
  preview(args: Record<string, unknown>): FileDiff | null
}

// Context passed to every tool execution
export interface ToolContext {
  projectPath: string | null
  callId: string
  /** Identifies the parent Agent turn; late completions from old runs are ignored by the host. */
  runId?: string
  /** Identifies this concrete execution across renderer and main-process IPC. */
  executionId?: string
  abortSignal?: AbortSignal
  onProgress?: (chunk: string) => void
  planTracker?: PlanTracker | null
  onPlanStateChange?: (steps: PlanStepState[]) => void
  /** ACI: tracks files read this run for read-before-edit */
  fileSession?: FileSession
  /** GUI 布局预览回调：触发预览面板，返回用户确认后的布局 JSON。
   *  Promise 阻塞模式：工具 execute 等待用户确认后才返回结果。
   *  返回的 JSON 字符串包含 layoutType 和 elements 数组；
   *  若用户取消则返回 '{"cancelled": true}'。 */
  onGuiLayoutPreview?: (payload: {
    id: string
    title: string
    layoutType: GuiLayoutType
    html: string
    elements: GuiLayoutElement[]
  }) => Promise<string>
  /** 当前步骤是否已完成 GUI 布局预览（用户确认过布局 JSON）。
   *  edit_file/write_file 在写 GUI 文件前检查此标志，未完成则拦截并引导调用 gui_layout_preview。 */
  guiPreviewCompletedForStep?: boolean
  /** 当前步骤是否需要 GUI 布局预览（由 plan-normalizer 语义检测设置） */
  currentStepRequiresGuiPreview?: boolean
}

const MAX_TOOL_OUTPUT = 32 * 1024 // 32KB max output

function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT) return output
  const half = MAX_TOOL_OUTPUT / 2
  return (
    output.slice(0, half) +
    `\n\n...[内容过长，已截断]...\n\n` +
    output.slice(-half)
  )
}

function parseExitCode(output: string): number | null {
  const match = output.match(/\[exit code: (-?\d+)\]|\[退出码: (-?\d+)\]/)
  if (!match) return null
  return Number(match[1] ?? match[2])
}

export function inferToolError(toolName: string, output: string, exitCode: number | null): string | undefined {
  if (/^(Error|No project open)/i.test(output)) return output
  if (/^blocked:/i.test(output)) return output
  if (/环境准备失败/.test(output)) return output
  if (exitCode !== null && exitCode !== 0) return output
  if (toolName === 'trigger_build' && /BUILD FAILED/i.test(output)) return output
  // edit_file soft-failures previously returned ok:true and falsely satisfied write evidence
  if (
    toolName === 'edit_file' &&
    /未找到\s*old_string|未找到目标文本|old_string 匹配了多处|aci_read_gate|edit_gate/i.test(output)
  ) {
    return output
  }
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
  if (toolName === 'write_file' || toolName === 'read_file' || toolName === 'edit_file') {
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
    const side = typeof args.side === 'string' ? args.side : 'common'
    const fqn = String(args.mixinClass)
    if (side === 'client') return `src/client/java/${fqn.replace(/\./g, '/')}.java`
    return `src/main/java/${fqn.replace(/\./g, '/')}.java`
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
  /** All artifacts affected by this call. artifactPath remains for v1 compatibility. */
  artifactPaths?: string[]
  validation?: ToolValidationEvidence
  exitCode?: number | null
  errorKind?: string
  fileDiff?: FileDiff
  meta?: {
    mcPhase?: McPhase
    runClientStarted?: boolean
  }
  imageBase64?: string
  imageMimeType?: string
  outcome?: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
  runId?: string
  executionId?: string
}

export function parseTriggerBuildMeta(output: string): ToolResult['meta'] | undefined {
  const phaseMatch = output.match(/\[MC_PHASE:(\w+)\]/)
  if (!phaseMatch) return undefined
  const phase = phaseMatch[1] as McPhase
  return {
    mcPhase: phase,
    runClientStarted: phase === 'ready'
  }
}

/** Whether a tool result satisfies run-step advancement (main menu + soak complete). */
export function isRunClientReadyResult(result: ToolResult): boolean {
  const task = String(result.args?.task || result.args?.command || '')
  if (result.toolName === 'trigger_build' && task === 'runClient') {
    return Boolean(
      (result.meta?.runClientStarted && (result.meta?.mcPhase === 'ready' || result.meta?.mcPhase === 'menu')) ||
      /\[MC_PHASE:(ready|menu)\]/i.test(String(result.output))
    )
  }
  if (result.toolName === 'run_command' && /runClient/i.test(task)) {
    return result.exitCode === 0
  }
  return false
}

// ======== Registry ========

export class Registry {
  private tools = new Map<string, Tool>()
  private order: string[] = []

  add(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered`)
    }
    const policy = tool.policy ?? getBuiltinToolPolicy(tool.name)
    this.tools.set(tool.name, policy ? { ...tool, policy } : tool)
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

  policyFor(name: string): ToolPolicy | undefined {
    return this.tools.get(name)?.policy
  }

  /** Call after built-in registration. Custom test tools intentionally retain a permissive fallback. */
  validatePolicies(): void {
    const missing = this.order.filter((name) => !this.tools.get(name)?.policy)
    if (missing.length > 0) throw new Error(`Missing tool policy: ${missing.join(', ')}`)
  }
}

// ======== Execute helpers ========

// Extract tool call XML from AI output (ModCrafting format)
export function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  // 标准 ModCrafting 格式：<tool_call>{"name":"...","args":{...}}<tool_call>tool_call>
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
  // 兼容 MiniMax-M3 等模型输出的 XML invoke 格式：
  // <invoke name="tool_name"><parameter name="key">value</parameter></invoke>
  // 标准格式未命中时启用，避免误吞标准格式中的 XML 片段
  if (calls.length === 0) {
    calls.push(...parseInvokeXmlToolCalls(text))
  }
  return calls
}

/** 解析 `<invoke name="..."><parameter name="...">...</parameter></invoke>` XML 风格的工具调用。
 *  MiniMax-M3 在未走原生 delta.tool_calls 时，会将工具调用以这种 XML 格式输出到 content。 */
function parseInvokeXmlToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi
  let m: RegExpExecArray | null
  while ((m = invokeRe.exec(text)) !== null) {
    const name = m[1]
    const body = m[2] || ''
    const args: Record<string, unknown> = {}
    const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi
    let pm: RegExpExecArray | null
    while ((pm = paramRe.exec(body)) !== null) {
      args[pm[1]] = parseInvokeParamValue(pm[2] || '')
    }
    calls.push({ name, args })
  }
  return calls
}

/** 解析 `<parameter>` 值：仅对明确的 JSON 起始字符尝试 JSON.parse，
 *  避免将 `1.21.4`（多版本号）误判为数字 1.21。 */
function parseInvokeParamValue(raw: string): unknown {
  const v = raw.trim()
  if (v === '') return ''
  const first = v[0]
  if (first === '{' || first === '[' || first === '"' || v === 'true' || v === 'false' || v === 'null') {
    try { return JSON.parse(v) } catch { /* fall through */ }
  }
  // 仅纯整数或单点浮点（如 20、-1、3.14）转 number，含多版本号的 1.21.4 保留为字符串
  if (/^-?\d+$/.test(v) || /^-?\d+\.\d+$/.test(v)) {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return v
}

// Execute a single tool
export async function executeTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const start = Date.now()
  logger.tool(`Executing: ${tool.name}`, args)

  const policy = tool.policy
  const controller = new AbortController()
  const parentSignal = ctx.abortSignal
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error('Tool cancelled'))
  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  let idleTimeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const resetIdleTimer = (): void => {
    if (!policy?.idleTimeoutMs) return
    if (idleTimeout) clearTimeout(idleTimeout)
    idleTimeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Tool idle timeout after ${policy.idleTimeoutMs}ms`))
    }, policy.idleTimeoutMs)
  }
  if (policy?.timeoutMs) {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Tool timeout after ${policy.timeoutMs}ms`))
    }, policy.timeoutMs)
  }
  resetIdleTimer()
  const toolCtx: ToolContext = {
    ...ctx,
    abortSignal: controller.signal,
    onProgress: (chunk) => {
      resetIdleTimer()
      ctx.onProgress?.(chunk)
    }
  }

  try {
    // Racing is deliberate: third-party/legacy tools do not all consume AbortSignal.
    // Their late completion is detached and cannot hold this Agent turn hostage.
    const execution = tool.execute(toolCtx, args)
    execution.catch(() => {})
    const aborted = controller.signal.aborted
      ? Promise.reject<never>(controller.signal.reason ?? new Error('Tool cancelled'))
      : new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Tool cancelled')), { once: true })
        })
    const executed = await Promise.race([execution, aborted])
    const payload = typeof executed === 'string' ? undefined : executed
    const output = typeof executed === 'string' ? executed : executed.output
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

    const inferredArtifactPath = artifactPathFor(tool.name, args)
    const artifactPaths = payload?.artifactPaths?.length
      ? [...new Set(payload.artifactPaths)]
      : (inferredArtifactPath ? [inferredArtifactPath] : [])
    const artifactPath = artifactPaths[0]
    return {
      output: cleanedOutput,
      error: inferredError ? truncateOutput(inferredError) : undefined,
      durationMs: duration,
      ok: !inferredError,
      toolName: tool.name,
      args,
      artifactPath,
      artifactPaths,
      validation: payload?.validation,
      exitCode,
      fileDiff,
      meta,
      imageBase64: payload?.imageBase64,
      imageMimeType: payload?.imageMimeType,
      outcome: inferredError ? 'failed' : 'succeeded',
      runId: ctx.runId,
      executionId: ctx.executionId
    }
  } catch (err) {
    const duration = Date.now() - start
    let errMsg = err instanceof Error ? err.message : String(err)
    const cancelled = controller.signal.aborted && !timedOut
    const errorKind = timedOut ? 'tool_timeout' : cancelled ? 'tool_cancelled' : 'exception'
    if (timedOut) errMsg = `工具 ${tool.name} 超时：${errMsg}`
    if (cancelled) errMsg = `工具 ${tool.name} 已取消：${errMsg}`
    logger.tool(`Error: ${tool.name}`, errMsg)

    // File tools: diagnose the error with context
    if (tool.name === 'read_file' || tool.name === 'write_file' || tool.name === 'edit_file') {
      const filePath = typeof args.path === 'string' ? `${ctx.projectPath}/${args.path}` : ''
      errMsg = await diagnoseFileError(tool.name, ctx.projectPath, filePath, errMsg)
    }

    const artifactPath = artifactPathFor(tool.name, args)
    return {
      output: errMsg,
      error: errMsg,
      durationMs: duration,
      ok: false,
      toolName: tool.name,
      args,
      artifactPath,
      artifactPaths: artifactPath ? [artifactPath] : [],
      exitCode: null,
      errorKind,
      outcome: timedOut ? 'timed_out' : cancelled ? 'cancelled' : 'failed',
      runId: ctx.runId,
      executionId: ctx.executionId
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (idleTimeout) clearTimeout(idleTimeout)
    parentSignal?.removeEventListener('abort', abortFromParent)
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

  type NormalizedCall = { name: string; args: Record<string, unknown>; id: string }
  const normalized: NormalizedCall[] = calls.map((call) => ({
    ...call,
    id: call.id || `call_${Math.random().toString(36).slice(2, 8)}`
  }))
  const controlTools = new Set(['complete_step', 'ask_clarification'])

  const executeOne = async (call: NormalizedCall): Promise<void> => {
    onDispatch?.(call.name, call.id, call.args)
    if (ctx.abortSignal?.aborted) {
      const output = `工具 ${call.name} 已取消：未开始执行`
      const result: ToolResult = {
        output,
        error: output,
        durationMs: 0,
        ok: false,
        toolName: call.name,
        args: call.args,
        exitCode: null,
        errorKind: 'tool_cancelled',
        outcome: 'cancelled',
        runId: ctx.runId,
        executionId: ctx.runId ? `${ctx.runId}:${call.id}` : call.id
      }
      results.set(call.id, result)
      onResult?.(call.name, call.id, result)
      return
    }
    const tool = registry.get(call.name)
    if (!tool) {
      const output = `Error: unknown tool "${call.name}"`
      const result: ToolResult = {
        output,
        error: output,
        durationMs: 0,
        ok: false,
        toolName: call.name,
        args: call.args,
        exitCode: null,
        errorKind: 'unknown_tool'
      }
      results.set(call.id, result)
      onResult?.(call.name, call.id, result)
      return
    }

    const previewer = tool as unknown as Previewer
    const diff = tool.readOnly() ? null : (previewer.preview?.(call.args) ?? null)
    if (diff) logger.tool(`Preview: ${call.name}`, diff)
    const callCtx: ToolContext = {
      ...ctx,
      callId: call.id,
      executionId: ctx.runId ? `${ctx.runId}:${call.id}` : call.id,
      onProgress: onProgress ? (chunk) => onProgress(call.id, chunk) : undefined
    }
    const result = await executeTool(tool, call.args, callCtx)
    if (!result.fileDiff && diff) result.fileDiff = diff
    results.set(call.id, result)
    onResult?.(call.name, call.id, result)
  }

  // Preserve the model-declared order. Only adjacent pure reads may run in parallel;
  // a write or control call is a barrier, so write -> read observes the new state.
  let readGroup: NormalizedCall[] = []
  const flushReads = async (): Promise<void> => {
    if (readGroup.length === 0) return
    const group = readGroup
    readGroup = []
    // A bounded allSettled prevents one stalled legacy read from blocking the entire turn.
    const CONCURRENCY = 4
    for (let index = 0; index < group.length; index += CONCURRENCY) {
      await Promise.allSettled(group.slice(index, index + CONCURRENCY).map(executeOne))
    }
  }

  for (const call of normalized) {
    const tool = registry.get(call.name)
    const parallelRead = Boolean(tool?.readOnly()) && !controlTools.has(call.name)
    if (parallelRead) {
      readGroup.push(call)
      continue
    }
    await flushReads()
    await executeOne(call)
  }
  await flushReads()

  return results
}
