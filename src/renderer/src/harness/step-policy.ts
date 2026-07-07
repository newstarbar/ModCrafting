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

const RECIPE_DATA_PATH_RE = /(?:src\/main\/resources\/)?data\/[^/]+\/recipes?\/[^/]+\.json$/i

const READONLY_KNOWLEDGE_TOOLS = new Set([
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'vanilla_mc_wiki_query',
  'fabric_meta_version_check',
  'fabric_mod_json_validate'
])

/** Paths Agent may read during recipe steps: mod id + existing recipe JSON inspection. */
export function isRecipeInspectionPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith('fabric.mod.json')) return true
  return RECIPE_DATA_PATH_RE.test(normalized)
}

/** Only allow deleting a single recipe JSON under data/<namespace>/recipe(s)/. */
export function isRecipeCleanupCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  if (/[*?]/.test(normalized)) return false
  if (/\s-rf\b|\brm\s+-rf\b|-Recurse/i.test(normalized)) return false

  const match = normalized.match(/^(?:rm|del|Remove-Item)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i)
  if (!match) return false

  const path = (match[1] || match[2] || match[3] || '').replace(/\\/g, '/')
  if (!path || /\/$/.test(path)) return false
  return RECIPE_DATA_PATH_RE.test(path)
}

export interface ToolGateOptions {
  repairMode?: boolean
  repairWriteRequired?: boolean
}

const REPAIR_WRITE_BLOCKED_TOOLS = new Set(['trigger_build', 'run_command'])

export function isRepairWriteBlocked(
  step: WorkflowStep,
  call: ToolCallWithId,
  options?: ToolGateOptions
): boolean {
  if (!options?.repairMode || !options?.repairWriteRequired) return false
  if (step.kind !== 'build' && step.kind !== 'run') return false
  return REPAIR_WRITE_BLOCKED_TOOLS.has(call.name)
}

function commandAllowedForStep(step: WorkflowStep, call: ToolCallWithId, options?: ToolGateOptions): boolean {
  if (READONLY_KNOWLEDGE_TOOLS.has(call.name) && (step.kind === 'write' || step.kind === 'recipe')) {
    return true
  }
  if (call.name === 'read_file' && step.kind === 'recipe') {
    return isRecipeInspectionPath(String(call.args.path || ''))
  }
  if (call.name === 'run_command') {
    const command = String(call.args.command || '')
    if (step.kind === 'build') return /gradlew|gradle|build/i.test(command)
    if (step.kind === 'run') return /runClient/i.test(command)
    if (step.kind === 'recipe' || step.kind === 'write') return isRecipeCleanupCommand(command)
    return false
  }
  if (call.name === 'trigger_build') {
    const task = String(call.args.task || 'build')
    if (step.kind === 'build') return task === 'build'
    if (step.kind === 'run') return task === 'runClient'
  }
  return true
}

export function isToolAllowedForStep(
  step: WorkflowStep,
  call: ToolCallWithId,
  options?: ToolGateOptions
): boolean {
  if (isRepairWriteBlocked(step, call, options)) return false
  if (options?.repairMode && call.name === 'write_file' && (step.kind === 'build' || step.kind === 'run')) {
    return true
  }
  if (call.name === 'list_directory') return true
  if (call.name === 'ask_clarification') return true
  if (call.name === 'read_file' && step.kind !== 'recipe') return true

  if (!step.allowedTools.includes(call.name)) return false
  return commandAllowedForStep(step, call, options)
}

function rejectedRepairWriteResult(step: WorkflowStep, call: ToolCallWithId): ToolResult {
  return {
    output:
      `blocked: [repair_write_required] 当前步骤 #${step.id}（${step.title}）在修复模式下必须先 read_error_log / fabric_log_debugger 分析并用 write_file 修改代码，再重新构建。禁止直接调用 "${call.name}"。`,
    error: `repair_write_required: ${call.name}`,
    durationMs: 0,
    ok: false,
    toolName: call.name,
    args: call.args,
    exitCode: null,
    errorKind: 'repair_write_required'
  }
}

export function createRejectedToolResult(
  step: WorkflowStep,
  call: ToolCallWithId,
  options?: ToolGateOptions
): ToolResult {
  if (isRepairWriteBlocked(step, call, options)) {
    return rejectedRepairWriteResult(step, call)
  }
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

function rejectedToolResult(step: WorkflowStep, call: ToolCallWithId, options?: ToolGateOptions): ToolResult {
  return createRejectedToolResult(step, call, options)
}

export function filterToolCallsForStep(
  step: WorkflowStep,
  calls: ToolCallWithId[],
  options?: ToolGateOptions
): ToolGateResult {
  const allowed: ToolCallWithId[] = []
  const rejected: ToolResult[] = []
  for (const call of calls) {
    if (isToolAllowedForStep(step, call, options)) allowed.push(call)
    else rejected.push(rejectedToolResult(step, call, options))
  }
  return { allowed, rejected }
}
