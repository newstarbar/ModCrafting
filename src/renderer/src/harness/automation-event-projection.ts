import type { CollaborationTrace } from '../../../shared/model-routing.ts'

/** Test Lab projection of collaboration telemetry. It intentionally contains
 * model identity and lifecycle metadata, never provider credentials or hidden
 * reasoning. */
export function collaborationForAutomation(trace: CollaborationTrace) {
  return {
    id: trace.id,
    roleId: trace.roleId,
    providerId: trace.providerId,
    modelId: trace.modelId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    summary: trace.summary,
    fallbackFrom: trace.fallbackFrom
  }
}

const AUTOMATION_TEST_TOOLS = new Set(['submit_plan', 'mc_test_scenario', 'mc_run_test'])

/** Keep only non-secret structural arguments needed to audit Test Lab runs. */
export function toolArgsForAutomation(name: string, args: string | undefined): string | undefined {
  if (!AUTOMATION_TEST_TOOLS.has(name) || typeof args !== 'string') return undefined
  return args.slice(0, 64_000)
}

/** A compiled scenario/result contains objective game evidence but no provider
 * credentials. Retain it so the app-level runner can prove what actually ran. */
export function toolOutputForAutomation(name: string, output: string | undefined): string | undefined {
  if (name !== 'mc_test_scenario' && name !== 'mc_run_test') return undefined
  return typeof output === 'string' ? output.slice(0, 128_000) : undefined
}
