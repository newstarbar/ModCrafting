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
const PROJECT_FILE_DELETE_RE = /^(?:src\/|data\/|gradle\/).+\.(java|json|gradle|properties|accesswidener|toml)$/i

const READONLY_KNOWLEDGE_TOOLS = new Set([
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'vanilla_mc_wiki_query',
  'fabric_meta_version_check',
  'fabric_mod_json_validate',
  'fabric_mixin_target_lookup',
  'fabric_recipe_validate',
  'fabric_mixin_validate'
])

/** Paths Agent may read during recipe steps: mod id + existing recipe JSON inspection. */
export function isRecipeInspectionPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith('fabric.mod.json')) return true
  return RECIPE_DATA_PATH_RE.test(normalized)
}

/** Only allow deleting a single project file under src/, data/, or gradle/. */
export function isProjectFileDeleteCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  if (/[*?]/.test(normalized)) return false
  if (/\s-rf\b|\brm\s+-rf\b|-Recurse/i.test(normalized)) return false

  const match = normalized.match(
    /^(?:rm|del|Remove-Item)\s+(?:(?:\/f\s+|\/q\s+|\/f\s+\/q\s+)|(?:-Force\s+))?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i
  )
  if (!match) return false

  const path = (match[1] || match[2] || match[3] || '').replace(/\\/g, '/')
  if (!path || /\/$/.test(path)) return false
  return PROJECT_FILE_DELETE_RE.test(path)
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
  repairValidationRequired?: 'recipe' | 'mixin'
}

const REPAIR_WRITE_BLOCKED_TOOLS = new Set(['trigger_build', 'run_command'])
const REPAIR_OVERRIDE_TOOLS = new Set([
  'edit_file',
  'write_file',
  'read_file',
  'grep',
  'read_error_log',
  'fabric_log_debugger',
  'fabric_docs_search',
  'fabric_mixin_target_lookup',
  'fabric_recipe_validate',
  'fabric_mixin_validate'
])

export function isRepairWriteBlocked(
  step: WorkflowStep,
  call: ToolCallWithId,
  options?: ToolGateOptions
): boolean {
  if (!options?.repairMode || (!options?.repairWriteRequired && !options?.repairValidationRequired)) return false
  if (step.kind !== 'build' && step.kind !== 'run') return false
  return REPAIR_WRITE_BLOCKED_TOOLS.has(call.name)
}

function commandAllowedForStep(step: WorkflowStep, call: ToolCallWithId, options?: ToolGateOptions): boolean {
  if (READONLY_KNOWLEDGE_TOOLS.has(call.name) && (step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin')) {
    return true
  }
  if (call.name === 'read_file' && step.kind === 'recipe') {
    return isRecipeInspectionPath(String(call.args.path || ''))
  }
  if (call.name === 'delete_file') {
    return step.kind === 'write'
  }
  if (call.name === 'run_command') {
    const command = String(call.args.command || '')
    if (step.kind === 'build') return /gradlew|gradle|build/i.test(command)
    if (step.kind === 'run') return /runClient/i.test(command)
    if (step.kind === 'recipe' || step.kind === 'write') {
      return isRecipeCleanupCommand(command) || isProjectFileDeleteCommand(command)
    }
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

  const explicitlyAllowed = step.allowedTools.includes(call.name)
  const repairOverride = Boolean(options?.repairMode && REPAIR_OVERRIDE_TOOLS.has(call.name))
  if (!explicitlyAllowed && !repairOverride) return false

  if (call.name === 'list_directory') return true
  if (call.name === 'grep') return true
  if (call.name === 'ask_clarification') return true

  if (call.name === 'write_file' || call.name === 'edit_file') {
    if (options?.repairMode && (step.kind === 'build' || step.kind === 'run')) return true
    if (step.kind === 'build' || step.kind === 'run') return false
    if (step.kind === 'recipe') return false
    // mixin 步需要 write_file（新建 client 路径）+ edit_file（改 stub）才能完成 main→client 迁移
    if (step.kind === 'mixin') return true
    return true
  }

  if (call.name === 'delete_file') {
    return step.kind === 'write' || step.kind === 'mixin'
  }

  if (call.name === 'read_file') {
    if (step.kind === 'recipe') {
      return isRecipeInspectionPath(String(call.args.path || ''))
    }
    return true
  }

  // complete_step only in non-terminal steps (build/run auto-detected by host)
  if (call.name === 'complete_step' && step.kind !== 'build' && step.kind !== 'run') return true

  return commandAllowedForStep(step, call, options)
}

function rejectedRepairWriteResult(step: WorkflowStep, call: ToolCallWithId, options?: ToolGateOptions): ToolResult {
  const required = options?.repairValidationRequired
  const instruction = required
    ? `修改涉及 ${required === 'recipe' ? '配方' : 'Mixin'}，必须先调用 fabric_${required}_validate 取得新验证证据`
    : '必须先 read_error_log / fabric_log_debugger 分析并用 edit_file 修改代码'
  return {
    output:
      `blocked: [repair_write_required] 当前步骤 #${step.id}（${step.title}）在修复模式下${instruction}，再重新构建。禁止直接调用 "${call.name}"。`,
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
    return rejectedRepairWriteResult(step, call, options)
  }
  let output = `blocked: [tool_not_allowed] 当前步骤 #${step.id}（${step.title}）不允许调用 "${call.name}"。`
  if (
    (step.kind === 'build' || step.kind === 'run') &&
    !options?.repairMode &&
    (call.name === 'edit_file' || call.name === 'write_file')
  ) {
    output +=
      step.kind === 'build'
        ? ' 请先调用 trigger_build({"task":"build"})；构建失败后会自动进入修复模式，那时才允许 edit_file。'
        : ' 请先调用 trigger_build({"task":"runClient"})；运行失败后会自动进入修复模式，那时才允许 edit_file。'
  }
  return {
    output,
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
