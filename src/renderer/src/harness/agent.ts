// ======== Agent ========
// Reasonix-style agent loop: stream → tool calls → execute → loop
// Features: readonly-tool round limit, clean message history, kick mechanism

import type { Sink, Event } from './events'
import { EventKind } from './events'
import { type Registry, executeBatch, parseToolCalls, type ToolContext } from './tools'
import { logger } from '../utils/logger'

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
}

const MAX_READONLY_ROUNDS = 3
// Tools considered "exploration only" (no progress toward completion)
const EXPLORATION_TOOLS = ['list_directory', 'read_file', 'read_error_log', 'run_command']

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

  constructor(opts: AgentOptions) {
    this.registry = opts.registry
    this.sink = opts.sink
    this.maxSteps = opts.maxSteps ?? 0 // 0 = unlimited
    this.onToolDispatch = opts.onToolDispatch
    this.onToolResult = opts.onToolResult
  }

  resetRunState(): void {
    this.readonlyLocked = false
    this.writtenFiles.clear()
    this.consecutiveWriteOnlyRounds = 0
  }

  private emit(e: Event): void { this.sink.emit(e) }

  private finishRun(emitLifecycle: boolean, error?: string): void {
    if (emitLifecycle) {
      this.emit({ kind: EventKind.TurnDone, error })
    }
  }

  async run(
    apiEndpoint: string, apiKey: string, apiModel: string,
    messages: Array<{ role: string; content: string }>,
    projectPath: string | null,
    abortSignal?: AbortSignal,
    onStream?: (text: string, reasoning?: string) => void,
    options: RunOptions = {}
  ): Promise<string> {
    const phase = options.phase ?? 'execute'
    const emitLifecycle = options.emitLifecycle ?? true

    if (emitLifecycle) {
      this.emit({ kind: EventKind.TurnStarted })
    }
    logger.agent('Run started', { model: apiModel, phase, steps: this.maxSteps || 'unlimited' })

    let finalContent = ''
    let readonlyRounds = 0

    for (let step = 0; this.maxSteps === 0 || step < this.maxSteps; step++) {
      logger.agent(`Step ${step + 1}${this.maxSteps > 0 ? '/' + this.maxSteps : ''}`)
      if (abortSignal?.aborted) {
        this.finishRun(emitLifecycle, 'Cancelled')
        return finalContent
      }

      // Build clean API messages: first system + everything else
      const systemIdx = messages.findIndex((m) => m.role === 'system')
      const apiMessages = systemIdx >= 0
        ? [{ role: 'system', content: messages[systemIdx].content }, ...messages.slice(systemIdx + 1)]
        : messages

      // Plan phase: no tools; execute phase: full registry with exploration limits
      let availableTools = phase === 'plan' ? [] : this.registry.schemas()
      if (phase === 'execute') {
        if (this.readonlyLocked) {
          availableTools = availableTools.filter((t) => !['list_directory', 'read_file', 'read_error_log', 'run_command'].includes(t.name))
        } else if (readonlyRounds >= MAX_READONLY_ROUNDS) {
          this.readonlyLocked = true
          readonlyRounds = 0
          availableTools = availableTools.filter((t) => !['list_directory', 'read_file', 'read_error_log', 'run_command'].includes(t.name))
          const kick = 'STOP EXPLORING. You have spent too many rounds reading files, listing directories, and running diagnostic commands. run_command, read_file, and list_directory are now LOCKED. You can ONLY write files (write_file), build (trigger_build), or mark steps done (complete_step). Make a decision and execute it NOW.'
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
          }
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
          if (phase === 'execute') {
            const anyToolCalled = messages.some((m) =>
              m.role === 'system' && m.content.includes('[SYSTEM:')
            )
            if (!anyToolCalled && (cleanText || streamContent).length > 80) {
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

        // 2. Execute tools
        logger.agent(`Executing ${toolCalls.length} tool(s)`, toolCalls.map((t) => t.name))
        const ctx: ToolContext = { projectPath, callId: `step_${step}`, abortSignal }

        const results = await executeBatch(
          toolCalls.map((tc) => ({ ...tc, id: `call_${++_toolCallIdCounter}` })),
          this.registry, ctx,
          (name, id) => {
            const tool = this.registry.get(name)
            this.emit({ kind: EventKind.ToolDispatch, tool: { id, name, args: '', readOnly: tool?.readOnly() } })
            this.onToolDispatch?.(name, id)
          },
          (name, id, result) => {
            this.emit({
              kind: EventKind.ToolResult,
              tool: { id, name, args: '', output: result.output, error: result.error, durationMs: result.durationMs }
            })
            this.onToolResult?.(name, id, result.output)
          }
        )

        // 3. Append to conversation — ONLY meaningful messages
        if (streamContent.trim()) {
          messages.push({ role: 'assistant', content: streamContent })
        }

        // Tool results as system messages (clearer than 'user' role)
        if (results.size > 0) {
          const lines: string[] = []
          for (const [, r] of results) lines.push(r.output)

          let dupWarning = ''
          for (const tc of toolCalls) {
            if (tc.name === 'write_file' && typeof tc.args.path === 'string') {
              const path = tc.args.path
              const content = String(tc.args.content || '')
              const prev = this.writtenFiles.get(path)
              if (prev === content) {
                dupWarning = `\n\n【警告】文件 ${path} 已经写入过相同内容！不要重复写入。改用 trigger_build 构建。`
              } else if (prev !== undefined) {
                dupWarning = `\n\n【注意】文件 ${path} 将被覆盖写入（内容已变更）。`
              }
              this.writtenFiles.set(path, content)
            }
          }

          const hasWrite = toolCalls.some((tc) => tc.name === 'write_file')
          const hasBuild = toolCalls.some((tc) => tc.name === 'trigger_build')
          const hasStepDone = toolCalls.some((tc) => tc.name === 'complete_step')

          if (hasWrite && !hasBuild && !hasStepDone) {
            this.consecutiveWriteOnlyRounds++
          } else {
            this.consecutiveWriteOnlyRounds = 0
          }

          let instruction
          if (this.consecutiveWriteOnlyRounds >= 3) {
            instruction = '\n\n【系统警告】你已经连续多次只写入文件而没有构建！立即调用 trigger_build 来构建项目，不要继续写文件！'
            this.consecutiveWriteOnlyRounds = 0
          } else if (dupWarning) {
            instruction = dupWarning
          } else if (hasBuild) {
            instruction = '\n\n[SYSTEM: 构建完成。检查结果后决定下一步。]'
          } else if (hasStepDone) {
            instruction = '\n\n[SYSTEM: 步骤已标记。继续下一步或调用 trigger_build。]'
          } else if (hasWrite) {
            instruction = '\n\n[SYSTEM: 文件已写入。如需继续写文件请继续，否则调用 trigger_build 构建。]'
          } else {
            instruction = '\n\n[SYSTEM: 工具执行完毕。决定下一步。]'
          }
          messages.push({ role: 'system', content: lines.join('\n') + instruction })
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

    if (this.maxSteps > 0) {
      this.emit({ kind: EventKind.Notice, notice: { level: 'warn', text: `Max steps (${this.maxSteps}) reached` } })
    }
    this.finishRun(emitLifecycle)
    return finalContent
  }

  private async streamFromAPI(
    endpoint: string, apiKey: string, model: string,
    messages: Array<{ role: string; content: string }>,
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
    abortSignal?: AbortSignal,
    onChunk?: (text: string, reasoning?: string) => void
  ): Promise<{ finishReason?: string; toolCalls: Array<{ name: string; args: Record<string, unknown> }>; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number } }> {
    const body: Record<string, unknown> = {
      model, messages, stream: true, max_tokens: 8192,
      stream_options: { include_usage: true }
    }
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
      body: JSON.stringify(body),
      signal: abortSignal
    })
    if (!response.ok) throw new Error(`API error ${response.status}: ${await response.text()}`)

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

    const nativeCalls = collected.filter((tc) => tc.name).map((tc) => {
      try { return { name: tc.name, args: JSON.parse(tc.args || '{}') } }
      catch { return { name: tc.name, args: {} } }
    })
    const textCalls = parseToolCalls(fullText)
    return { finishReason, toolCalls: nativeCalls.length > 0 ? nativeCalls : textCalls, usage }
  }
}
