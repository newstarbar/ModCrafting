import type { GameAssertion } from './game-test-protocol.ts'

/**
 * A task-level, implementation-neutral definition of done.  The planner owns
 * the claims; the host only verifies that every claim has an executable oracle.
 */
export type AcceptanceOracle =
  | { type: 'build_success' }
  | { type: 'game_assertion'; assertion: GameAssertion }
  | { type: 'user_confirmation'; prompt: string; capture?: 'screenshot' }

export interface AcceptanceRequirement {
  id: string
  /** Exact or normalized excerpt from the user's current request. */
  sourceQuote: string
  claim: string
  oracle: AcceptanceOracle
}

export interface AcceptanceContract {
  version: 1
  requirements: AcceptanceRequirement[]
}

const PLACEHOLDER_RE = /<[^>]+>|\b(?:modid|item_id|block_id|entity_id|hotkey|widget_index)\b/i

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Structural validation only: no feature-, class-, renderer-, or API-specific rules belong here. */
export function validateAcceptanceContract(
  value: unknown,
  validateGameAssertion: (value: unknown) => { ok: boolean; error?: string }
): { ok: true; contract: AcceptanceContract } | { ok: false; error: string } {
  const raw = record(value)
  if (!raw || raw.version !== 1 || !Array.isArray(raw.requirements) || raw.requirements.length === 0) {
    return { ok: false, error: 'acceptanceContract must contain version=1 and at least one requirement.' }
  }
  const ids = new Set<string>()
  const requirements: AcceptanceRequirement[] = []
  for (let index = 0; index < raw.requirements.length; index++) {
    const item = record(raw.requirements[index])
    const path = `acceptanceContract.requirements[${index}]`
    if (!item || !text(item.id) || !text(item.sourceQuote) || !text(item.claim)) {
      return { ok: false, error: `${path} requires id, sourceQuote, and claim.` }
    }
    if (ids.has(item.id)) return { ok: false, error: `${path}.id "${item.id}" is duplicated.` }
    if (PLACEHOLDER_RE.test(`${item.sourceQuote}\n${item.claim}`)) return { ok: false, error: `${path} contains an unresolved placeholder.` }
    const oracle = record(item.oracle)
    if (!oracle || !text(oracle.type)) return { ok: false, error: `${path}.oracle is required.` }
    let normalized: AcceptanceOracle
    if (oracle.type === 'build_success') {
      normalized = { type: 'build_success' }
    } else if (oracle.type === 'game_assertion') {
      const result = validateGameAssertion(oracle.assertion)
      if (!result.ok) return { ok: false, error: `${path}.oracle.assertion: ${result.error || 'invalid game assertion.'}` }
      normalized = { type: 'game_assertion', assertion: oracle.assertion as GameAssertion }
    } else if (oracle.type === 'user_confirmation') {
      if (!text(oracle.prompt) || (oracle.capture !== undefined && oracle.capture !== 'screenshot')) {
        return { ok: false, error: `${path}.oracle user_confirmation requires prompt and optional capture="screenshot".` }
      }
      normalized = { type: 'user_confirmation', prompt: oracle.prompt.trim(), ...(oracle.capture === 'screenshot' ? { capture: 'screenshot' as const } : {}) }
    } else {
      return { ok: false, error: `${path}.oracle.type must be build_success, game_assertion, or user_confirmation.` }
    }
    ids.add(item.id)
    requirements.push({ id: item.id.trim(), sourceQuote: item.sourceQuote.trim(), claim: item.claim.trim(), oracle: normalized })
  }
  return { ok: true, contract: { version: 1, requirements } }
}

export function gameAssertionsForContract(contract: AcceptanceContract): GameAssertion[] {
  return contract.requirements.flatMap((requirement) =>
    requirement.oracle.type === 'game_assertion'
      ? [{ ...requirement.oracle.assertion, requirementId: requirement.id } as GameAssertion]
      : []
  )
}

/** Old V2 scenarios had assertions but no task contract. Preserve them as atomic legacy requirements. */
export function legacyAcceptanceContract(assertions: GameAssertion[], visualOnly = false): AcceptanceContract {
  const requirements: AcceptanceRequirement[] = assertions.map((assertion, index) => ({
    id: `legacy-game-${index + 1}`,
    sourceQuote: assertion.label || assertion.type,
    claim: assertion.label || `Legacy ${assertion.type} assertion`,
    oracle: { type: 'game_assertion', assertion }
  }))
  if (visualOnly) requirements.push({
    id: 'legacy-visual-confirmation',
    sourceQuote: 'visual-only legacy scenario',
    claim: 'Confirm the visual result in a fresh screenshot.',
    oracle: { type: 'user_confirmation', prompt: '请确认该截图中的纯视觉效果是否符合需求。', capture: 'screenshot' }
  })
  return { version: 1, requirements }
}
