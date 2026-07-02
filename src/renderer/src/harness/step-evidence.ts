import type { PlanStepState } from './plan-tracker.ts'
import type { ToolResult } from './tools.ts'

export type StepKind = 'inspect' | 'write' | 'build' | 'run' | 'unknown'

export interface StepAdvanceDecision {
  ok: boolean
  reason: string
}

const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;）)]+)(?:`)?/gi

export function inferStepKind(description: string): StepKind {
  const d = description.toLowerCase()
  if (/runclient|启动游戏|运行游戏/.test(d)) return 'run'
  if (/gradlew|gradle\s|trigger_build|编译|构建|build/.test(d)) return 'build'
  if (/读取|查看|检查|获取|确认|read|list|fabric\.mod\.json/.test(d)) return 'inspect'
  if (/创建|写入|生成|修改|配方|recipe|recipes|\.json|\.java|\.gradle|\.properties|\.toml/.test(d)) return 'write'
  return 'unknown'
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/[，,。；;）)]+$/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractPaths(description: string): string[] {
  const paths: string[] = []
  for (const match of description.matchAll(PATH_RE)) {
    paths.push(normalizedPath(match[1]))
  }
  return paths
}

function patternMatchesPath(pattern: string, actualPath: string): boolean {
  const normalizedPattern = normalizedPath(pattern)
  const normalizedActual = normalizedPath(actualPath)
  if (!normalizedPattern) return false
  if (!normalizedPattern.includes('<')) {
    return normalizedActual.endsWith(normalizedPattern) || normalizedActual.includes(`/${normalizedPattern}`)
  }
  const regexSource = escapeRegExp(normalizedPattern)
    .replace(/\\<[^>]+\\>/g, '[^/]+')
    .replace(/<[^>]+>/g, '[^/]+')
  return new RegExp(`(^|/)${regexSource}$`).test(normalizedActual)
    || new RegExp(`(^|/)${regexSource}`).test(normalizedActual)
}

function writePathMatchesStep(step: PlanStepState, artifactPath: string | undefined): boolean {
  if (!artifactPath) return false
  const paths = extractPaths(step.description)
  if (paths.length > 0) {
    return paths.some((p) => patternMatchesPath(p, artifactPath))
  }
  const d = step.description.toLowerCase()
  const actual = normalizedPath(artifactPath).toLowerCase()
  if (/recipe|配方|recipes/.test(d)) return /(^|\/)recipes\/.+\.json$/.test(actual)
  if (/\.json/.test(d)) return actual.endsWith('.json')
  if (/\.java/.test(d)) return actual.endsWith('.java')
  return false
}

function resultOk(result: ToolResult): boolean {
  return result.ok ?? !result.error
}

export function canToolResultAdvanceStep(
  step: PlanStepState | null,
  result: ToolResult
): StepAdvanceDecision {
  if (!step) return { ok: false, reason: 'no_current_step' }
  if (!resultOk(result)) return { ok: false, reason: 'tool_failed' }

  const kind = inferStepKind(step.description)
  const toolName = result.toolName

  if (kind === 'inspect') {
    const ok = toolName === 'read_file' || toolName === 'list_directory'
    return { ok, reason: ok ? 'inspect_ok' : 'inspect_tool_mismatch' }
  }

  if (kind === 'write') {
    const artifactPath = result.artifactPath || String(result.args?.path || '')
    const ok = (toolName === 'write_file' || toolName === 'create_recipe') && writePathMatchesStep(step, artifactPath)
    return { ok, reason: ok ? 'file_written' : 'write_path_mismatch' }
  }

  if (kind === 'build') {
    const task = String(result.args?.task || result.args?.command || '')
    const ok = (
      (toolName === 'trigger_build' &&
        (task === 'build' || (!task && (result.exitCode == null || result.exitCode === 0))) &&
        (result.exitCode == null || result.exitCode === 0)) ||
      (toolName === 'run_command' && /gradlew|gradle|build/i.test(task) && result.exitCode === 0)
    )
    return { ok, reason: ok ? 'build_successful' : 'build_tool_mismatch' }
  }

  if (kind === 'run') {
    const task = String(result.args?.task || result.args?.command || '')
    const ok = (
      (toolName === 'trigger_build' &&
        task === 'runClient' &&
        (result.meta?.runClientStarted || result.meta?.mcPhase === 'playing' || /\[MC_PHASE:playing\]/i.test(String(result.output)))) ||
      (toolName === 'run_command' && /runClient/i.test(task) && (result.exitCode == null || result.exitCode === 0))
    )
    return { ok, reason: ok ? 'run_started' : 'run_tool_mismatch' }
  }

  return { ok: false, reason: 'unknown_step_kind' }
}

export function findAdvanceEvidence(
  step: PlanStepState | null,
  results: Iterable<ToolResult>
): StepAdvanceDecision {
  for (const result of results) {
    const decision = canToolResultAdvanceStep(step, result)
    if (decision.ok) return decision
  }
  return { ok: false, reason: 'no_matching_evidence' }
}
