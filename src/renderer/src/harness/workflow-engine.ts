import { EventKind, type Event } from './events.ts'
import type { PlanTracker } from './plan-tracker.ts'
import { isToolAllowedForStep, createRejectedToolResult, isRepairWriteBlocked, type ToolCallWithId, type ToolGateOptions } from './step-policy.ts'
import { executeBatch, isRunClientReadyResult, type Registry, type ToolContext, type ToolResult } from './tools.ts'
import type { WorkflowRunResult, WorkflowStep } from './workflow-types.ts'
import {
  assistantToolCallMessage,
  type ChatMessage,
  type ModelToolCall,
  toolResultMessage
} from './chat-message.ts'
import { isRetryableFetchError, sleep, fetchRetryDelayMs } from './fetch-retry.ts'
import { formatGradleErrorsForPrompt, gradleErrorSignature, parseGradleErrors } from './gradle-error-parser.ts'
import { classifyFabricLog } from './fabric-utils.ts'
import { canToolResultAdvanceStep } from './step-evidence.ts'
import { FileSession } from './file-session.ts'
import { workflowStepToPlanStep } from './workflow-types.ts'
import { validateToolCalls } from './tool-call-validator.ts'
import { MAX_EXECUTE_CLARIFICATIONS } from './clarify-validation.ts'

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
  /** When set, replace engine baseMessages with this compacted history. */
  replaceBaseMessages?: ChatMessage[]
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
  openCodeDelegate?: (step: WorkflowStep, instruction: string) => Promise<{ ok: boolean; output?: string; error?: string }>
  /** Shared ACI read session for this run; created if omitted */
  fileSession?: FileSession
  /** Shared with Agent — execute-phase ask_clarification cap. */
  clarificationGate?: { count: number }
}

let workflowToolId = 0

const MAX_REPAIR_ROUNDS = 3
const MAX_REPAIR_ROUNDS_CAP = 10
/** Free repair-diagnostic rounds (read_error_log / fabric_log_debugger only). */
export const MAX_FREE_REPAIR_DIAG_ROUNDS = 2
const MAX_MODEL_NETWORK_RETRIES = 2
const REPAIR_EXTRA_TOOLS = [
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
  'fabric_mixin_validate'
] as const

const REPAIR_DIAG_DEDUP_TOOLS = new Set(['read_error_log', 'fabric_log_debugger'])

function stableArgsKey(args: Record<string, unknown> | undefined): string {
  const a = args || {}
  const keys = Object.keys(a).sort()
  const sorted: Record<string, unknown> = {}
  for (const k of keys) sorted[k] = a[k]
  return JSON.stringify(sorted)
}

function firstStackFrame(log: string): string {
  const lines = log.split('\n')
  for (const line of lines) {
    const m = line.match(/(?:at\s+)?((?:src\/|net\/|com\/)[^\s(:]+\.(?:java|kt))(?::(\d+))?/i)
    if (m) return `${m[1].replace(/\\/g, '/')}${m[2] ? `:${m[2]}` : ''}`
  }
  const gradle = parseGradleErrors(log, 1)
  if (gradle[0]?.file) {
    return `${gradle[0].file}${gradle[0].line != null ? `:${gradle[0].line}` : ''}`
  }
  return ''
}

export function repairErrorSignature(output: string, kind: 'build' | 'run'): string {
  const gradleSig = gradleErrorSignature(output)
  const entries = parseGradleErrors(output, 1)
  if (kind === 'build' && entries.length > 0) return `gradle|${gradleSig}`

  const classified = classifyFabricLog(output)
  const frame = firstStackFrame(output)
  return `${classified.kind}|${frame || gradleSig.slice(0, 200)}`
}

/** Count distinct gradle/compiler error entries (for progress tracking). */
export function countGradleErrorEntries(output: string): number {
  return parseGradleErrors(output, 200).length
}

/** Unique source files referenced by gradle errors. */
export function uniqueGradleErrorFiles(output: string): string[] {
  const files = new Set<string>()
  for (const entry of parseGradleErrors(output, 200)) {
    if (!entry.file) continue
    files.add(entry.file.replace(/\\/g, '/'))
  }
  return [...files]
}

/**
 * Dynamic repair budget from failure output.
 * n unique error files → max(3, n+2), capped at MAX_REPAIR_ROUNDS_CAP.
 */
export function computeRepairBudget(failureOutput: string): number {
  const n = uniqueGradleErrorFiles(failureOutput).length
  if (n <= 0) return MAX_REPAIR_ROUNDS
  return Math.min(MAX_REPAIR_ROUNDS_CAP, Math.max(MAX_REPAIR_ROUNDS, n + 2))
}

const CLIENT_PACKAGE_ERROR_RE = /程序包\s*net\.minecraft\.client|package\s+net\.minecraft\.client/i

/** main-source files that fail because they import client-only packages. */
export function extractClientInMainMigrations(output: string): string[] {
  const mains = new Set<string>()
  for (const entry of parseGradleErrors(output, 200)) {
    if (!entry.file) continue
    const file = entry.file.replace(/\\/g, '/')
    if (!file.includes('src/main/java/')) continue
    if (!CLIENT_PACKAGE_ERROR_RE.test(entry.message) && !CLIENT_PACKAGE_ERROR_RE.test(output)) {
      // Still include main java files when the build log overall shows client-package isolation
      // and this file is among the error set.
      if (!/net\.minecraft\.client/.test(output)) continue
    }
    if (CLIENT_PACKAGE_ERROR_RE.test(entry.message) || /net\.minecraft\.client/.test(entry.message)) {
      mains.add(file)
    }
  }
  // Fallback: if log mentions client package isolation, take all main java error files
  if (mains.size === 0 && /net\.minecraft\.client/.test(output)) {
    for (const file of uniqueGradleErrorFiles(output)) {
      if (file.includes('src/main/java/')) mains.add(file)
    }
  }
  return [...mains]
}

export function mainToClientPath(mainPath: string): string {
  return mainPath.replace(/\\/g, '/').replace('src/main/java/', 'src/client/java/')
}

function formatMigrationChecklist(pendingMainDeletes: Set<string>): string {
  if (pendingMainDeletes.size === 0) return ''
  const lines = [...pendingMainDeletes].slice(0, 8).map((main) => {
    const client = mainToClientPath(main)
    const largeHint = '（若文件 >200 行：先 write_file 写骨架，再用多次 edit_file 分段填充）'
    return `- write_file("${client}", ...) ${largeHint}\n  delete_file("${main}")`
  })
  return (
    `\n【splitEnvironment 批量迁移】以下文件仍在 src/main/java 却引用 client 包。` +
    `必须全部迁完（write 新路径 + delete 旧路径）后才能 trigger_build：\n` +
    `${lines.join('\n')}\n`
  )
}

export function buildRepairInstruction(output: string, kind: 'build' | 'run'): string {
  const gradleEntries = parseGradleErrors(output, 8)
  const structuredGradle = formatGradleErrorsForPrompt(output)
  const classified = classifyFabricLog(output)
  const retry = kind === 'build' ? 'trigger_build build' : 'trigger_build runClient'
  const migrations = extractClientInMainMigrations(output)
  const fabricBlock =
    gradleEntries.length === 0 || kind === 'run'
      ? `\n--- Fabric/MC 分类 ---\n[${classified.kind}] ${classified.title}\n建议：${classified.advice}\n`
      : `\n--- Fabric/MC 补充 ---\n[${classified.kind}] ${classified.title}：${classified.advice}\n`
  if (migrations.length > 0) {
    const pending = new Set(migrations)
    return (
      `【${kind === 'build' ? '构建' : '运行'}失败，已进入修复模式】\n` +
      `根因：splitEnvironmentSourceSets 隔离 — client 类不能留在 src/main/java。\n` +
      `流程（强制顺序）：write_file 到 src/client/java → delete_file 删除旧 main 路径 → 全部迁完后再 ${retry}。\n` +
      `禁止在迁移未完成时 trigger_build；禁止用 edit_file 原地改 main 路径里的 client 引用。\n` +
      `大文件（>200 行）请 write_file 写骨架后用 edit_file 分段填充，避免参数截断。\n` +
      formatMigrationChecklist(pending) +
      `\n--- 错误摘要 ---\n${structuredGradle}` +
      fabricBlock
    )
  }
  return (
    `【${kind === 'build' ? '构建' : '运行'}失败，已进入修复模式】\n` +
    `流程：观察（read_error_log / fabric_log_debugger，限 ${MAX_FREE_REPAIR_DIAG_ROUNDS} 轮）→ ` +
    `write_file / edit_file / delete_file 修改代码 → 再验证（${retry}）。\n` +
    `在成功 write_file/edit_file/delete_file 之前禁止直接调用 ${retry}。\n\n` +
    `--- 错误摘要 ---\n${structuredGradle}` +
    fabricBlock
  )
}

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
    if (/Error starting game|游戏测试失败|启动失败|failed to start|\[MC_PHASE:error\]/i.test(output)) return true
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

function writeFileRetryInstruction(kind: 'build' | 'run'): string {
  const retry = kind === 'build' ? 'trigger_build build' : 'trigger_build runClient'
  return `【SYSTEM: 文件已修改，可以重新构建。请调用 ${retry} 验证修复结果。】`
}

const REPAIR_DIAGNOSTIC_TOOLS = new Set([
  'read_error_log',
  'fabric_log_debugger',
  // read_file / list_directory intentionally excluded — unlimited free reads caused
  // explore thrashing in repair mode (see session diag 20260718).
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

/** Pure read/list/grep during repair — subject to MAX_FREE_REPAIR_DIAG_ROUNDS via explore counter. */
function isRepairExploreResult(result: ToolResult): boolean {
  if (!result.ok || result.error) return false
  return result.toolName === 'read_file' || result.toolName === 'list_directory' || result.toolName === 'grep'
}

/** Knowledge queries that should not consume attempt budget for non-terminal steps.
 *  However, beyond MAX_FREE_KNOWLEDGE_ROUNDS per step, they WILL count toward attempt. */
const KNOWLEDGE_TOOLS = new Set([
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'vanilla_mc_wiki_query',
  'fabric_meta_version_check',
  'fabric_mod_json_validate'
])

const MAX_FREE_KNOWLEDGE_ROUNDS = 3
const MAX_DOC_SEARCH_PER_WRITE_STEP = 2
/** Pure read/list/grep rounds before first write evidence — do not burn attempt. */
export const MAX_FREE_EXPLORE_ROUNDS = 4
const EXPLORE_TOOLS = new Set(['read_file', 'list_directory', 'grep'])
/** After explore budget: strip roam tools only — keep read_file so edit_file aci_read_gate still works. */
const EXPLORE_ROAM_TOOLS = new Set(['list_directory', 'grep'])

/**
 * When explore rounds are exhausted, drop list/grep (+ knowledge) but keep read_file
 * so the model can still satisfy edit_file's read-before-edit gate.
 */
export function applyExploreToolLimit(
  names: string[],
  options: { exploreExhausted: boolean; stripKnowledge?: boolean }
): string[] {
  if (!options.exploreExhausted) return names
  return names.filter((name) => {
    if (EXPLORE_ROAM_TOOLS.has(name)) return false
    if (options.stripKnowledge && KNOWLEDGE_TOOLS.has(name)) return false
    return true
  })
}

export function isDocSearchLimitedStep(step: WorkflowStep): boolean {
  return step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin'
}

export function isExploreLimitedStep(step: WorkflowStep, repairMode = false): boolean {
  if (repairMode && (step.kind === 'build' || step.kind === 'run')) return true
  return step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin'
}

export function buildDocSearchBlockedResult(step: WorkflowStep, call: ToolCallWithId): ToolResult {
  return {
    output:
      `blocked: [doc_search_limit] 当前步骤 #${step.id} 已进行 ${MAX_DOC_SEARCH_PER_WRITE_STEP} 次 fabric_docs_search。` +
      `请直接 edit_file（优先）或 write_file 写入目标文件，或 complete_step 标记完成，不要再搜索文档。`,
    error: 'doc_search_limit: fabric_docs_search',
    durationMs: 0,
    ok: false,
    toolName: call.name,
    args: call.args,
    exitCode: null,
    errorKind: 'doc_search_limit'
  }
}

export function isDocSearchOnlyRejectionRound(results: Iterable<ToolResult>): boolean {
  const list = [...results]
  return list.length > 0 && list.every((result) => result.errorKind === 'doc_search_limit')
}

export function isKnowledgeOnlyRejectionRound(results: Iterable<ToolResult>): boolean {
  const list = [...results]
  return list.length > 0 && list.every((result) => KNOWLEDGE_TOOLS.has(result.toolName || ''))
}

/** Rejected-only rounds (whitelist / doc limit) must not burn write-step attempt. */
export function isNonBurningRejectionRound(results: Iterable<ToolResult>): boolean {
  const list = [...results]
  if (list.length === 0) return false
  return list.every((result) =>
    result.errorKind === 'doc_search_limit' ||
    result.errorKind === 'tool_not_offered' ||
    result.errorKind === 'tool_call_limit' ||
    result.errorKind === 'after_control_barrier'
  )
}

export function isPureExploreRound(results: ToolResult[]): boolean {
  return results.length > 0 && results.every((result) =>
    EXPLORE_TOOLS.has(result.toolName || '') && result.ok && !result.error
  )
}

/**
 * Do not nudge complete_step when reading an unrelated Java file on write/mixin/recipe
 * steps — that caused false "already done" stops (e.g. Frame_coverClient while creating
 * ScreenshotHandler).
 */
export function detectExistingHandlerHint(step: WorkflowStep, result: ToolResult): string | undefined {
  if (step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin') return undefined
  if (result.toolName !== 'read_file' || !result.ok || result.error) return undefined
  const path = String(result.args?.path || '').replace(/\\/g, '/')
  const output = String(result.output || '')
  const target = (step.targetPath || '').replace(/\\/g, '/')
  if (!/\.java$/i.test(path)) return undefined
  if (target && (path.endsWith(target) || path.includes(target))) return undefined
  if (!/UseBlockCallback|UseEntityCallback|UseItemCallback|\.register\s*\(|Handler|ModInitializer/i.test(output)) {
    return undefined
  }
  return (
    `【参考实现】读取到 ${path} 含注册/交互逻辑，可作参考。` +
    `当前步骤尚未完成时请继续执行允许的工具，不要仅因此 complete_step。`
  )
}

export function buildEmptyToolCallInstruction(step: WorkflowStep): string {
  const targetHint = step.targetPath
    ? `write_file("${step.targetPath}", ...) 或 edit_file("${step.targetPath}", ...)`
    : 'write_file(<新文件路径>, ...) 或 edit_file(<目标路径>, ...)'
  return (
    `【系统】当前步骤尚未完成：#${step.id} ${step.title}。` +
    `请立即调用 ${targetHint} 写入目标文件，或 complete_step()，不要只输出旁白或继续无目标探索。`
  )
}

export function buildWriteForceInstruction(step: WorkflowStep): string {
  const target = step.targetPath
    ? `目标文件：${step.targetPath}`
    : '请按步骤描述确定目标路径'
  return (
    `【强制写入】探索轮次已用尽。禁止 list_directory/grep/文档查询漫游。` +
    `${target}。可对目标路径 read_file 一次后 edit_file；或 write_file / fabric_mixin_scaffold 写出代码。`
  )
}

export function buildStepFailureMessage(
  step: WorkflowStep,
  attempt: number,
  maxIterations: number,
  lastToolName: string,
  repairNote: string,
  remaining: string
): string {
  return (
    `步骤 #${step.id}「${step.title}」未能自动完成（已用 ${attempt}/${maxIterations} 轮）。` +
    `最后工具：${lastToolName || '无'}。\n\n` +
    repairNote +
    `建议：发送「继续」恢复执行，或根据日志用 edit_file 修复后重试。\n\n` +
    `未完成步骤：\n${remaining}`
  )
}

function isKnowledgeRound(step: WorkflowStep, result: ToolResult | undefined, knowledgeCount: number): boolean {
  if (!result || !result.ok || result.error) return false
  if (step.kind === 'build' || step.kind === 'run') return false
  if (!KNOWLEDGE_TOOLS.has(result.toolName || '')) return false
  // After MAX_FREE_KNOWLEDGE_ROUNDS, knowledge queries count as real attempts
  return knowledgeCount < MAX_FREE_KNOWLEDGE_ROUNDS
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

function resultCompletesStep(
  step: WorkflowStep,
  result: ToolResult,
  stepHasEvidence: boolean
): boolean {
  if (!result.ok || result.error) return false
  if (result.toolName === 'complete_step') {
    if (step.kind === 'build' || step.kind === 'run') return false
    if (step.kind === 'write' || step.kind === 'inspect' || step.kind === 'recipe' || step.kind === 'mixin') {
      return stepHasEvidence
    }
    return true
  }
  switch (step.kind) {
    case 'recipe':
      return false
    case 'mixin':
      return false
    case 'inspect':
      // Evidence tools set stepHasEvidence; advancement requires complete_step
      return false
    case 'write':
      return false
    case 'build':
      return (
        (result.toolName === 'trigger_build' &&
          String(result.args?.task || 'build') === 'build' &&
          (result.exitCode == null || result.exitCode === 0)) ||
        (result.toolName === 'run_command' && result.exitCode === 0)
      )
    case 'run':
      return isRunClientReadyResult(result)
    case 'answer':
      return true
  }
}

export function recordsStepEvidence(step: WorkflowStep, result: ToolResult): boolean {
  if (!result.ok || result.error) return false
  if (step.kind === 'recipe') {
    return result.validation?.kind === 'recipe' && result.validation.valid
  }
  if (step.kind === 'mixin') {
    return result.validation?.kind === 'mixin' && result.validation.valid
  }
  if (step.kind !== 'write' && step.kind !== 'inspect') return false
  const planStep = {
    ...workflowStepToPlanStep(step),
    kind: step.kind,
    targetPath: step.targetPath,
    evidence: step.evidence
  }
  return canToolResultAdvanceStep(planStep, result).ok
}

export function stepEvidenceSatisfied(step: WorkflowStep, results: ToolResult[]): boolean {
  const successful = results.filter((result) => result.ok && !result.error)
  if (step.kind === 'inspect') {
    return successful.some((result) => recordsStepEvidence(step, result))
  }
  if (step.kind === 'recipe' || step.kind === 'mixin') {
    return successful.some((result) => recordsStepEvidence(step, result))
  }
  if (step.kind !== 'write') return false

  const requiredPaths = step.targetPaths?.length
    ? step.targetPaths
    : (step.targetPath ? [step.targetPath] : [])
  if (requiredPaths.length === 0) {
    return successful.some((result) => recordsStepEvidence(step, result))
  }
  return requiredPaths.every((targetPath) => successful.some((result) => {
    const artifacts = result.artifactPaths?.length
      ? result.artifactPaths
      : [result.artifactPath || String(result.args?.path || '')].filter(Boolean)
    return artifacts.some((artifactPath) => {
      // Check one required path at a time — do not keep sibling targetPaths
      // or a single-file write would satisfy every entry in the list.
      const planStep = {
        ...workflowStepToPlanStep(step),
        kind: 'write' as const,
        targetPath,
        targetPaths: undefined
      }
      return canToolResultAdvanceStep(planStep, { ...result, artifactPath }).ok
    })
  }))
}

export type DiskProbe = {
  exists: (absPath: string) => Promise<boolean>
  listDirectory: (absPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
}

function isDirectoryTarget(target: string): boolean {
  const withSlash = target.replace(/\\/g, '/')
  if (withSlash.endsWith('/')) return true
  const base = withSlash.replace(/\/+$/, '').split('/').pop() || ''
  return !base.includes('.')
}

/** Prefill write evidence from files already on disk (resume / 继续 after partial stop). */
export async function collectDiskWriteEvidence(
  projectPath: string,
  step: WorkflowStep,
  probe: DiskProbe
): Promise<ToolResult[]> {
  if (step.kind !== 'write') return []
  const targets = step.targetPaths?.length
    ? step.targetPaths
    : (step.targetPath ? [step.targetPath] : [])
  if (targets.length === 0) return []

  const found: string[] = []
  for (const target of targets) {
    const rel = target.replace(/\\/g, '/').replace(/\/+$/, '')
    const abs = `${projectPath}/${rel}`
    if (isDirectoryTarget(target)) {
      try {
        const entries = await probe.listDirectory(abs)
        for (const entry of entries) {
          if (!entry.isDirectory) {
            found.push(`${rel}/${entry.name}`)
          }
        }
      } catch {
        // directory missing or unreadable
      }
      continue
    }
    try {
      if (await probe.exists(abs)) found.push(rel)
    } catch {
      // ignore
    }
  }

  if (found.length === 0) return []
  return [{
    output: `磁盘已存在目标文件：${found.join(', ')}`,
    durationMs: 0,
    ok: true,
    toolName: 'write_file',
    args: { path: found[0] },
    artifactPath: found[0],
    artifactPaths: found,
    exitCode: 0
  }]
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
  private openCodeDelegate?: WorkflowEngineOptions['openCodeDelegate']
  private fileSession: FileSession
  private clarificationGate?: { count: number }

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
    this.openCodeDelegate = options.openCodeDelegate
    this.fileSession = options.fileSession || new FileSession()
    this.clarificationGate = options.clarificationGate
  }

  private planState(): Array<{
    id: string
    description: string
    status: string
    kind?: 'inspect' | 'write' | 'recipe' | 'mixin'
    targetPath?: string
    targetPaths?: string[]
    evidence?: string
  }> {
    return this.steps.map((step) => ({
      id: step.id,
      description: step.title,
      status: statusForPlan(step),
      ...(step.kind === 'inspect' || step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin' ? { kind: step.kind } : {}),
      ...(step.targetPath ? { targetPath: step.targetPath } : {}),
      ...(step.targetPaths?.length ? { targetPaths: [...step.targetPaths] } : {}),
      ...(step.evidence ? { evidence: step.evidence } : {})
    }))
  }

  private emitPlanState(): void {
    this.emit({ kind: EventKind.PlanState, planSteps: this.planState() })
  }

  private currentStep(): WorkflowStep | null {
    return this.steps.find((step) => step.status === 'running')
      ?? this.steps.find((step) => step.status === 'failed')
      ?? this.steps.find((step) => step.status === 'pending')
      ?? null
  }

  private toolSchemasFor(
    step: WorkflowStep,
    repairMode: boolean,
    _limits?: {
      fabricDocsSearchCount?: number
      knowledgeQueries?: number
      exploreRounds?: number
      stepHasEvidence?: boolean
    }
  ): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    // Stable tools set within a step: always offer the repair superset for build/run
    // so entering repairMode does not change the tools array (prompt-cache friendly).
    // Runtime gates (filterToolCallsForStep / isToolAllowedForStep) still block
    // edit/write until repair, and reject over-limit doc/explore calls.
    let names: string[]
    if (step.kind === 'build' || step.kind === 'run') {
      names = repairExtraTools(step)
    } else {
      names = [...step.allowedTools]
      if (repairMode) names = repairExtraTools(step)
    }
    return this.registry.schemas().filter((tool) => names.includes(tool.name))
  }

  private workflowPrompt(
    step: WorkflowStep,
    repairMode: boolean,
    repairWriteRequired: boolean,
    offeredToolNames?: string[],
    ephemeralInstruction?: string,
    pendingMigration?: Set<string>
  ): ChatMessage {
    const tools = offeredToolNames ?? (repairMode ? repairExtraTools(step) : step.allowedTools)
    const prefix = repairMode ? '【修复模式】' : '【工作流步骤】'
    const migrationPending = Boolean(pendingMigration && pendingMigration.size > 0)
    const repairGate =
      repairMode && (repairWriteRequired || migrationPending)
        ? migrationPending
          ? '必须先完成 splitEnvironment 批量迁移（write_file 到 client + delete_file 删 main）后才能 trigger_build。\n'
          : '必须先 write_file / edit_file / delete_file 修改代码后才能 trigger_build / run_command；禁止在未修改代码时直接重编译。\n'
        : ''
    const clarifyHint = tools.includes('ask_clarification')
      ? '标识符/路径/类名先用 read_file/grep 从项目推断；仅用户偏好或需求歧义才 ask_clarification（短问题+短选项）。禁止把 API 命名或实现清单丢给用户选。\n'
      : ''
    const evidenceHint = step.evidence
      ? `验收标准: ${step.evidence}\n`
      : ''
    const editHint =
      '新建文件用 write_file；修改已有文件优先 edit_file（须先 read_file）；迁移用 write_file 新路径 + delete_file 旧路径。'
    const buildFirst =
      (step.kind === 'build' || step.kind === 'run') && !repairMode
        ? step.kind === 'build'
          ? '本步先 trigger_build({"task":"build"})，不要先 edit_file。构建失败后才会进入修复模式。\n'
          : '本步先 trigger_build({"task":"runClient"})，不要先 edit_file。运行失败后才会进入修复模式。\n'
        : ''
    const migrationHint = migrationPending && pendingMigration
      ? formatMigrationChecklist(pendingMigration)
      : ''
    const ephemeral = ephemeralInstruction?.trim()
      ? `\n${ephemeralInstruction.trim()}\n`
      : ''
    return {
      role: 'user',
      content:
        `${prefix}${repairGate}${clarifyHint}${buildFirst}${migrationHint}${ephemeral}只执行当前步骤，不要重复已完成操作。\n` +
        `当前步骤 #${step.id}: ${step.title}\n类型: ${step.kind}\n${evidenceHint}允许工具: ${tools.join(', ') || '无'}\n` +
        `${editHint}工具成功且满足验收证据后主机会推进。`
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
    const ctx: ToolContext = {
      projectPath: this.projectPath,
      callId: `workflow_${step.id}`,
      abortSignal: this.abortSignal,
      planTracker: this.planTracker,
      fileSession: this.fileSession,
      onPlanStateChange: () => this.emitPlanState()
    }
    return executeBatch(
      calls,
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
  ): string | undefined {
    baseMessages.push(assistantToolCallMessage(streamContent, calls))
    for (const call of calls) {
      const result = resultsById.get(call.id)
      baseMessages.push(toolResultMessage(call, result?.output ?? ''))
    }
    // Do NOT persist instruction as role:system in baseMessages — that breaks
    // prompt-cache prefixes. Return it for the next ephemeral workflowPrompt instead.
    return instruction?.trim() || undefined
  }

  async run(baseMessages: ChatMessage[]): Promise<WorkflowRunResult> {
    let finalContent = ''
    this.emitPlanState()

    while (!this.abortSignal?.aborted) {
      const step = this.currentStep()
      if (!step) break
      if (step.status === 'pending' || step.status === 'failed') step.status = 'running'
      this.emitPlanState()
      const delegatedEvidence: ToolResult[] = []

      if (
        this.openCodeDelegate &&
        step.kind === 'write' &&
        this.projectPath &&
        !this.abortSignal?.aborted
      ) {
        const targets = step.targetPaths?.length
          ? step.targetPaths
          : (step.targetPath ? [step.targetPath] : [])
        const instruction =
          `完成 Fabric 模组写码步骤：${step.title}\n` +
          `目标路径：${targets.join(', ') || '由当前步骤确定'}\n` +
          `验收标准：${step.evidence || '目标文件产生最小、正确的变更'}\n` +
          `当前计划：\n${this.planTracker.toContextBlock()}`
        const delegated = await this.openCodeDelegate(step, instruction)
        if (delegated.ok) {
          if (delegated.output?.trim()) {
            finalContent = delegated.output
          }
          const changedPaths = delegated.changedPaths || []
          delegatedEvidence.push({
            output: `OpenCode 已验证变更：${changedPaths.join(', ')}`,
            durationMs: 0,
            ok: true,
            toolName: 'write_file',
            args: { path: changedPaths[0] || step.targetPath || '' },
            artifactPath: changedPaths[0],
            artifactPaths: changedPaths,
            exitCode: 0
          })
          baseMessages.push({
            role: 'system',
            content:
              `【OpenCode 委托证据】已修改并验证：${changedPaths.join(', ')}。` +
              `请核对验收标准后调用 complete_step 完成当前步骤；不要重复写入。`
          })
          this.emit({
            kind: EventKind.Notice,
            notice: {
              level: 'info',
              text: 'OpenCode 已产生经过目标校验的文件变更，等待 Harness 验收步骤'
            }
          })
        } else this.emit({
          kind: EventKind.Notice,
          notice: {
            level: 'warn',
            text: `OpenCode 委托失败，回退自研 Agent：${delegated.error || 'unknown'}`
          }
        })
      }

      const diskEvidence: ToolResult[] = []
      if (step.kind === 'write' && this.projectPath) {
        try {
          const existing = await collectDiskWriteEvidence(this.projectPath, step, {
            exists: (p) => window.api.exists(p),
            listDirectory: (p) => window.api.listDirectory(p)
          })
          if (existing.length > 0) {
            diskEvidence.push(...existing)
            const paths = existing.flatMap((result) =>
              result.artifactPaths?.length
                ? result.artifactPaths
                : (result.artifactPath ? [result.artifactPath] : [])
            )
            baseMessages.push({
              role: 'system',
              content:
                `【已有文件证据】目标路径已存在于磁盘：${paths.join(', ')}。` +
                `若内容已满足验收标准，请直接 complete_step；不要重复写入。`
            })
          }
        } catch {
          // Probe failures must not block the step
        }
      }

      let completed = false
      let repairMode = false
      let repairWriteRequired = false
      let repairValidationRequired: 'recipe' | 'mixin' | undefined
      let repairRounds = 0
      let effectiveMaxRepairRounds = MAX_REPAIR_ROUNDS
      let lastErrorCount = 0
      let lastFailureOutput = ''
      const seenRepairSignatures = new Set<string>()
      const seenDiagSignatures = new Set<string>()
      const pendingMigration = new Set<string>()
      let pendingEphemeralInstruction: string | undefined
      let repairDiagRounds = 0
      const evidenceResults: ToolResult[] = [...diskEvidence, ...delegatedEvidence]
      let stepHasEvidence = stepEvidenceSatisfied(step, evidenceResults)
      let evidenceIdleRounds = 0
      let exploreRounds = 0
      let consecutiveIdenticalRejections = 0
      let lastRejectionSignature = ''
      let debuggerPrefetched = false
      let attempt = 0
      let loopIterations = 0
      let modelNetworkRetries = 0
      let knowledgeQueries = 0
      let fabricDocsSearchCount = 0
      let lastToolName = ''
      const maxIterations = step.maxAttempts + MAX_REPAIR_ROUNDS_CAP
      const maxLoopIterations = maxIterations + MAX_REPAIR_ROUNDS_CAP * 8

      while (!completed && attempt < maxIterations && loopIterations < maxLoopIterations) {
        loopIterations++
        const migrationPending = pendingMigration.size > 0
        const policyOptions: ToolGateOptions | undefined = repairMode
          ? {
              repairMode: true,
              repairWriteRequired: repairWriteRequired || migrationPending,
              repairValidationRequired
            }
          : undefined
        const allowedTools = this.toolSchemasFor(step, repairMode, {
          fabricDocsSearchCount,
          knowledgeQueries,
          exploreRounds,
          stepHasEvidence
        })
        const offeredNames = allowedTools.map((tool) => tool.name)
        const ephemeral = pendingEphemeralInstruction
        pendingEphemeralInstruction = undefined
        const modelMessages = [
          ...baseMessages,
          this.workflowPrompt(
            step,
            repairMode,
            repairWriteRequired || migrationPending,
            offeredNames,
            ephemeral,
            pendingMigration
          )
        ]
        let streamText = ''
        let streamReasoning = ''
        let modelResult: WorkflowModelResult
        try {
          modelResult = await this.modelCall(modelMessages, allowedTools, (text, reasoning) => {
            if (text) streamText = text
            if (reasoning) streamReasoning = reasoning
          })
          if (modelResult.replaceBaseMessages) {
            baseMessages.length = 0
            baseMessages.push(...modelResult.replaceBaseMessages)
          }
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

        const allCalls = normalizeModelToolCalls(modelResult.toolCalls)
        if (allCalls.length === 0) {
          // Answer steps auto-complete on text output; no tool calls needed.
          if (step.kind === 'answer') {
            step.status = 'completed'
            this.planTracker.advanceCurrent('answer text')
            finalContent = modelResult.text || streamText || finalContent
            this.emitPlanState()
            completed = true
            break
          }
          baseMessages.push({
            role: 'user',
            content: buildEmptyToolCallInstruction(step)
          })
          attempt++
          continue
        }

        const validation = validateToolCalls(allCalls, allowedTools)
        for (const [id, rejected] of validation.rejected) {
          this.emitRejected(id, rejected)
        }
        const calls = validation.accepted
        if (calls.length === 0) {
          const onlyKnowledgeRejected = isKnowledgeOnlyRejectionRound(validation.rejected.values())
          pendingEphemeralInstruction = this.appendToolRound(
            baseMessages,
            modelResult.text || streamText,
            allCalls,
            validation.rejected,
            onlyKnowledgeRejected
              ? buildEmptyToolCallInstruction(step)
              : '所有工具调用均被当前步骤白名单或参数 Schema 拒绝。请根据错误修正调用。'
          )
          if (!onlyKnowledgeRejected) attempt++
          continue
        }

        const resultsById = new Map<string, ToolResult>(validation.rejected)
        const executableAllowed: ToolCallWithId[] = []
        let controlBarrierReached = false
        let projectedDocSearchCount = fabricDocsSearchCount
        for (const call of calls) {
          if (executableAllowed.length >= 8) {
            const rejected: ToolResult = {
              output: `blocked: [tool_call_limit] 单轮最多执行 8 个工具，"${call.name}" 已延后。`,
              error: 'tool_call_limit',
              durationMs: 0,
              ok: false,
              toolName: call.name,
              args: call.args,
              exitCode: null,
              errorKind: 'tool_call_limit'
            }
            this.emitRejected(call.id, rejected)
            resultsById.set(call.id, rejected)
            continue
          }
          if (controlBarrierReached) {
            const rejected: ToolResult = {
              output: `blocked: [after_control_barrier] "${call.name}" 位于控制调用之后，未执行。请在下一轮调用。`,
              error: 'after_control_barrier',
              durationMs: 0,
              ok: false,
              toolName: call.name,
              args: call.args,
              exitCode: null,
              errorKind: 'after_control_barrier'
            }
            this.emitRejected(call.id, rejected)
            resultsById.set(call.id, rejected)
            continue
          }
          if (!isToolAllowedForStep(step, call, policyOptions)) {
            const rejected = createRejectedToolResult(step, call, policyOptions)
            this.emitRejected(call.id, rejected)
            resultsById.set(call.id, rejected)
            continue
          }
          if (
            isDocSearchLimitedStep(step) &&
            call.name === 'fabric_docs_search' &&
            projectedDocSearchCount >= MAX_DOC_SEARCH_PER_WRITE_STEP
          ) {
            const rejected = buildDocSearchBlockedResult(step, call)
            this.emitRejected(call.id, rejected)
            resultsById.set(call.id, rejected)
            continue
          }
          if (repairMode && REPAIR_DIAG_DEDUP_TOOLS.has(call.name)) {
            const diagSig = `${call.name}\0${stableArgsKey(call.args)}`
            if (seenDiagSignatures.has(diagSig)) {
              const rejected: ToolResult = {
                output:
                  `blocked: [repair_diag_dedup] "${call.name}" 已用相同参数执行过。请改用 edit_file 做最小补丁，或更换诊断参数。`,
                error: 'repair_diag_dedup',
                durationMs: 0,
                ok: false,
                toolName: call.name,
                args: call.args,
                exitCode: null,
                errorKind: 'repair_diag_dedup'
              }
              this.emitRejected(call.id, rejected)
              resultsById.set(call.id, rejected)
              continue
            }
          }
          executableAllowed.push(call)
          if (call.name === 'fabric_docs_search') projectedDocSearchCount++
          if (call.name === 'complete_step' || call.name === 'ask_clarification') {
            controlBarrierReached = true
          }
        }

        if (executableAllowed.length === 0) {
          const repairWriteBlockedOnly =
            repairMode &&
            (repairWriteRequired || repairValidationRequired || pendingMigration.size > 0) &&
            calls.length > 0 &&
            calls.every((call) => isRepairWriteBlocked(step, call, policyOptions))
          const docSearchBlockedOnly = isDocSearchOnlyRejectionRound(resultsById.values())
          const nonBurningRejection = isNonBurningRejectionRound(resultsById.values())
          const rejectionSig = [...resultsById.values()]
            .map((r) => `${r.toolName}:${r.errorKind || r.error || ''}`)
            .sort()
            .join('|')
          if (rejectionSig && rejectionSig === lastRejectionSignature) {
            consecutiveIdenticalRejections++
          } else {
            consecutiveIdenticalRejections = 1
            lastRejectionSignature = rejectionSig
          }
          const buildEditLoop =
            (step.kind === 'build' || step.kind === 'run') &&
            !repairMode &&
            [...resultsById.values()].every((r) =>
              r.errorKind === 'tool_not_allowed' &&
              (r.toolName === 'edit_file' || r.toolName === 'write_file')
            )
          const rejectionHint = [
            [...resultsById.values()].map((r) => r.output).filter(Boolean).join('\n'),
            repairWriteBlockedOnly
              ? pendingMigration.size > 0
                ? '修复模式下必须先完成 client 迁移（write_file + delete_file），再重新构建。'
                : '修复模式下必须先 write_file / edit_file / delete_file 修改代码，再重新构建。'
              : buildEditLoop
                ? (step.kind === 'build'
                  ? '【禁止循环改文件】构建步骤当前不允许 edit_file。请立即 trigger_build({"task":"build"})；失败后才进入修复模式。'
                  : '【禁止循环改文件】运行步骤当前不允许 edit_file。请立即 trigger_build({"task":"runClient"})；失败后才进入修复模式。')
              : docSearchBlockedOnly || nonBurningRejection
                ? buildEmptyToolCallInstruction(step)
                : `本步骤允许的工具：${offeredNames.join(', ') || '无'}。请改用其中之一完成当前步骤。`
          ].join('\n\n')
          pendingEphemeralInstruction = this.appendToolRound(
            baseMessages,
            modelResult.text || streamText,
            allCalls,
            resultsById,
            rejectionHint
          )
          // Identical rejection spam (e.g. edit_file on build) burns budget faster to escape loops.
          if (consecutiveIdenticalRejections >= 2) {
            attempt += 2
          } else if (!repairWriteBlockedOnly && !docSearchBlockedOnly && !nonBurningRejection) {
            attempt++
          }
          continue
        }
        consecutiveIdenticalRejections = 0
        lastRejectionSignature = ''

        const executed = await this.executeAllowedCalls(step, executableAllowed)
        for (const [id, result] of executed) {
          resultsById.set(id, result)
          if (REPAIR_DIAG_DEDUP_TOOLS.has(result.toolName || '') && result.ok && !result.error) {
            seenDiagSignatures.add(`${result.toolName}\0${stableArgsKey(result.args)}`)
          }
          const invalidatesRecipe = step.kind === 'recipe' &&
            (result.toolName === 'edit_file' || result.toolName === 'write_file' || result.toolName === 'delete_file')
          const invalidatesMixin = step.kind === 'mixin' &&
            ['edit_file', 'write_file', 'delete_file', 'fabric_mixin_scaffold', 'fabric_mixin_register'].includes(result.toolName || '')
          if (invalidatesRecipe || invalidatesMixin) {
            const kind = invalidatesRecipe ? 'recipe' : 'mixin'
            for (let index = evidenceResults.length - 1; index >= 0; index--) {
              if (evidenceResults[index].validation?.kind === kind) evidenceResults.splice(index, 1)
            }
          }
          evidenceResults.push(result)
        }
        stepHasEvidence = stepEvidenceSatisfied(step, evidenceResults)

        const orderedResults = executableAllowed
          .map((call) => resultsById.get(call.id))
          .filter((result): result is ToolResult => Boolean(result))
        const lastResult = orderedResults[orderedResults.length - 1]
        if (lastResult?.toolName) lastToolName = lastResult.toolName

        fabricDocsSearchCount += orderedResults.filter((result) =>
          result.toolName === 'fabric_docs_search' && result.ok && !result.error
        ).length

        const clarificationResult = orderedResults.find((result) =>
          result.toolName === 'ask_clarification' && result.ok && !result.error
        )
        if (clarificationResult) {
          const used = this.clarificationGate?.count ?? 0
          if (used >= MAX_EXECUTE_CLARIFICATIONS) {
            pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById)
            baseMessages.push({
              role: 'user',
              content:
                `【系统】澄清次数已达上限（${MAX_EXECUTE_CLARIFICATIONS} 次）。` +
                '请自行选择最简一致方案并继续执行当前步骤，禁止再次 ask_clarification。'
            })
            attempt++
            continue
          }
          if (this.clarificationGate) this.clarificationGate.count++
          const question = String(clarificationResult.args?.question || '')
          const options = Array.isArray(clarificationResult.args?.options)
            ? (clarificationResult.args.options as string[]).map(String)
            : undefined
          pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById)
          return {
            finalContent: clarificationResult.output,
            allDone: false,
            partial: false,
            needsClarification: true,
            clarificationQuestion: question,
            clarificationOptions: options,
            steps: this.steps
          }
        }

        const decisiveResult = orderedResults.find((result) =>
          isTerminalFailure(step, result) || resultCompletesStep(step, result, stepHasEvidence)
        )
        const success = decisiveResult
          ? resultCompletesStep(step, decisiveResult, stepHasEvidence)
          : false
        let roundInstruction: string | undefined

        if (success) {
          repairMode = false
          repairWriteRequired = false
          repairValidationRequired = undefined
          repairRounds = 0
          pendingMigration.clear()
          pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById)
          step.status = 'completed'
          this.planTracker.advanceCurrent(decisiveResult!.toolName || 'workflow evidence')
          completed = true
          this.emitPlanState()
          break
        }

        // Write/inspect: once evidence exists, stop burning budget on re-reads and
        // auto-complete if the model keeps stalling without complete_step.
        if (
          stepHasEvidence &&
          (step.kind === 'write' || step.kind === 'inspect' || step.kind === 'recipe' || step.kind === 'mixin')
        ) {
          evidenceIdleRounds++
          roundInstruction = [
            roundInstruction,
            `【验收证据已满足】请立即调用 complete_step({"stepId":"${step.id}"}) 推进下一步，禁止继续重复 read_file/edit_file。`
          ].filter(Boolean).join('\n\n')
          if (evidenceIdleRounds >= 2) {
            pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)
            step.status = 'completed'
            this.planTracker.advanceCurrent('auto_complete_after_evidence')
            completed = true
            this.emitPlanState()
            this.emit({
              kind: EventKind.Notice,
              notice: {
                level: 'info',
                text: `步骤 #${step.id} 验收证据已满足，已自动推进（模型未及时 complete_step）。`
              }
            })
            break
          }
        } else {
          evidenceIdleRounds = 0
        }

        if (decisiveResult && isTerminalFailure(step, decisiveResult)) {
          const signature = repairErrorSignature(decisiveResult.output, step.kind as 'build' | 'run')
          const errorCount = countGradleErrorEntries(decisiveResult.output)
          if (seenRepairSignatures.has(signature)) {
            roundInstruction =
              '【修复去重】相同错误签名已出现，禁止重复相同诊断/构建。请换用 write_file/edit_file/delete_file 做不同修改；仅用户偏好不明时才 ask_clarification。'
            pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)
            attempt++
            continue
          }
          seenRepairSignatures.add(signature)
          repairMode = true
          repairWriteRequired = true
          repairValidationRequired = undefined
          lastFailureOutput = decisiveResult.output
          effectiveMaxRepairRounds = Math.max(effectiveMaxRepairRounds, computeRepairBudget(lastFailureOutput))
          // Progressive: error count decreased → do not burn a repairRound.
          const progressed = lastErrorCount > 0 && errorCount > 0 && errorCount < lastErrorCount
          if (!progressed) repairRounds++
          lastErrorCount = errorCount || lastErrorCount
          for (const main of extractClientInMainMigrations(lastFailureOutput)) {
            pendingMigration.add(main.replace(/\\/g, '/'))
          }
          roundInstruction = buildRepairInstruction(lastFailureOutput, step.kind as 'build' | 'run')
          if (pendingMigration.size > 0) {
            roundInstruction += formatMigrationChecklist(pendingMigration)
          }
          if (!debuggerPrefetched) {
            debuggerPrefetched = true
            const dbg = this.registry.get('fabric_log_debugger')
            if (dbg) {
              try {
                const dbgOut = await dbg.execute(
                  {
                    projectPath: this.projectPath,
                    callId: `repair_prefetch_${step.id}`,
                    fileSession: this.fileSession
                  },
                  { log: lastFailureOutput.slice(0, 12000) }
                )
                roundInstruction += `\n--- 自动诊断（仅此一次）---\n${dbgOut}`
                seenDiagSignatures.add(`fabric_log_debugger\0${stableArgsKey({ log: lastFailureOutput.slice(0, 12000) })}`)
              } catch {
                // ignore prefetch errors
              }
            }
          }
          pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)
          if (repairRounds > effectiveMaxRepairRounds) {
            attempt = maxIterations
            break
          }
          continue
        }

        // Track splitEnvironment migrations: delete_file removes pending main paths.
        for (const result of orderedResults) {
          if (!result.ok || result.error) continue
          if (result.toolName !== 'delete_file') continue
          const path = String(result.artifactPath || result.args?.path || '').replace(/\\/g, '/')
          if (path && pendingMigration.has(path)) pendingMigration.delete(path)
        }

        const repairWrite = orderedResults.find((result) =>
          (result.toolName === 'write_file' || result.toolName === 'edit_file' || result.toolName === 'delete_file') &&
          result.ok &&
          !result.error
        )
        if (repairMode && repairWrite) {
          const changedPath = String(repairWrite.artifactPath || repairWrite.args?.path || '').replace(/\\/g, '/')
          const changedLower = changedPath.toLowerCase()
          if (repairWrite.toolName === 'delete_file' && pendingMigration.has(changedPath)) {
            pendingMigration.delete(changedPath)
          }
          // Batch migration: keep repairWriteRequired until pendingMigration is empty.
          if (pendingMigration.size > 0) {
            repairWriteRequired = true
            roundInstruction =
              `【SYSTEM: 迁移未完成】还剩 ${pendingMigration.size} 个 main 文件待 delete_file。` +
              `禁止 trigger_build。\n` +
              formatMigrationChecklist(pendingMigration)
            // Skip mixin validate gate during bulk migration — finish moves first.
            repairValidationRequired = undefined
          } else {
            repairWriteRequired = false
            repairValidationRequired = repairWrite.toolName === 'delete_file'
              ? undefined
              : /\/data\/[^/]+\/recipes?\/.+\.json$/.test(changedLower)
                ? 'recipe'
                : (/mixins?\.json$/.test(changedLower) || (/mixin/.test(changedLower) && changedLower.endsWith('.java')))
                  ? 'mixin'
                  : undefined
            roundInstruction = repairValidationRequired
              ? `【SYSTEM: 文件已修改。重新构建前必须调用 fabric_${repairValidationRequired}_validate 取得静态验证证据。】`
              : writeFileRetryInstruction(step.kind as 'build' | 'run')
          }
          pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)
          continue
        }

        const repairValidation = orderedResults.find((result) =>
          repairValidationRequired && result.validation?.kind === repairValidationRequired && result.validation.valid && result.ok && !result.error
        )
        if (repairMode && repairValidationRequired && repairValidation) {
          repairValidationRequired = undefined
          roundInstruction = writeFileRetryInstruction(step.kind as 'build' | 'run')
          pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)
          continue
        }

        const existingHandlerHint = orderedResults
          .map((result) => detectExistingHandlerHint(step, result))
          .find(Boolean)
        if (existingHandlerHint) {
          roundInstruction = existingHandlerHint
        }

        // Track knowledge queries and limit per step
        const successfulKnowledge = orderedResults.filter((result) =>
          result.ok && !result.error && KNOWLEDGE_TOOLS.has(result.toolName || '')
        )
        if (successfulKnowledge.length > 0) {
          knowledgeQueries += successfulKnowledge.length
          if (knowledgeQueries > MAX_FREE_KNOWLEDGE_ROUNDS) {
            roundInstruction = [
              roundInstruction,
              `【知识查询已达上限】本步骤已进行 ${knowledgeQueries} 次文档查询（上限 ${MAX_FREE_KNOWLEDGE_ROUNDS} 次免费）。剩余查询将消耗步骤配额。请直接 edit_file 或 complete_step 完成当前步骤，不要再搜索文档。`
            ].filter(Boolean).join('\n\n')
          }
        }

        const pureExplore = isPureExploreRound(orderedResults)
        const repairExploreOnly =
          repairMode &&
          orderedResults.length > 0 &&
          orderedResults.every((result) => isRepairExploreResult(result) || isRepairDiagnosticResult(step, result, repairMode))
        if (pureExplore && isExploreLimitedStep(step, repairMode) && !stepHasEvidence) {
          exploreRounds++
          if (exploreRounds >= MAX_FREE_EXPLORE_ROUNDS) {
            roundInstruction = [
              roundInstruction,
              buildWriteForceInstruction(step)
            ].filter(Boolean).join('\n\n')
          }
        }
        if (repairExploreOnly) {
          repairDiagRounds++
          if (repairDiagRounds > MAX_FREE_REPAIR_DIAG_ROUNDS) {
            roundInstruction = [
              roundInstruction,
              `【修复只读轮次已用尽】已进行 ${repairDiagRounds} 轮诊断/勘察（上限 ${MAX_FREE_REPAIR_DIAG_ROUNDS}）。` +
                `必须立即 write_file / edit_file / delete_file 开始修复，禁止继续只读。`
            ].filter(Boolean).join('\n\n')
          }
        }

        const requestedCompletion = orderedResults.some((result) => result.toolName === 'complete_step' && result.ok)
        if (requestedCompletion && !success) {
          roundInstruction = [
            roundInstruction,
            `blocked: [step_evidence_required] 步骤 #${step.id} 尚未满足验收证据，未推进计划。`
          ].filter(Boolean).join('\n\n')
        }

        pendingEphemeralInstruction = this.appendToolRound(baseMessages, modelResult.text || streamText, allCalls, resultsById, roundInstruction)

        const repairDiagnosticRound = repairMode && orderedResults.length > 0 &&
          orderedResults.every((result) => isRepairDiagnosticResult(step, result, repairMode)) &&
          repairDiagRounds <= MAX_FREE_REPAIR_DIAG_ROUNDS
        const freeKnowledgeRound = successfulKnowledge.length === orderedResults.length &&
          knowledgeQueries <= MAX_FREE_KNOWLEDGE_ROUNDS
        const freeExploreRound =
          pureExplore &&
          isExploreLimitedStep(step, repairMode) &&
          !stepHasEvidence &&
          exploreRounds <= MAX_FREE_EXPLORE_ROUNDS
        const freeRepairExplore =
          repairExploreOnly && repairDiagRounds <= MAX_FREE_REPAIR_DIAG_ROUNDS
        const readOnlyAfterEvidence =
          stepHasEvidence &&
          orderedResults.length > 0 &&
          orderedResults.every((result) =>
            result.toolName === 'read_file' ||
            result.toolName === 'list_directory' ||
            result.toolName === 'grep'
          )
        if (!repairDiagnosticRound && !freeKnowledgeRound && !freeExploreRound && !freeRepairExplore && !readOnlyAfterEvidence) {
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
          repairRounds > effectiveMaxRepairRounds
            ? `已尝试 ${repairRounds}/${effectiveMaxRepairRounds} 轮自动修复仍未成功。\n\n最后错误：\n${lastFailureOutput.trim().split('\n').slice(-40).join('\n')}\n\n`
            : ''
        return {
          finalContent:
            finalContent.trim() ||
            buildStepFailureMessage(step, attempt, maxIterations, lastToolName, repairNote, remaining),
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
