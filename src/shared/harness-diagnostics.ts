import type { Diagnostic } from './harness-runtime.ts'

/** Stable, provider-independent text normalization for repair comparisons. */
export function normalizeDiagnosticMessage(value: string): string {
  return value
    .replace(/([A-Za-z]:)?[\\/][^\s:]+\.(?:java|kt|json|gradle(?:\.kts)?)/gi, '<file>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Small deterministic hash for cross-process fingerprints. */
export function stableTextHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function diagnosticSetKey(diagnostics: Diagnostic[]): string {
  return stableTextHash(
    diagnostics
      .map((diagnostic) => `${diagnostic.rootCauseId || diagnostic.id}:${diagnostic.stage}:${diagnostic.normalizedMessage}`)
      .sort()
      .join('\n')
  )
}

export interface DiagnosticProgress {
  progressed: boolean
  resolvedIds: string[]
  newIds: string[]
  unchangedIds: string[]
  stageAdvanced: boolean
  reason: 'resolved' | 'stage_advanced' | 'new_downstream' | 'unchanged' | 'no_previous'
}

const STAGE_ORDER: Record<string, number> = {
  configuration: 1,
  dependency: 2,
  java_compile: 3,
  resource: 4,
  mixin: 5,
  startup: 6,
  game_test: 7,
  unknown: 0
}

/**
 * Count progress by diagnostic identity and stage, not by raw error count.
 * Fixing one root error and exposing a downstream error is considered progress.
 */
export function compareDiagnosticProgress(previous: Diagnostic[], current: Diagnostic[]): DiagnosticProgress {
  if (previous.length === 0) {
    return {
      progressed: current.length > 0,
      resolvedIds: [],
      newIds: current.map((diagnostic) => diagnostic.id),
      unchangedIds: [],
      stageAdvanced: false,
      reason: 'no_previous'
    }
  }
  const previousIds = new Set(previous.map((diagnostic) => diagnostic.id))
  const currentIds = new Set(current.map((diagnostic) => diagnostic.id))
  const resolvedIds = previous.filter((diagnostic) => !currentIds.has(diagnostic.id)).map((diagnostic) => diagnostic.id)
  const newIds = current.filter((diagnostic) => !previousIds.has(diagnostic.id)).map((diagnostic) => diagnostic.id)
  const unchangedIds = current.filter((diagnostic) => previousIds.has(diagnostic.id)).map((diagnostic) => diagnostic.id)
  const previousStage = Math.max(...previous.map((diagnostic) => STAGE_ORDER[diagnostic.stage] || 0))
  const currentStage = Math.max(...current.map((diagnostic) => STAGE_ORDER[diagnostic.stage] || 0))
  const stageAdvanced = currentStage > previousStage
  const progressed = resolvedIds.length > 0 || stageAdvanced || (newIds.length > 0 && unchangedIds.length < current.length)
  return {
    progressed,
    resolvedIds,
    newIds,
    unchangedIds,
    stageAdvanced,
    reason: resolvedIds.length > 0 ? 'resolved' : stageAdvanced ? 'stage_advanced' : newIds.length > 0 ? 'new_downstream' : 'unchanged'
  }
}

