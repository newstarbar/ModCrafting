// ======== Agent ========
// Reasonix-style agent loop: stream → tool calls → execute → loop
// Features: readonly-tool round limit, clean message history, kick mechanism

import type { Sink, Event } from './events'
import { EventKind } from './events'
import { type Registry, executeBatch, parseToolCalls, type ToolContext, type ToolResult } from './tools'
import type { PlanTracker } from './plan-tracker'
import { normalizeWorkflowSteps } from './plan-normalizer'
import { WorkflowEngine } from './workflow-engine'
import { finalizeTerminalSteps } from './finalize-terminal'
import { logger } from '../utils/logger'
import { isRepeatGuardedToolCall } from './repeat-guard.ts'
import {
  appendToolRoundHistory,
  type ChatMessage,
  type ModelToolCall
} from './chat-message.ts'
import {
  MAX_FETCH_RETRIES,
  fetchRetryDelayMs,
  isRetryableFetchError,
  sleep
} from './fetch-retry.ts'

export { isRepeatGuardedToolCall } from './repeat-guard.ts'
export type { ChatMessage } from './chat-message.ts'

let _toolCallIdCounter = 0

export interface AgentOptions {
  registry: Registry
  sink: Sink
  maxSteps?: number
  onToolDispatch?: (name: string, id: string) => void
  onToolResult?: (name: string, id: string, output: string) => void
}

export interface RunOptions {
  phase?: 'plan' | 'execute'
  emitLifecycle?: boolean
  planTracker?: PlanTracker | null
  opsOnlyPlan?: boolean
  turnMode?: 'chat' | 'develop' | 'plan_only' | 'resume'
  composerMode?: 'agent' | 'plan' | 'ask'
}

const MAX_READONLY_ROUNDS = 3
const REPEAT_SUCCESS_THRESHOLD = 2
const MAX_FINAL_READINESS_BLOCKS = 3
const EXPLORATION_TOOL_NAMES = ['list_directory', 'read_file', 'read_error_log', 'run_command']
const EXPLORATION_TOOLS = EXPLORATION_TOOL_NAMES
const CONTROL_TOOL_NAMES = ['complete_step']

function stableStringify(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  const sorted: Record<string, unknown> = {}
  for (const k of keys) sorted[k] = args[k]
  return JSON.stringify(sorted)
}

function repeatSuccessSignature(name: string, args: Record<string, unknown>): string {
  return `${name}\0${stableStringify(args)}`
}

export class Agent {
  private registry: Registry
  private sink: Sink
  maxSteps: number
  onToolDispatch?: (name: string, id: string) => void
  onToolResult?: (name: string, id: string, output: string) => void
  // Once locked, readonly tools stay removed for the entire run
  private readonlyLocked = false

  // Track written files to detect duplicate writes
  private writtenFiles = new Map<string, string>()
  private consecutiveWriteOnlyRounds = 0
  private repeatSuccessCounts = new Map<string, number>()
  private finalReadinessBlocks = 0
  private graceRound = false
  clarificationPending = false
  // Rounds where every tool call was rejected by the loop guard (no progress)
  private consecutiveBlockedRounds = 0
  // Rounds where the model only called complete_step without any real work
  private consecutiveStepDoneOnlyRounds = 0
  // Rounds where model outputs mostly reasoning (>80%) with no tool calls
  private consecutiveReasoningOnlyRounds = 0
  // Rounds with no file writes and no build/run progress
  private consecutiveIdleRounds = 0
  private runLifecycleMeta: Pick<RunOptions, 'turnMode' | 'composerMode'> = {}

  constructor(opts: AgentOptions) {
    this.registry = opts.registry
    this.sink = opts.sink
    this.maxSteps = opts.maxSteps ?? 0 // 0 = unlimited
    this.onToolDispatch = opts.onToolDispatch
    this.onToolResult = opts.onToolResult
  }

  setRegistry(registry: Registry): void {
    this.registry = registry
  }

  resetRunState(): void {
    this.readonlyLocked = false
    this.writtenFiles.clear()
    this.consecutiveWriteOnlyRounds = 0
    this.repeatSuccessCounts.clear()
    this.finalReadinessBlocks = 0
    this.graceRound = false
    this.consecutiveBlockedRounds = 0
    this.consecutiveStepDoneOnlyRounds = 0
    this.consecutiveReasoningOnlyRounds = 0
    this.consecutiveIdleRounds = 0
    this.clarificationPending = false
  }

  private checkRepeatedSuccessBlock(name: string, args: Record<string, unknown>): string | null {
    if (!isRepeatGuardedToolCall(name, args)) return null
    const sig = repeatSuccessSignature(name, args)
    const count = this.repeatSuccessCounts.get(sig) ?? 0
    if (count < REPEAT_SUCCESS_THRESHOLD) return null
    return (
      `blocked: [loop guard] "${name}" 已用相同参数成功执行 ${count} 次。` +
      `请换用当前步骤所需的其他工具，勿重复执行。`
    )
  }

  private recordRepeatSuccess(name: string, args: Record<string, unknown>, hadError: boolean): void {
    if (hadError || !isRepeatGuardedToolCall(name, args)) return
    const sig = repeatSuccessSignature(name, args)
    this.repeatSuccessCounts.set(sig, (this.repeatSuccessCounts.get(sig) ?? 0) + 1)
  }

  private filterExplorationTools(
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return tools.filter((t) => !EXPLORATION_TOOL_NAMES.includes(t.name))
  }

  private filterControlTools(
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return tools.filter((t) => !CONTROL_TOOL_NAMES.includes(t.name))
  }

  private emit(e: Event): void { this.sink.emit(e) }

  private finishRun(emitLifecycle: boolean, error?: string, phase?: string): void {
    if (emitLifecycle) {
      this.emit({
        kind: EventKind.TurnDone,
        error,
        phase,
        turnMode: this.runLifecycleMeta.turnMode,
        composerMode: this.runLifecycleMeta.composerMode
      })
    }
  }

  private async runWorkflow(
    apiEndpoint: string,
    apiKey: string,
    apiModel: string,
    messages: ChatMessage[],
    projectPath: string | null,
    planTracker: PlanTracker,
    emitLifecycle: boolean,
    abortSignal?: AbortSignal,
    onStream?: (text: string, reasoning?: string) => void
  ): Promise<string> {
    const engine = new WorkflowEngine({
      steps: normalizeWorkflowSteps(planTracker.steps),
      planTracker,
      registry: this.registry,
      projectPath,
      abortSignal,
      emit: (event) => this.emit(event),
      onToolDispatch: this.onToolDispatch,
      onToolResult: this.onToolResult,
      modelCall: async (workflowMessages, tools, onChunk) => {
        let text = ''
        let reasoningText = ''
        const result = await this.streamFromAPI(
          apiEndpoint,
          apiKey,
          apiModel,
          workflowMessages,
          tools,
          abortSignal,
          (chunk, reasoning) => {
            if (chunk) {
              text += chunk
              this.emit({ kind: EventKind.Text, text: chunk })
            }
            if (reasoning) {
              reasoningText += reasoning
              this.emit({ kind: EventKind.Reasoning, text: reasoning })
            }
            onChunk(chunk, reasoning)
            onStream?.(text, reasoningText)
          },
          4096
        )
        this.emit({ kind: EventKind.Message, text, reasoning: reasoningText })
        if (result.usage && (result.usage.promptTokens || result.usage.totalTokens || result.usage.completionTokens)) {
          const u = result.usage
          this.emit({
            kind: EventKind.Usage,
            usage: {
              promptTokens: u.promptTokens ?? 0,
              completionTokens: u.completionTokens ?? 0,
              totalTokens: u.totalTokens ?? ((u.promptTokens ?? 0) + (u.completionTokens ?? 0)),
              cacheHitTokens: u.cacheHitTokens,
              cacheMissTokens: u.cacheMissTokens,
              finishReason: result.finishReason
            }
          })
        }
        return {
          finishReason: result.finishReason,
          toolCalls: result.toolCalls,
          text,
          reasoning: reasoningText,
          usage: result.usage
        }
      }
    })
    try {
      const result = await engine.run(messages)

      if (result.needsClarification) {
        this.clarificationPending = true
        this.emit({
          kind: EventKind.ClarificationNeeded,
          clarification: {
            question: result.clarificationQuestion || result.finalContent || '',
            options: result.clarificationOptions
          }
        })
        return result.finalContent
      }

      if (result.finalContent.trim()) {
        messages.push({ role: 'assistant', content: result.finalContent })
      }
      if (result.allDone) {
        await finalizeTerminalSteps({
          planTracker,
          projectPath,
          emit: (event) => this.emit(event)
        })
      } else if (result.partial) {
        this.emit({
          kind: EventKind.Notice,
          notice: {
            level: 'warn',
            text: '部分步骤未完成，已暂停自动执行。发送「继续」可从当前步骤恢复。'
          }
        })
      }
      this.finishRun(emitLifecycle)
      return result.finalContent
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.finishRun(emitLifecycle, 'Cancelled')
        return ''
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Workflow error', errMsg)
      const remaining = planTracker.toContextBlock()
      const partial =
        `执行因错误中断：${errMsg}\n\n` +
        (remaining ? `当前计划进度：\n${remaining}\n\n` : '') +
        '发送「继续」可从当前步骤恢复执行。'
      messages.push({ role: 'assistant', content: partial })
      this.emit({
        kind: EventKind.Notice,
        notice: {
          level: 'error',
          text: isRetryableFetchError(err)
            ? `网络请求失败：${errMsg}。计划未完成，可发送「继续」恢复。`
            : `执行中断：${errMsg}`
        }
      })
      this.finishRun(emitLifecycle, errMsg)
      return partial
    }
  }

  async run(
    apiEndpoint: string, apiKey: string, apiModel: string,
    messages: ChatMessage[],
    projectPath: string | null,
    abortSignal?: AbortSignal,
    onStream?: (text: string, reasoning?: string) => void,
    options: RunOptions = {}
  ): Promise<string> {
    const phase = options.phase ?? 'execute'
    const emitLifecycle = options.emitLifecycle ?? true
    const planTracker = options.planTracker ?? null
    const opsOnlyPlan = options.opsOnlyPlan ?? false
    this.runLifecycleMeta = {
      turnMode: options.turnMode,
      composerMode: options.composerMode
    }

    if (options.opsOnlyPlan) {
      this.readonlyLocked = true
    }

    if (emitLifecycle) {
      this.emit({ kind: EventKind.TurnStarted })
    }
    logger.agent('Run started', { model: apiModel, phase, steps: this.maxSteps || 'unlimited' })

    if (phase === 'execute' && planTracker) {
      return this.runWorkflow(
        apiEndpoint,
        apiKey,
        apiModel,
        messages,
        projectPath,
        planTracker,
        emitLifecycle,
        abortSignal,
        onStream
      )
    }

    let finalContent = ''
    let readonlyRounds = 0

    for (let step = 0; ; step++) {
      const pastMax = this.maxSteps > 0 && step >= this.maxSteps
      if (pastMax && !this.graceRound) {
        this.graceRound = true
        const incomplete = planTracker && !planTracker.allDone()
          ? `\n未完成步骤：\n${planTracker.toContextBlock()}`
          : ''
        messages.push({
          role: 'user',
          content:
            `【系统】已达工具轮次上限（${this.maxSteps}）。不要再调用任何工具。` +
            `输出当前进度总结。${incomplete}`
        })
        this.emit({
          kind: EventKind.Notice,
          notice: {
            level: 'warn',
            text: incomplete ? '部分步骤未完成（已达轮次上限）' : `已达轮次上限（${this.maxSteps}）`
          }
        })
        continue
      }
      if (pastMax && this.graceRound) {
        break
      }
      if (this.maxSteps === 0 || step < this.maxSteps) {
        logger.agent(`Step ${step + 1}${this.maxSteps > 0 ? '/' + this.maxSteps : ''}`)
      }
      if (abortSignal?.aborted) {
        this.finishRun(emitLifecycle, 'Cancelled')
        return finalContent
      }

      // Build clean API messages: first system + everything else
      const systemIdx = messages.findIndex((m) => m.role === 'system')
      const apiMessages: ChatMessage[] = systemIdx >= 0
        ? [{ ...messages[systemIdx] }, ...messages.slice(systemIdx + 1)]
        : messages

      // Plan phase: only ask_clarification; execute phase: full registry with exploration limits
      let availableTools =
        phase === 'plan'
          ? this.registry.schemas().filter((t) => t.name === 'ask_clarification')
          : this.filterControlTools(this.registry.schemas())
      if (this.graceRound) {
        availableTools = []
      } else if (phase === 'execute') {
        if (this.readonlyLocked) {
          availableTools = this.filterExplorationTools(availableTools)
        } else if (readonlyRounds >= MAX_READONLY_ROUNDS) {
          this.readonlyLocked = true
          readonlyRounds = 0
          availableTools = this.filterExplorationTools(availableTools)
          const kick = 'STOP EXPLORING. You have spent too many rounds reading files, listing directories, and running diagnostic commands. run_command, read_file, and list_directory are now LOCKED. You can ONLY write files (write_file) or build/run (trigger_build). Make a decision and execute it NOW.'
          messages.push({ role: 'user', content: kick })
          apiMessages.push({ role: 'user', content: kick })
          logger.agent('KICK: exploration tools permanently removed')
        }
      }

      // 1. Stream
      let streamContent = ''
      let streamReasoning = ''

      try {
        const result = await this.streamFromAPI(
          apiEndpoint, apiKey, apiModel, apiMessages, availableTools, abortSignal,
          (text, reasoning) => {
            if (text) { streamContent += text; this.emit({ kind: EventKind.Text, text }) }
            if (reasoning) { streamReasoning += reasoning; this.emit({ kind: EventKind.Reasoning, text: reasoning }) }
            onStream?.(streamContent, streamReasoning)
          },
          phase === 'plan' ? 8192 : 4096
        )

        this.emit({ kind: EventKind.Message, text: streamContent, reasoning: streamReasoning })

        if (result.usage && (result.usage.promptTokens || result.usage.totalTokens || result.usage.completionTokens)) {
          const u = result.usage
          this.emit({
            kind: EventKind.Usage,
            usage: {
              promptTokens: u.promptTokens ?? 0,
              completionTokens: u.completionTokens ?? 0,
              totalTokens: u.totalTokens ?? ((u.promptTokens ?? 0) + (u.completionTokens ?? 0)),
              cacheHitTokens: u.cacheHitTokens,
              cacheMissTokens: u.cacheMissTokens,
              finishReason: result.finishReason
            }
          })
        }

        if (result.finishReason === 'length') {
          this.emit({ kind: EventKind.Notice, notice: { level: 'warn', text: 'Response truncated' } })
        }

        const toolCalls = result.toolCalls
        const cleanText = streamContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
        finalContent = cleanText || streamContent

        // Final answer — plan phase always ends here; execute phase may kick if idle
        if (toolCalls.length === 0) {
          if (phase === 'execute' && planTracker && !planTracker.allDone() && !this.graceRound) {
            this.finalReadinessBlocks++
            const remaining = planTracker.toContextBlock()
            const cur = planTracker.currentStep
            const stepHint = cur
              ? `请继续执行步骤 #${cur.id}：${cur.description}。系统会根据工具结果推进步骤。`
              : ''
            messages.push({
              role: 'user',
              content: `【系统】尚有未完成步骤，不可结束本轮。\n${remaining}\n${stepHint}`
            })
            logger.agent('finalReadinessCheck blocked', { blocks: this.finalReadinessBlocks })
            if (this.finalReadinessBlocks >= MAX_FINAL_READINESS_BLOCKS) {
              finalContent = finalContent || `执行未完成。剩余计划：\n${remaining}`
              this.emit({
                kind: EventKind.Notice,
                notice: { level: 'warn', text: '步骤未全部完成，已结束本轮' }
              })
              logger.agent('Final answer (readiness cap)', { step, phase })
              this.finishRun(emitLifecycle)
              return finalContent
            }
            continue
          }
          if (phase === 'execute') {
            const anyToolCalled = messages.some((m) =>
              m.role === 'tool' || (m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0)
            )
            if (!anyToolCalled && (cleanText || streamContent).length > 80 && !planTracker) {
              const kick = '【系统警告】你只输出了文字，没有调用任何工具！立即调用 write_file 或其他工具来实际操作项目，不要只说话不做事。可用的工具：write_file（写入文件）、trigger_build（触发构建）。'
              messages.push({ role: 'user', content: kick })
              logger.agent('KICK: no tools called, forcing action')
              continue
            }
          }
          if (finalContent.trim()) {
            messages.push({ role: 'assistant', content: finalContent })
          }
          logger.agent('Final answer', { step, phase })
          this.finishRun(emitLifecycle)
          return finalContent
        }

        // Plan phase should not receive tool calls (tools disabled)
        if (phase === 'plan') {
          logger.agent('Unexpected tool calls in plan phase, ignoring')
          if (finalContent.trim()) {
            messages.push({ role: 'assistant', content: finalContent })
          }
          this.finishRun(emitLifecycle)
          return finalContent
        }

        // Track exploration rounds (readonly + diagnostic run_command)
        const allExploration = toolCalls.every((tc) =>
          EXPLORATION_TOOLS.includes(tc.name)
        )
        if (allExploration) readonlyRounds++
        else readonlyRounds = 0

        // Detect model stuck in reasoning: >80% reasoning tokens, no tool calls
        if (toolCalls.length === 0 && streamReasoning.length > streamContent.length * 4) {
          this.consecutiveReasoningOnlyRounds++
        } else {
          this.consecutiveReasoningOnlyRounds = 0
        }
        if (this.consecutiveReasoningOnlyRounds >= 2) {
          messages.push({
            role: 'user',
            content: '你已经思考足够久，请直接调用工具执行，不要继续推理分析。'
          })
          this.consecutiveReasoningOnlyRounds = 0
          logger.agent('KICK: reasoning-only rounds cap reached')
        }

        // 2. Execute tools (with repeat-success loop guard)
        logger.agent(`Executing ${toolCalls.length} tool(s)`, toolCalls.map((t) => t.name))

        const callsWithIds: ModelToolCall[] = toolCalls.map((tc) => ({
          id: tc.id || `call_${++_toolCallIdCounter}`,
          name: tc.name,
          args: tc.args,
          rawArguments: tc.rawArguments || JSON.stringify(tc.args)
        }))
        const executableCalls: typeof callsWithIds = []
        const blockedResults = new Map<string, ToolResult>()

        for (const call of callsWithIds) {
          const blockMsg = this.checkRepeatedSuccessBlock(call.name, call.args)
          if (blockMsg) {
            const tool = this.registry.get(call.name)
            this.emit({
              kind: EventKind.ToolDispatch,
              tool: { id: call.id, name: call.name, args: JSON.stringify(call.args), readOnly: tool?.readOnly() }
            })
            this.onToolDispatch?.(call.name, call.id)
            blockedResults.set(call.id, {
              output: blockMsg,
              error: blockMsg,
              durationMs: 0,
              ok: false,
              toolName: call.name,
              args: call.args,
              exitCode: null,
              errorKind: 'loop_guard'
            })
            this.emit({
              kind: EventKind.ToolResult,
              tool: { id: call.id, name: call.name, args: JSON.stringify(call.args), output: blockMsg, error: blockMsg, durationMs: 0 }
            })
            this.onToolResult?.(call.name, call.id, blockMsg)
            logger.agent('loop guard blocked', { tool: call.name, args: call.args })
            continue
          }
          executableCalls.push(call)
        }

        const ctx: ToolContext = {
          projectPath,
          callId: `step_${step}`,
          abortSignal,
          planTracker,
          onPlanStateChange: (steps) => {
            this.emit({ kind: EventKind.PlanState, planSteps: steps })
          }
        }

        const results = blockedResults
        if (executableCalls.length > 0) {
          const batchResults = await executeBatch(
            executableCalls,
            this.registry, ctx,
            (name, id, args) => {
              const tool = this.registry.get(name)
              this.emit({ kind: EventKind.ToolDispatch, tool: { id, name, args: JSON.stringify(args), readOnly: tool?.readOnly() } })
              this.onToolDispatch?.(name, id)
            },
            (name, id, result) => {
              const call = executableCalls.find((c) => c.id === id)
              if (call) this.recordRepeatSuccess(name, call.args, Boolean(result.error))
              this.emit({
                kind: EventKind.ToolResult,
                tool: { id, name, args: JSON.stringify(result.args || {}), output: result.output, error: result.error, durationMs: result.durationMs, fileDiff: result.fileDiff }
              })
              this.onToolResult?.(name, id, result.output)
            },
            (id, chunk) => {
              this.emit({
                kind: EventKind.ToolProgress,
                tool: { id, name: '', args: '', partial: true, output: chunk }
              })
            }
          )
          for (const [id, r] of batchResults) results.set(id, r)
        }

        // Check if model is asking a clarification question (plan or chat phase)
        for (const r of results.values()) {
          if (r.toolName === 'ask_clarification' && r.ok) {
            const question = String(r.args?.question || '')
            const options = Array.isArray(r.args?.options)
              ? (r.args.options as string[]).map(String)
              : undefined
            const text = streamContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
            appendToolRoundHistory(messages, text, callsWithIds, results)
            this.clarificationPending = true
            this.emit({
              kind: EventKind.ClarificationNeeded,
              clarification: { question, options }
            })
            return text || question
          }
        }

        const executedCalls = [...callsWithIds]

        // 3. Append native function-calling history (assistant.tool_calls + role:tool)
        if (results.size > 0) {
          const lines: string[] = []
          for (const call of executedCalls) {
            const r = results.get(call.id)
            if (r) lines.push(r.output)
          }

          let dupWarning = ''
          // The model rewrote a file it had already written this run → it is
          // stuck re-editing instead of moving on to the next plan step.
          for (const tc of executedCalls) {
            if (tc.name === 'write_file' && typeof tc.args.path === 'string') {
              const path = tc.args.path
              const content = String(tc.args.content || '')
              const prev = this.writtenFiles.get(path)
              if (prev === content) {
                dupWarning = `【警告】文件 ${path} 已经写入过相同内容！不要重复写入。改用 trigger_build 构建。`
              } else if (prev !== undefined) {
                dupWarning = `【注意】文件 ${path} 将被覆盖写入（内容已变更）。`
              }
              this.writtenFiles.set(path, content)
            }
          }

          const hasWrite = executedCalls.some((tc) => tc.name === 'write_file')
          const hasBuild = executedCalls.some((tc) => tc.name === 'trigger_build')
          const hasStepDone = executedCalls.some((tc) => tc.name === 'complete_step')
          const combinedOutput = lines.join('\n')
          const successfulWrites = executableCalls.filter((tc) =>
            tc.name === 'write_file' && !results.get(tc.id)?.error
          )
          const hasSuccessfulWrite = successfulWrites.length > 0

          if (hasWrite && !hasBuild && !hasStepDone) {
            this.consecutiveWriteOnlyRounds++
          } else {
            this.consecutiveWriteOnlyRounds = 0
          }

          // ---- Step advancement: manual via complete_step tool (workflow handles build/run auto-detect) ----
          const roundFullyBlocked = executableCalls.length === 0 && blockedResults.size > 0
          const curStep = planTracker?.currentStep ?? null
          const autoAdvanceMsg = ''

          if (hasSuccessfulWrite && planTracker?.currentStep && !hasStepDone && !autoAdvanceMsg) {
            // Once a write step has produced a file, stop offering exploration
            // tools. Otherwise weak models often go back to list/read loops
            // instead of marking the current step complete.
            this.readonlyLocked = true
          }

          const pushRoundHistory = (instruction: string): void => {
            appendToolRoundHistory(messages, streamContent, executedCalls, results, instruction)
          }

          // complete_step marked the last step done → end immediately so the
          // model can't keep spamming complete_step against a finished plan.
          if (hasStepDone && planTracker?.allDone()) {
            pushRoundHistory('[SYSTEM: 全部计划步骤已完成。]')
            finalContent = finalContent.trim() || '全部计划步骤已完成。'
            this.emit({ kind: EventKind.Notice, notice: { level: 'info', text: '全部步骤已完成，自动结束本轮' } })
            logger.agent('complete_step: all steps done, ending run', { step, phase })
            this.finishRun(emitLifecycle)
            return finalContent
          }

          // Safety net: model keeps calling complete_step without doing real work.
          const stepDoneOnly = hasStepDone && !hasWrite && !hasBuild && executableCalls.length > 0
          if (stepDoneOnly) this.consecutiveStepDoneOnlyRounds++
          else this.consecutiveStepDoneOnlyRounds = 0
          if (this.consecutiveStepDoneOnlyRounds >= 4) {
            const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : ''
            pushRoundHistory('检测到反复标记步骤但无实质进展。')
            finalContent = finalContent.trim() || `检测到反复标记步骤但无实质进展，已自动结束本轮。${remaining}`
            this.emit({
              kind: EventKind.Notice,
              notice: { level: 'warn', text: '检测到 complete_step 循环，已自动结束本轮' }
            })
            logger.agent('Loop escape: complete_step spam cap reached', { step, phase })
            this.finishRun(emitLifecycle)
            return finalContent
          }

          // Safety net: model keeps spamming a blocked tool with no way forward.
          if (roundFullyBlocked) {
            this.consecutiveBlockedRounds++
          } else if (!roundFullyBlocked) {
            this.consecutiveBlockedRounds = 0
          }
          if (this.consecutiveBlockedRounds >= 2) {
            const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : ''
            pushRoundHistory('检测到重复调用已完成的操作。')
            finalContent = finalContent.trim() || `检测到重复调用已完成的操作，已自动结束本轮。${remaining}`
            this.emit({
              kind: EventKind.Notice,
              notice: { level: 'warn', text: '检测到工具重复调用循环，已自动结束本轮' }
            })
            logger.agent('Loop escape: blocked-round cap reached, ending run', { step, phase })
            this.finishRun(emitLifecycle)
            return finalContent
          }

          // Idle detection: no file writes and no build/run progress for 3 rounds → force stop
          const hadProgress = hasSuccessfulWrite || hasBuild
          if (hadProgress) {
            this.consecutiveIdleRounds = 0
          } else {
            this.consecutiveIdleRounds++
          }
          if (this.consecutiveIdleRounds >= 3) {
            const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : ''
            pushRoundHistory('检测到连续多轮无实质进展（无文件写入、无构建）。')
            finalContent = finalContent.trim() || `执行停滞：连续 ${this.consecutiveIdleRounds} 轮无文件写入或构建进展，已自动结束。${remaining}`
            this.emit({
              kind: EventKind.Notice,
              notice: { level: 'warn', text: `连续 ${this.consecutiveIdleRounds} 轮无进展，已自动结束本轮` }
            })
            logger.agent('Loop escape: idle rounds cap reached', { step, phase, idleRounds: this.consecutiveIdleRounds })
            this.finishRun(emitLifecycle)
            return finalContent
          }

          let instruction = ''
          if (this.consecutiveWriteOnlyRounds >= 3) {
            instruction = '【系统警告】你已经连续多次只写入文件而没有构建！立即调用 trigger_build 来构建项目，不要继续写文件！'
            this.consecutiveWriteOnlyRounds = 0
          } else if (dupWarning) {
            instruction = dupWarning
          } else if (hasBuild && combinedOutput.includes('BUILD SUCCESSFUL')) {
            instruction =
              '[SYSTEM: 构建已成功完成。不要再次调用 trigger_build，系统会根据构建结果推进步骤。]'
          } else if (hasBuild) {
            instruction = '[SYSTEM: 构建完成。检查结果后决定下一步。]'
          } else if (hasStepDone) {
            const cur = planTracker?.currentStep
            if (cur) {
              instruction =
                `[SYSTEM: 步骤已推进。当前步骤 #${cur.id}：${cur.description}。请执行该步骤，系统会根据工具结果继续推进。]`
            } else if (planTracker?.allDone()) {
              instruction = '[SYSTEM: 全部计划步骤已完成。请输出总结，不要再调用工具。]'
            } else {
              instruction = '[SYSTEM: 步骤已标记。继续下一步或调用 trigger_build。]'
            }
          } else if (hasSuccessfulWrite) {
            const cur = planTracker?.currentStep
            instruction = cur
              ? `[SYSTEM: 文件已写入。当前步骤 #${cur.id}：${cur.description}。` +
                '请检查是否需要执行下一步；不要 list_directory/read_file，不要重写同一个文件。]'
              : '[SYSTEM: 文件已写入。不要重复写入同一个文件，继续下一步或输出总结。]'
          } else {
            instruction = '[SYSTEM: 工具执行完毕。决定下一步。]'
          }
          if (planTracker && !hasStepDone) {
            instruction += `\n\n当前计划进度：\n${planTracker.toContextBlock()}`
          }
          pushRoundHistory(instruction)
        }

      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.finishRun(emitLifecycle, 'Cancelled')
          return finalContent
        }
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error('Agent error', errMsg)
        this.emit({ kind: EventKind.Notice, notice: { level: 'error', text: errMsg } })
        this.finishRun(emitLifecycle, errMsg)
        return finalContent
      }
    }

    if (this.maxSteps > 0 && !this.graceRound) {
      this.emit({ kind: EventKind.Notice, notice: { level: 'warn', text: `Max steps (${this.maxSteps}) reached` } })
    }
    this.finishRun(emitLifecycle)
    return finalContent
  }

  private async streamFromAPI(
    endpoint: string, apiKey: string, model: string,
    messages: ChatMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    abortSignal?: AbortSignal,
    onChunk?: (text: string, reasoning?: string) => void,
    maxTokens = 8192
  ): Promise<{
    finishReason?: string
    toolCalls: ModelToolCall[]
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
  }> {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      try {
        return await this.streamFromAPIOnce(
          endpoint, apiKey, model, messages, tools, abortSignal, onChunk, maxTokens
        )
      } catch (err) {
        lastError = err
        if (!isRetryableFetchError(err) || attempt >= MAX_FETCH_RETRIES - 1) throw err
        const delay = fetchRetryDelayMs(attempt)
        logger.agent('API fetch retry', { attempt: attempt + 1, delay, error: String(err) })
        this.emit({
          kind: EventKind.Notice,
          notice: {
            level: 'warn',
            text: `API 请求失败，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${MAX_FETCH_RETRIES})…`
          }
        })
        await sleep(delay)
      }
    }
    throw lastError
  }

  private async streamFromAPIOnce(
    endpoint: string, apiKey: string, model: string,
    messages: ChatMessage[],
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    abortSignal?: AbortSignal,
    onChunk?: (text: string, reasoning?: string) => void,
    maxTokens = 8192
  ): Promise<{
    finishReason?: string
    toolCalls: ModelToolCall[]
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number }
  }> {
    const body: Record<string, unknown> = {
      model, messages, stream: true, max_tokens: maxTokens,
      stream_options: { include_usage: true }
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    // Create a timeout signal that aborts after 120s of no response
    const API_TIMEOUT_MS = 120_000
    const timeoutController = new AbortController()
    const timeoutId = setTimeout(() => timeoutController.abort(new Error('API timeout')), API_TIMEOUT_MS)

    // Combine user abort + timeout: if either fires, abort the fetch
    const onUserAbort = () => timeoutController.abort()
    abortSignal?.addEventListener('abort', onUserAbort, { once: true })

    let response: Response
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    })
    } finally {
      clearTimeout(timeoutId)
      abortSignal?.removeEventListener('abort', onUserAbort)
    }
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`API error ${response.status}: ${text}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body')
    const decoder = new TextDecoder()
    let buffer = ''
    let finishReason: string | undefined
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number } = {}
    const collected: Array<{ index: number; id: string; name: string; args: string }> = []
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            const u = parsed.usage
            usage = {
              promptTokens: u.prompt_tokens ?? u.promptTokens ?? usage.promptTokens,
              completionTokens: u.completion_tokens ?? u.completionTokens ?? usage.completionTokens,
              totalTokens: u.total_tokens ?? u.totalTokens ?? usage.totalTokens,
              cacheHitTokens: u.prompt_cache_hit_tokens ?? u.cacheHitTokens ?? usage.cacheHitTokens,
              cacheMissTokens: u.prompt_cache_miss_tokens ?? u.cacheMissTokens ?? usage.cacheMissTokens
            }
          }
          const choice = parsed.choices?.[0]
          if (!choice) continue
          const delta = choice.delta || {}
          if (choice.finish_reason) finishReason = choice.finish_reason
          if (delta.reasoning_content) { onChunk?.('', delta.reasoning_content); continue }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let entry = collected.find((e) => e.index === (tc.index ?? 0))
              if (!entry) {
                entry = { index: tc.index ?? 0, id: tc.id || `call_${tc.index ?? 0}`, name: '', args: '' }
                collected.push(entry)
              }
              if (tc.id) entry.id = tc.id
              if (tc.function?.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.args += tc.function.arguments
            }
            continue
          }
          if (delta.content) { fullText += delta.content; onChunk?.(delta.content) }
        } catch { /* skip */ }
      }
    }

    const nativeCalls: ModelToolCall[] = collected.filter((tc) => tc.name).map((tc) => {
      const rawArguments = tc.args || '{}'
      try {
        return { id: tc.id, name: tc.name, args: JSON.parse(rawArguments), rawArguments }
      } catch {
        return { id: tc.id, name: tc.name, args: {}, rawArguments }
      }
    })
    const textCalls: ModelToolCall[] = parseToolCalls(fullText).map((tc) => ({
      id: `text_call_${++_toolCallIdCounter}`,
      name: tc.name,
      args: tc.args,
      rawArguments: JSON.stringify(tc.args)
    }))
    return { finishReason, toolCalls: nativeCalls.length > 0 ? nativeCalls : textCalls, usage }
  }
}
