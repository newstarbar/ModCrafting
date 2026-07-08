import type { PlanStep } from '../components/TaskPlan'
import type { ComposerMode } from '../harness/turn-intent'

export type TurnStatus = 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'

export function resolveTurnStatusFromError(error?: string): TurnStatus {
  if (!error) return 'error'
  if (/cancel/i.test(error)) return 'cancelled'
  return 'error'
}

export function resolveTurnDoneStatus(options: {
  hasError: boolean
  error?: string
  finalSteps?: PlanStep[]
  composerMode: ComposerMode
  turnMode?: string
  phase?: string
}): TurnStatus {
  if (options.hasError) return resolveTurnStatusFromError(options.error)
  const finalPlanDone = options.finalSteps
    ? options.finalSteps.every((s) => s.status === 'completed')
    : false
  if (finalPlanDone) return 'completed'
  if (options.phase === 'plan_ready' || options.turnMode === 'plan_only') {
    return 'planned'
  }
  if (options.phase === 'plan_failed') return 'answered'
  if (options.finalSteps?.length) return 'partial'
  if (options.turnMode === 'chat' || options.composerMode === 'ask') return 'answered'
  return 'answered'
}
