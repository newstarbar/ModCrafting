import type { ToolResult } from './tools.ts'
import type { WorkflowStep } from './workflow-types.ts'

export interface ToolCallWithId {
  name: string
  args: Record<string, unknown>
  id?: string
}

export interface ToolGateResult {
  allowed: ToolCallWithId[]
  rejected: ToolResult[]
}

const RECIPE_DATA_PATH_RE = /(?:src\/main\/resources\/)?data\/[^/]+\/recipes\/[^/]+\.json$/i

/** Paths Agent may read during recipe steps: mod id + existing recipe JSON inspection. */
export function isRecipeInspectionPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith('fabric.mod.json')) return true
  return RECIPE_DATA_PATH_RE.test(normalized)
}

function commandAllowedForStep(step: WorkflowStep, call: ToolCallWithId): boolean {
  if (call.name === 'read_file' && step.kind === 'recipe') {
    return isRecipeInspectionPath(String(call.args.path || ''))
  }
  if (call.name === 'run_command') {
    const command = String(call.args.command || '')
    if (step.kind === 'build') return /gradlew|gradle|build/i.test(command)
    if (step.kind === 'run') return /runClient/i.test(command)
    return false
  }
  if (call.name === 'trigger_build') {
    const task = String(call.args.task || 'build')
    if (step.kind === 'build') return task === 'build'
    if (step.kind === 'run') return task === 'runClient'
  }
  return true
}

export function isToolAllowedForStep(step: WorkflowStep, call: ToolCallWithId): boolean {
  if (!step.allowedTools.includes(call.name)) return false
  return commandAllowedForStep(step, call)
}

function rejectedToolResult(step: WorkflowStep, call: ToolCallWithId): ToolResult {
  return {
    output: `blocked: [tool_not_allowed] 当前步骤 #${step.id}（${step.title}）不允许调用 "${call.name}"。`,
    error: `tool_not_allowed: ${call.name}`,
    durationMs: 0,
    ok: false,
    toolName: call.name,
    args: call.args,
    exitCode: null,
    errorKind: 'tool_not_allowed'
  }
}

export function filterToolCallsForStep(step: WorkflowStep, calls: ToolCallWithId[]): ToolGateResult {
  const allowed: ToolCallWithId[] = []
  const rejected: ToolResult[] = []
  for (const call of calls) {
    if (isToolAllowedForStep(step, call)) allowed.push(call)
    else rejected.push(rejectedToolResult(step, call))
  }
  return { allowed, rejected }
}
