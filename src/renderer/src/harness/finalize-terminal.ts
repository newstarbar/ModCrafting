import { runBuildViaPanel, startGameViaPanel, isPanelBridgeRegistered } from '../utils/panel-bridge.ts'
import { EventKind, type Event } from './events.ts'
import { normalizeWorkflowSteps } from './plan-normalizer.ts'
import type { PlanTracker } from './plan-tracker.ts'

export interface FinalizeTerminalOptions {
  planTracker: PlanTracker
  projectPath: string | null
  emit: (event: Event) => void
}

function emitPlanState(planTracker: PlanTracker, emit: (event: Event) => void): void {
  const workflowSteps = normalizeWorkflowSteps(planTracker.snapshot())
  emit({
    kind: EventKind.PlanState,
    planSteps: workflowSteps.map((step) => ({
      id: step.id,
      description: step.title,
      status: step.status === 'failed' ? 'error' : step.status
    }))
  })
}

function emitPlanStateWithError(planTracker: PlanTracker, failedStepId: string, emit: (event: Event) => void): void {
  const workflowSteps = normalizeWorkflowSteps(planTracker.snapshot())
  emit({
    kind: EventKind.PlanState,
    planSteps: workflowSteps.map((step) => ({
      id: step.id,
      description: step.title,
      status: step.id === failedStepId ? 'error' : (step.status === 'failed' ? 'error' : step.status)
    }))
  })
}

/** Host-driven build/run when the model did not finish terminal steps. */
export async function finalizeTerminalSteps(options: FinalizeTerminalOptions): Promise<void> {
  const { planTracker, projectPath, emit } = options
  if (!projectPath || !isPanelBridgeRegistered()) return

  while (true) {
    const cur = planTracker.currentStep
    if (!cur) break

    const wfStep = normalizeWorkflowSteps(planTracker.snapshot()).find((s) => s.id === cur.id)
    if (!wfStep || (wfStep.kind !== 'build' && wfStep.kind !== 'run')) break

    planTracker.markRunning()
    emitPlanState(planTracker, emit)

    if (wfStep.kind === 'build') {
      const res = await runBuildViaPanel()
      if (res.failed) {
        emitPlanStateWithError(planTracker, cur.id, emit)
        break
      }
      const advance = planTracker.advanceCurrent('host finalize build')
      if (!advance.ok) break
      emitPlanState(planTracker, emit)
      continue
    }

    const res = await startGameViaPanel()
    if (!res.ok) {
      emitPlanStateWithError(planTracker, cur.id, emit)
      break
    }
    const advance = planTracker.advanceCurrent('host finalize run')
    if (!advance.ok) break
    emitPlanState(planTracker, emit)
  }
}
