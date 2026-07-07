import { EventKind, type Event } from './events.ts'
import type { PlanTracker } from './plan-tracker.ts'
import { filterToolCallsForStep, isToolAllowedForStep, createRejectedToolResult, isRepairWriteBlocked, type ToolCallWithId, type ToolGateOptions } from './step-policy.ts'
import { executeBatch, type Registry, type ToolContext, type ToolResult } from './tools.ts'
import type { WorkflowRunResult, WorkflowStep } from './workflow-types.ts'
import {
  assistantToolCallMessage,
  type ChatMessage,
  type ModelToolCall,
  toolResultMessage
} from './chat-message.ts'
import { isRetryableFetchError, sleep, fetchRetryDelayMs } from './fetch-retry.ts'

export interface WorkflowModelResult {
  finishReason?: string
  toolCalls: ModelToolCall[]
  text: string
  reasoning: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cacheHitTokens?: number
    cacheMissTokens?: number
  }
}

export type WorkflowModelCall = (
  messages: ChatMessage[],
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  onChunk: (text: string, reasoning?: string) => void
) => Promise<WorkflowModelResult>

export interface WorkflowEngineOptions {
  steps: WorkflowStep[]
  planTracker: PlanTracker
  registry: Registry
  projectPath: string | null
  abortSignal?: AbortSignal
  emit: (event: Event) => void
  onToolDispatch?: (name: string, id: string) => void
  onToolResult?: (name: string, id: string, output: string) => void
  modelCall: WorkflowModelCall
}

let workflowToolId = 0

const MAX_REPAIR_ROUNDS = 3
const MAX_MODEL_NETWORK_RETRIES = 2
const REPAIR_EXTRA_TOOLS = [
  'write_file',
  'read_file',
  'read_error_log',
  'fabric_log_debugger',
  'fabric_docs_search'
] as const

export function isTerminalFailure(step: WorkflowStep, result: ToolResult): boolean {
  if (step.kind !== 'build' && step.kind !== 'run') return false
  const output = String(result.output || '')
  if (step.kind === 'build') {
    if (result.toolName !== 'trigger_build' && result.toolName !== 'run_command') return false
    if (/BUILD FAILED|构建失败/i.test(output)) return true
    if (result.exitCode != null && result.exitCode !== 0) return true
    return Boolean(result.error)
  }
  if (result.toolName === 'trigger_build') {
    if (String(result.args?.task || '') !== 'runClient') return false
    if (/Error starting game|启动失败|failed to start/i.test(output)) return true
    if (result.exitCode != null && result.exitCode !== 0) return true
    return Boolean(result.error)
  }
  if (result.toolName === 'run_command') {
    if (!/runClient/i.test(String(result.args?.command || ''))) return false
    if (result.exitCode != null && result.exitCode !== 0) return true
    return Boolean(result.error)
  }
  return false
}

function repairExtraTools(step: WorkflowStep): string[] {
  return [...new Set([...step.allowedTools, ...REPAIR_EXTRA_TOOLS])]
}

function buildRepairInstruction(output: string, kind: 'build' | 'run'): string {
  const tail = output.trim().split('\n').slice(-80).join('\n')
  const retry = kind === 'build' ? 'trigger_build build' : 'trigger_build runClient'
  return (
    `【${kind === 'build' ? '构建' : '运行'}失败，已进入修复模式】\n` +
    `必须先 read_error_log 或 fabric_log_debugger 分析错误，再用 write_file 修改代码。\n` +
    `在成功 write_file 之前禁止直接调用 ${retry}。\n` +
    `修改代码后再调用 ${retry} 验证修复结果。\n\n` +
    `--- 错误摘要 ---\n${tail}`
  )
}

function writeFileRetryInstruction(kind: 'build' | 'run'): string {
  const retry = kind === 'build' ? 'trigger_build build' : 'trigger_build runClient'
  return `【SYSTEM: 文件已修改，可以重新构建。请调用 ${retry} 验证修复结果。】`
}

const REPAIR_DIAGNOSTIC_TOOLS = new Set([
  'read_error_log',
  'fabric_log_debugger',
  'read_file',
  'list_directory',
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'vanilla_mc_wiki_query',
  'fabric_meta_version_check',
  'fabric_mod_json_validate'
])

function isRepairDiagnosticResult(step: WorkflowStep, result: ToolResult, repairMode: boolean): boolean {
  if (!repairMode || !result.ok || result.error) return false
  if (step.kind !== 'build' && step.kind !== 'run') return false
  return REPAIR_DIAGNOSTIC_TOOLS.has(result.toolName || '')
}

/** Knowledge queries that should not consume attempt budget for non-terminal steps. */
const KNOWLEDGE_TOOLS = new Set([
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'vanilla_mc_wiki_query',
  'fabric_meta_version_check',
  'fabric_mod_json_validate'
])

function isKnowledgeRound(step: WorkflowStep, result: ToolResult | undefined): boolean {
  if (!result || !result.ok || result.error) return false
  if (step.kind === 'build' || step.kind === 'run') return false
  return KNOWLEDGE_TOOLS.has(result.toolName || '')
}

function statusForPlan(step: WorkflowStep): string {
  if (step.status === 'failed') return 'error'
  return step.status
}

function normalizeModelToolCalls(
  toolCalls: Array<{ id?: string; name: string; args: Record<string, unknown>; rawArguments?: string }>
): ModelToolCall[] {
  return toolCalls.map((call) => ({
    id: call.id || `workflow_call_${++workflowToolId}`,
    name: call.name,
    args: call.args,
    rawArguments: call.rawArguments || JSON.stringify(call.args)
  }))
}

function resultCompletesStep(step: WorkflowStep, result: ToolResult): boolean {
  if (!result.ok || result.error) return false
  switch (step.kind) {
    case 'inspect':
      return Boolean(result.toolName) && [
        'read_file',
        'list_directory',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate',
        'fabric_log_debugger',
        'read_error_log'
      ].includes(result.toolName)
    case 'recipe':
      return result.toolName === 'create_recipe' || result.toolName === 'fabric_recipe_generate'
    case 'write':
      return Boolean(result.toolName) && [
        'write_file',
        'create_recipe',
        'fabric_recipe_generate',
        'fabric_content_register',
        'fabric_data_assets_generate',
        'fabric_mixin_scaffold'
      ].includes(result.toolName)
    case 'build':
      return (
        (result.toolName === 'trigger_build' &&
          String(result.args?.task || 'build') === 'build' &&
          (result.exitCode == null || result.exitCode === 0)) ||
        (result.toolName === 'run_command' && result.exitCode === 0)
      )
    case 'run':
      return (
        (result.toolName === 'trigger_build' &&
          String(result.args?.task || '') === 'runClient' &&
          (result.meta?.runClientStarted || result.meta?.mcPhase === 'playing')) ||
        (result.toolName === 'run_command' && /runClient/i.test(String(result.args?.command || '')) && result.exitCode === 0)
      )
    case 'answer':
      return true
  }
}

export class WorkflowEngine {
  private steps: WorkflowStep[]
  private planTracker: PlanTracker
  private registry: Registry
  private projectPath: string | null
  private abortSignal?: AbortSignal
  private emit: (event: Event) => void
  private onToolDispatch?: (name: string, id: string) => void
  private onToolResult?: (name: string, id: string, output: string) => void
  private modelCall: WorkflowModelCall

  constructor(options: WorkflowEngineOptions) {
    this.steps = options.steps
    this.planTracker = options.planTracker
    this.registry = options.registry
    this.projectPath = options.projectPath
    this.abortSignal = options.abortSignal
    this.emit = options.emit
    this.onToolDispatch = options.onToolDispatch
    this.onToolResult = options.onToolResult
    this.modelCall = options.modelCall
  }

  private planState(): Array<{ id: string; description: string; status: string }> {
    return this.steps.map((step) => ({
      id: step.id,
      description: step.title,
      status: statusForPlan(step)
    }))
  }

  private emitPlanState(): void {
    this.emit({ kind: EventKind.PlanState, planSteps: this.planState() })
  }

  private currentStep(): WorkflowStep | null {
    return this.steps.find((step) => step.status === 'running')
      ?? this.steps.find((step) => step.status === 'pending')
      ?? null
  }

  private toolSchemasFor(step: WorkflowStep, repairMode: boolean): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    const names = repairMode ? repairExtraTools(step) : step.allowedTools
    return this.registry.schemas().filter((tool) => names.includes(tool.name))
  }

  private workflowPrompt(step: WorkflowStep, repairMode: boolean, repairWriteRequired: boolean): ChatMessage {
    const tools = repairMode ? repairExtraTools(step) : step.allowedTools
    const prefix = repairMode ? '【修复模式】' : '【工作流步骤】'
    const repairGate =
      repairMode && repairWriteRequired
        ? '必须先 write_file 修改代码后才能 trigger_build / run_command；禁止在未修改代码时直接重编译。\n'
        : ''
    return {
      role: 'user',
      content:
        `${prefix}${repairGate}只执行当前步骤，不要重复已完成操作。\n` +
        `当前步骤 #${step.id}: ${step.title}\n类型: ${step.kind}\n允许工具: ${tools.join(', ') || '无'}\n` +
        `如果需要工具，只能调用允许工具列表中的工具。工具成功后主机会自动推进。`
    }
  }

  private emitRejected(callId: string, result: ToolResult): void {
    this.emit({
      kind: EventKind.ToolDispatch,
      tool: { id: callId, name: result.toolName || 'unknown', args: JSON.stringify(result.args || {}) }
    })
    this.emit({
      kind: EventKind.ToolResult,
      tool: {
        id: callId,
        name: result.toolName || 'unknown',
        args: '',
        output: result.output,
        error: result.error,
        durationMs: result.durationMs
      }
    })
    this.onToolResult?.(result.toolName || 'unknown', callId, result.output)
  }

  private async executeAllowedCalls(step: WorkflowStep, calls: ToolCallWithId[]): Promise<Map<string, ToolResult>> {
    if (calls.length === 0) return new Map()
    const MAX_PARALLEL = 8
    const selected = calls.slice(0, MAX_PARALLEL)
    const ctx: ToolContext = {
      projectPath: this.projectPath,
      callId: `workflow_${step.id}`,
      abortSignal: this.abortSignal,
      planTracker: this.planTracker,
      onPlanStateChange: () => this.emitPlanState()
    }
    return executeBatch(
      selected,
      this.registry,
      ctx,
      (name, id, args) => {
        const tool = this.registry.get(name)
        this.emit({ kind: EventKind.ToolDispatch, tool: { id, name, args: JSON.stringify(args), readOnly: tool?.readOnly() } })
        this.onToolDispatch?.(name, id)
      },
      (name, id, result) => {
        this.emit({
          kind: EventKind.ToolResult,
          tool: { id, name, args: JSON.stringify(result.args || {}), output: result.output, error: result.error, durationMs: result.durationMs, fileDiff: result.fileDiff }
        })
        this.onToolResult?.(name, id, result.output)
      },
      (id, chunk) => {
        this.emit({ kind: EventKind.ToolProgress, tool: { id, name: '', args: '', partial: true, output: chunk } })
      }
    )
  }

  private appendToolRound(
    baseMessages: ChatMessage[],
    streamContent: string,
    calls: ModelToolCall[],
    resultsById: Map<string, ToolResult>,
    instruction?: string
  ): void {
    baseMessages.push(assistantToolCallMessage(streamContent, calls))
    for (const call of calls) {
      const result = resultsById.get(call.id)
      baseMessages.push(toolResultMessage(call, result?.output ?? ''))
    }
    if (instruction?.trim()) {
      baseMessages.push({ role: 'system', content: instruction.trim() })
    }
  }

  async run(baseMessages: ChatMessage[]): Promise<WorkflowRunResult> {
    let finalContent = ''
    this.emitPlanState()

    while (!this.abortSignal?.aborted) {
      const step = this.currentStep()
      if (!step) break
      if (step.status === 'pending') step.status = 'running'
      this.emitPlanState()

      let completed = false
      let repairMode = false
      let repairWriteRequired = false
      let repairRounds = 0
      let lastFailureOutput = ''
      let attempt = 0
      let loopIterations = 0
      let modelNetworkRetries = 0
      const maxIterations = step.maxAttempts + MAX_REPAIR_ROUNDS
      const maxLoopIterations = maxIterations + MAX_REPAIR_ROUNDS * 8

      while (!completed && attempt < maxIterations && loopIterations < maxLoopIterations) {
        loopIterations++
        const policyOptions: ToolGateOptions | undefined = repairMode
          ? { repairMode: true, repairWriteRequired }
          : undefined
        const modelMessages = [...baseMessages, this.workflowPrompt(step, repairMode, repairWriteRequired)]
        const allowedTools = this.toolSchemasFor(step, repairMode)
        let streamText = ''
        let streamReasoning = ''
        let modelResult: WorkflowModelResult
        try {
          modelResult = await this.modelCall(modelMessages, allowedTools, (text, reasoning) => {
            if (text) streamText = text
            if (reasoning) streamReasoning = reasoning
          })
          modelNetworkRetries = 0
        } catch (err: unknown) {
          if (this.abortSignal?.aborted) break
          const errMsg = err instanceof Error ? err.message : String(err)
          if (isRetryableFetchError(err) && modelNetworkRetries < MAX_MODEL_NETWORK_RETRIES) {
            modelNetworkRetries++
            loopIterations--
            const delay = fetchRetryDelayMs(modelNetworkRetries - 1)
            baseMessages.push({
              role: 'user',
              content:
                `【系统】模型 API 暂时不可用（${errMsg}），${Math.round(delay / 1000)}s 后重试本步骤（${modelNetworkRetries}/${MAX_MODEL_NETWORK_RETRIES}）。`
            })
            await sleep(delay)
            continue
          }
          const remaining = this.steps
            .filter((s) => s.status !== 'completed')
            .map((s) => `#${s.id} ${s.title}`)
            .join('\n')
          return {
            finalContent:
              finalContent.trim() ||
              `步骤 #${step.id}「${step.title}」因网络错误中断：${errMsg}\n\n` +
              `发送「继续」可从当前步骤恢复。\n\n未完成步骤：\n${remaining}`,
            allDone: false,
            partial: true,
            steps: this.steps
          }
        }
        finalContent = modelResult.text || streamText || finalContent

        const calls = normalizeModelToolCalls(modelResult.toolCalls)
        if (calls.length === 0) {
          baseMessages.push({
            role: 'user',
            content: `【系统】当前步骤尚未完成：#${step.id} ${step.title}。请调用允许工具完成该步骤。`
          })
          attempt++
          continue
        }

        const gate = filterToolCallsForStep(step, calls, policyOptions)
        const resultsById = new Map<string, ToolResult>()

        for (const call of calls) {
          if (!isToolAllowedForStep(step, call, policyOptions)) {
            const rejected = createRejectedToolResult(step, call, policyOptions)
            this.emitRejected(call.id, rejected)
            resultsById.set(call.id, rejected)
          }
        }

        if (gate.allowed.length === 0) {
          const repairWriteBlockedOnly =
            repairMode &&
            repairWriteRequired &&
            calls.length > 0 &&
            calls.every((call) => isRepairWriteBlocked(step, call, policyOptions))
          const rejectionHint = [
            gate.rejected.map((r) => r.output).join('\n'),
            repairWriteBlockedOnly
              ? '修复模式下必须先 write_file 修改代码，再重新构建。'
              : `本步骤允许的工具：${(repairMode ? repairExtraTools(step) : step.allowedTools).join(', ') || '无'}。请改用其中之一完成当前步骤。`
          ].join('\n\n')
          this.appendToolRound(
            baseMessages,
            modelResult.text || streamText,
            calls,
            resultsById,
            rejectionHint
          )
          if (!repairWriteBlockedOnly) attempt++
          continue
        }

        const executed = await this.executeAllowedCalls(step, gate.allowed)
        for (const [id, result] of executed) {
          resultsById.set(id, result)
        }

        const primaryResult = resultsById.get(gate.allowed[0].id)
        const success = primaryResult ? resultCompletesStep(step, primaryResult) : undefined
        let roundInstruction: string | undefined

        if (success) {
          repairMode = false
          repairWriteRequired = false
          repairRounds = 0
          this.appendToolRound(baseMessages, modelResult.text || streamText, calls, resultsById)
          step.status = 'completed'
          this.planTracker.advanceCurrent(primaryResult!.toolName || 'workflow evidence')
          completed = true
          this.emitPlanState()
          break
        }

        if (primaryResult && isTerminalFailure(step, primaryResult)) {
          repairMode = true
          repairWriteRequired = true
          repairRounds++
          lastFailureOutput = primaryResult.output
          roundInstruction = buildRepairInstruction(lastFailureOutput, step.kind as 'build' | 'run')
          this.appendToolRound(baseMessages, modelResult.text || streamText, calls, resultsById, roundInstruction)
          if (repairRounds > MAX_REPAIR_ROUNDS) {
            attempt = maxIterations
            break
          }
          continue
        }

        if (
          repairMode &&
          primaryResult?.toolName === 'write_file' &&
          primaryResult.ok &&
          !primaryResult.error
        ) {
          repairWriteRequired = false
          roundInstruction = writeFileRetryInstruction(step.kind as 'build' | 'run')
          this.appendToolRound(baseMessages, modelResult.text || streamText, calls, resultsById, roundInstruction)
          continue
        }

        this.appendToolRound(baseMessages, modelResult.text || streamText, calls, resultsById)
        if (
          !(repairMode && primaryResult && isRepairDiagnosticResult(step, primaryResult, repairMode)) &&
          !isKnowledgeRound(step, primaryResult)
        ) {
          attempt++
        }
      }

      if (!completed && step.status !== 'completed') {
        step.status = 'failed'
        this.emitPlanState()
        const remaining = this.steps
          .filter((s) => s.status !== 'completed')
          .map((s) => `#${s.id} ${s.title}`)
          .join('\n')
        const repairNote =
          repairRounds > MAX_REPAIR_ROUNDS
            ? `已尝试 ${MAX_REPAIR_ROUNDS} 轮自动修复仍未成功。\n\n最后错误：\n${lastFailureOutput.trim().split('\n').slice(-40).join('\n')}\n\n`
            : ''
        return {
          finalContent:
            finalContent.trim() ||
            `步骤 #${step.id}「${step.title}」未能自动完成，已暂停执行。\n\n` +
            repairNote +
            `建议：请根据错误日志使用 write_file 修复后，可手动点击面板「发送给 AI 修复」继续。\n\n` +
            `未完成步骤：\n${remaining}`,
          allDone: false,
          partial: true,
          steps: this.steps
        }
      }
    }

    const allDone = this.steps.every((step) => step.status === 'completed')
    return {
      finalContent: finalContent || (allDone ? '全部计划步骤已完成。' : '工作流已停止。'),
      allDone,
      partial: !allDone,
      steps: this.steps
    }
  }
}
