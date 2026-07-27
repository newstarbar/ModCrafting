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
  'delete_file',
  'read_file',
  'grep',
  'read_error_log',
  'fabric_log_debugger',
  'fabric_docs_search',
  'fabric_mixin_target_lookup',
  'fabric_mixin_scaffold',
  'fabric_mixin_register',
  'fabric_recipe_validate',
  'fabric_mixin_validate',
  'mc_screenshot',
  'mc_inspect',
  'mc_inventory',
  'mc_world',
  'mc_chat',
  'mc_command',
  'mc_input'
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

/** 允许在 run/build 步骤中执行的文件检查命令（只读、无副作用）。
 *  用于检查运行产物（截图、日志、配置文件）等场景。 */
function isFileInspectionCommand(command: string): boolean {
  const normalized = command.trim()
  if (!normalized) return false
  // 允许的前缀：dir, ls, cat, type, Get-Content, Get-ChildItem, Test-Path, where, find
  // 这些都是只读命令，不会修改或删除文件
  return /^(?:dir|ls|cat|type|Get-Content|Get-ChildItem|Test-Path|where|find)\b/i.test(normalized)
}

function commandAllowedForStep(step: WorkflowStep, call: ToolCallWithId, options?: ToolGateOptions): boolean {
  if (READONLY_KNOWLEDGE_TOOLS.has(call.name) && (step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin')) {
    return true
  }
  if (call.name === 'read_file' && step.kind === 'recipe') {
    return isRecipeInspectionPath(String(call.args.path || ''))
  }
  if (call.name === 'delete_file') {
    // Build/run steps often need to delete misplaced main copies (duplicate class /
    // splitEnvironment migration) before or during repair — allow without waiting for repairMode.
    if (step.kind === 'build' || step.kind === 'run') return true
    return step.kind === 'write'
  }
  if (call.name === 'run_command') {
    const command = String(call.args.command || '')
    if (step.kind === 'build') return /gradlew|gradle|build/i.test(command) || isFileInspectionCommand(command)
    if (step.kind === 'run') return /runClient/i.test(command) || isFileInspectionCommand(command)
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
  // Build/run may delete misplaced files (duplicate class) before repairMode flips on.
  const buildRunDelete =
    call.name === 'delete_file' && (step.kind === 'build' || step.kind === 'run')
  if (!explicitlyAllowed && !repairOverride && !buildRunDelete) return false

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
    if (step.kind === 'build' || step.kind === 'run') return true
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
  if (call.name === 'complete_step' && (step.kind === 'build' || step.kind === 'run')) {
    output =
      step.kind === 'run'
        ? `blocked: [tool_not_allowed] run 步骤 #${step.id}（${step.title}）禁止 complete_step。` +
          `请用 mc_inspect / mc_screenshot 完成验收；满足验收后系统会自动推进。勿再调用 complete_step。`
        : `blocked: [tool_not_allowed] build 步骤 #${step.id}（${step.title}）禁止 complete_step。` +
          `请调用 trigger_build({"task":"build"})；构建成功后系统会自动推进。`
  } else if (
    (step.kind === 'build' || step.kind === 'run') &&
    !options?.repairMode &&
    (call.name === 'edit_file' || call.name === 'write_file')
  ) {
    output +=
      step.kind === 'build'
        ? ' 请先调用 trigger_build({"task":"build"})；构建失败后会自动进入修复模式，那时才允许 edit_file。'
        : ' 请先调用 trigger_build({"task":"runClient"})；运行失败后会自动进入修复模式，那时才允许 edit_file。'
  } else if (call.name === 'trigger_build') {
    output += ` 当前步骤类型为 ${step.kind}，trigger_build 仅在 build/run 步骤允许。请先 complete_step 推进到构建/运行步骤。`
  } else if (call.name === 'run_command') {
    const allowedHint = step.kind === 'run'
      ? ' runClient 或文件检查命令（dir/ls/cat/type/Get-Content/Get-ChildItem/Test-Path 等）'
      : step.kind === 'build'
        ? ' gradle 构建命令或文件检查命令'
        : ' 文件删除命令'
    output += ` 当前步骤类型为 ${step.kind}，run_command 仅允许${allowedHint}。如需列出目录文件，请改用 list_directory。`
  } else if (call.name === 'mc_screenshot' || call.name === 'mc_inspect' || call.name === 'mc_command' || call.name === 'mc_input' || call.name === 'mc_ensure_test_world' || call.name === 'mc_ensure_cheats' || call.name === 'mc_inventory' || call.name === 'mc_world' || call.name === 'mc_chat') {
    output += ` MC 操作工具仅在 run 步骤允许。当前步骤类型为 ${step.kind}，请先完成当前步骤推进到 run 步骤。`
  } else if (call.name === 'fabric_recipe_generate' || call.name === 'create_recipe') {
    output += ` 配方工具仅在 recipe 步骤允许。当前步骤类型为 ${step.kind}。`
  } else if (call.name === 'fabric_mixin_scaffold' || call.name === 'fabric_mixin_register') {
    output += ` Mixin 工具仅在 mixin 步骤允许。当前步骤类型为 ${step.kind}。`
  } else {
    output += ` 当前步骤允许的工具：${step.allowedTools.join(', ')}。请改用允许的工具，或调用 complete_step 推进到下一步骤。`
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
