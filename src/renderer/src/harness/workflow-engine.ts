import { EventKind, type Event } from './events.ts'
import type { PlanTracker } from './plan-tracker.ts'
import { filterToolCallsForStep, type ToolCallWithId } from './step-policy.ts'
import { executeBatch, type Registry, type ToolContext, type ToolResult } from './tools.ts'
import type { WorkflowRunResult, WorkflowStep } from './workflow-types.ts'

export interface WorkflowModelResult {
  finishReason?: string
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
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
  messages: Array<{ role: string; content: string }>,
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

function statusForPlan(step: WorkflowStep): string {
  if (step.status === 'failed') return 'error'
  return step.status
}

function summarizeStep(step: WorkflowStep): string {
  return `当前步骤 #${step.id}: ${step.title}\n类型: ${step.kind}\n允许工具: ${step.allowedTools.join(', ') || '无'}`
}

function resultCompletesStep(step: WorkflowStep, result: ToolResult): boolean {
  if (!result.ok || result.error) return false
  switch (step.kind) {
    case 'inspect':
      return result.toolName === 'read_file' || result.toolName === 'list_directory'
    case 'recipe':
      return result.toolName === 'create_recipe'
    case 'write':
      return result.toolName === 'write_file' || result.toolName === 'create_recipe'
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

  private toolSchemasFor(step: WorkflowStep): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.registry.schemas().filter((tool) => step.allowedTools.includes(tool.name))
  }

  private workflowPrompt(step: WorkflowStep): { role: string; content: string } {
    return {
      role: 'user',
      content:
        `【工作流步骤】只执行当前步骤，不要重复已完成操作。\n${summarizeStep(step)}\n` +
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
    const selected = calls.slice(0, 1)
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
      },
      (id, chunk) => {
        this.emit({ kind: EventKind.ToolProgress, tool: { id, name: '', args: '', partial: true, output: chunk } })
      }
    )
  }

  async run(baseMessages: Array<{ role: string; content: string }>): Promise<WorkflowRunResult> {
    let finalContent = ''
    this.emitPlanState()

    while (!this.abortSignal?.aborted) {
      const step = this.currentStep()
      if (!step) break
      if (step.status === 'pending') step.status = 'running'
      this.emitPlanState()

      let completed = false
      for (let attempt = 0; attempt < step.maxAttempts && !completed; attempt++) {
        const modelMessages = [...baseMessages, this.workflowPrompt(step)]
        const allowedTools = this.toolSchemasFor(step)
        let streamText = ''
        let streamReasoning = ''
        const modelResult = await this.modelCall(modelMessages, allowedTools, (text, reasoning) => {
          if (text) streamText = text
          if (reasoning) streamReasoning = reasoning
        })
        finalContent = modelResult.text || streamText || finalContent

        const calls = modelResult.toolCalls.map((call) => ({
          ...call,
          id: `workflow_call_${++workflowToolId}`
        }))
        if (calls.length === 0) {
          baseMessages.push({
            role: 'user',
            content: `【系统】当前步骤尚未完成：#${step.id} ${step.title}。请调用允许工具完成该步骤。`
          })
          continue
        }

        const gate = filterToolCallsForStep(step, calls)
        for (const rejected of gate.rejected) {
          this.emitRejected(`workflow_rejected_${++workflowToolId}`, rejected)
        }

        if (gate.allowed.length === 0) {
          baseMessages.push({
            role: 'system',
            content: gate.rejected.map((r) => r.output).join('\n')
          })
          continue
        }

        const results = await this.executeAllowedCalls(step, gate.allowed)
        const allResults = [...results.values()]
        const success = allResults.find((result) => resultCompletesStep(step, result))
        baseMessages.push({
          role: 'system',
          content: allResults.map((r) => r.output).join('\n')
        })

        if (success) {
          step.status = 'completed'
          this.planTracker.advanceCurrent(success.toolName || 'workflow evidence')
          completed = true
          this.emitPlanState()
          break
        }
      }

      if (!completed && step.status !== 'completed') {
        step.status = 'failed'
        this.emitPlanState()
        return {
          finalContent: finalContent || `步骤 #${step.id} 未能完成：${step.title}`,
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
