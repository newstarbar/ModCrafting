import { legacyAcceptanceContract, validateAcceptanceContract, type AcceptanceContract } from './acceptance-contract.ts'
import {
  GAME_TEST_REGION as SHARED_GAME_TEST_REGION,
  GAME_TEST_WORLD as SHARED_GAME_TEST_WORLD,
} from '../../../../packages/modcrafting-core/src/domain.ts'

/**
 * Deterministic in-game test protocol.
 *
 * The LLM may propose a scenario, but the host owns its lifecycle and verdict.
 * This deliberately keeps test evidence structured instead of treating a screenshot
 * or a successful tool dispatch as a passing test.
 */

export type GameFeatureType =
  | 'new_item'
  | 'new_block'
  | 'new_recipe'
  | 'entity_behavior'
  | 'player_interaction'
  | 'hud_gui'

export type GameTestVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'
export type GameTestPhase = 'created' | 'preparing' | 'acting' | 'asserting' | 'cleaning' | 'finished'

/** Structured reasons for an INCONCLUSIVE game test. Keep this machine-readable
 * so workflow routing never depends on localized prose. */
export type GameTestInconclusiveCode =
  | 'SPEC_NO_ASSERTIONS'
  | 'SPEC_INVALID_ASSERTION'
  | 'SPEC_NO_ACTIONS'
  | 'SPEC_ACTION_FAILED'
  | 'ASSERTION_CAPABILITY_UNAVAILABLE'
  | 'OBSERVER_UNAVAILABLE'
  | 'WORLD_UNAVAILABLE'
  | 'SNAPSHOT_UNAVAILABLE'
  | 'VISUAL_REVIEW_REQUIRED'
  | 'REPEATED_INVALID_TEST_SPEC'
  | 'SPEC_MISSING_CHECKPOINT'
  | 'SPEC_INVALID_RELATION'
  | 'SPEC_RUNTIME_VARIABLE_INVALID'
  | 'LAYOUT_ORACLE_UNLINKED'
  | 'TRACE_CAPABILITY_UNAVAILABLE'
  | 'WORLD_TIME_NOT_ADVANCED'
  | 'INDEPENDENT_REPLAY_NOT_PROVEN'

export type GameTestResponsibility = 'agent_test_design' | 'environment' | 'visual_review'

export type GameTestWorkflowState = 'contract_check' | 'scenario_ready' | 'running' | 'evidence_repair' | 'environment_recovery' | 'visual_review' | 'replay_cleanup' | 'product_repair' | 'terminal'
export type GameTestWorkflowCode = GameTestInconclusiveCode | 'ASSERTION_FAILED' | 'REPLAY_REQUIRED'

export interface GameTestWorkflowStatus {
  state: GameTestWorkflowState
  code: GameTestWorkflowCode
  responsibility: GameTestResponsibility
  scenarioId: string
  scenarioRevision?: number
  scenarioFingerprint?: string
  acceptanceContractFingerprint?: string
  reviewId?: string
  reviewPrompt?: string
  reviewScreenshot?: { base64: string; mimeType: string; toolId: string; capturedAt: number }
  reviewDecision?: 'accepted' | 'rejected'
  repairAttempt?: number
  environmentAttempt?: number
  passCount?: number
  requiredPassCount?: number
  currentCheckpoint?: string
  observerSessionId?: string
  windowFingerprint?: string
  variantFingerprint?: string
  message: string
}

export interface GameActionMeta {
  label?: string
  /** A named checkpoint captured immediately after this action. */
  checkpoint?: string
}

export interface PlayerStatePatch {
  x: number
  y: number
  z: number
  health: number
  hunger: number
  saturation?: number
  inventory?: Array<{ slot: number; itemId: string; count: number }>
  selectedSlot?: number
}

export type GameAction =
  | ({ type: 'command'; command: string } & GameActionMeta)
  | ({ type: 'input'; action: string; args?: Record<string, unknown> } & GameActionMeta)
  | ({ type: 'wait'; ms: number } & GameActionMeta)
  | ({ type: 'wait_until'; condition: 'death_screen' | 'server_player_available' | 'screen_not_death'; timeoutMs: number; pollMs?: number } & GameActionMeta)
  | ({ type: 'set_player_state'; state: PlayerStatePatch } & GameActionMeta)
  | ({ type: 'kill_player' } & GameActionMeta)
  | ({ type: 'respawn' } & GameActionMeta)

/** Long enough to verify minute-scale gameplay history without allowing a
 * single declarative action to occupy the world-control tool indefinitely. */
export const MAX_GAME_TEST_WAIT_MS = 90_000

export type SnapshotSource = 'player' | 'serverPlayer' | 'screen' | 'entity' | 'renderTrace' | 'hudTrace' | 'combatTrace'

export type SnapshotRelationOperator = 'equals' | 'not_equals' | 'approximately' | 'ratio'

export interface GameTestVariableSpec {
  type: 'integer' | 'number' | 'token'
  min?: number
  max?: number
  step?: number
  values?: Array<string | number>
}

export interface SnapshotOperand {
  checkpoint: string
  source: SnapshotSource
  pointer: string
}

export interface GameCheckpointRecord {
  name: string
  actionIndex?: number
  observedAt: number
  monotonicAt?: number
  worldTime?: number
  snapshot?: Record<string, unknown>
  traceCursors?: Record<string, number>
}

export interface GameActionTimelineEntry {
  index: number
  type: GameAction['type']
  label?: string
  checkpoint?: string
  startedAt: number
  finishedAt: number
  elapsedMs: number
  beforeWorldTick?: number
  afterWorldTick?: number
  ok: boolean
  detail: string
}

export type GameAssertion = ({ requirementId?: string } & (
  | { type: 'command_result'; command: string; minResult?: number; label?: string }
  | { type: 'inventory_contains'; itemId: string; countAtLeast?: number; label?: string }
  | { type: 'main_hand'; itemId: string; label?: string }
  | { type: 'block_equals'; x: number; y: number; z: number; blockId: string; label?: string }
  | { type: 'entity_exists'; entityType?: string; tag?: string; exists?: boolean; label?: string }
  | { type: 'screen_matches'; screenName: string; checkpoint?: string; label?: string }
  | { type: 'widget_state'; label: string; enabled?: boolean; labelText?: string }
  | { type: 'player_state'; path: string; equals: unknown; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'recipe_exists'; recipeId: string; label?: string }
  | { type: 'state_changed'; path: string; from?: unknown; to?: unknown; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'snapshot_value'; source: SnapshotSource; pointer: string; equals: unknown; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'snapshot_changed'; source: SnapshotSource; pointer: string; from?: unknown; to?: unknown; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'snapshot_unchanged'; source: SnapshotSource; pointer: string; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'snapshot_relation'; source?: SnapshotSource; pointer?: string; leftCheckpoint?: string; rightCheckpoint?: string; left?: SnapshotOperand; right?: SnapshotOperand; operator: SnapshotRelationOperator; expected?: unknown; tolerance?: number; ratio?: number; normalizer?: 'inventory_v1' | 'player_state_v1'; label?: string }
  | { type: 'elapsed_between'; fromCheckpoint: string; toCheckpoint: string; minMs?: number; maxMs?: number; minWorldTicks?: number; maxWorldTicks?: number; label?: string }
  | { type: 'combat_event'; checkpoint?: string; sinceCheckpoint?: string; victimUuid?: string; victimType?: string; victimName?: string; victimTag?: string; attackerUuid?: string; attackerCheckpoint?: string; attackerIsPlayer?: boolean; damageType?: string; killed?: boolean; exists?: boolean; label?: string }
  | { type: 'render_trace'; entityUuid?: string; entityType?: string; rendererClass?: string; modelClass?: string; textureId?: string; checkpoint?: string; afterAction?: number; label?: string }
  | { type: 'hud_text'; text: string; match?: 'exact' | 'contains'; exists?: boolean; position?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number }; normalizedPosition?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number }; maxAgeMs?: number; sinceCheckpoint?: string; checkpoint?: string; token?: string; color?: number; alphaMin?: number; shadow?: boolean; approvedLayoutElementId?: string; requireAttackerVictimSemantics?: boolean; attackerCheckpoint?: string; afterAction?: number; label?: string }
))

export interface GameTestSpec {
  version: 2
  id: string
  featureType: GameFeatureType
  subject: {
    modId?: string
    id?: string
    hotkey?: string
  }
  setup: GameAction[]
  actions: GameAction[]
  assertions: GameAssertion[]
  cleanup: GameAction[]
  /** A visual-only claim cannot become PASS without user confirmation. */
  visualOnly?: boolean
  acceptanceContract?: AcceptanceContract
  scenarioRevision?: number
  scenarioFingerprint?: string
  /** Separate contract identity for auditability; scenarioFingerprint also
   * includes this value but callers need not reverse-engineer it. */
  acceptanceContractFingerprint?: string
  baselineCheckpoint?: string
  checkpoints?: string[]
  variables?: Record<string, GameTestVariableSpec>
  approvedLayoutId?: string
  approvedLayoutFingerprint?: string
  approvedLayoutRecord?: ApprovedLayoutRecord
  /** Optional host-owned replay requirement (for example, a full pass after
   * restarting Minecraft). Defaults to one independent PASS. */
  requiredPassCount?: number
  visualReviewDecision?: 'accepted' | 'rejected'
  visualReviewEvidence?: {
    decision: 'accepted' | 'rejected'
    prompt: string
    screenshotToolId?: string
    capturedAt?: number
    reviewedAt: number
  }
  /** Host-owned durable recovery/replay state.  It is intentionally excluded
   * from scenario fingerprints so restoring a session never creates a new
   * scenario identity or resets bounded repair counters. */
  runtimeState?: GameTestRuntimeState
  supersededScenarioIds?: string[]
  createdAt: number
}

export interface GameTestReplayIdentity {
  observerSessionId?: string
  variantFingerprint?: string
  minecraftProcessId?: string
  windowFingerprint?: string
  scenarioRevision?: number
  scenarioFingerprint?: string
  acceptanceContractFingerprint?: string
  recordedAt: number
}

export interface GameTestRuntimeState {
  evidenceRepairAttempts: number
  environmentRecoveryAttempts: number
  failureCounts: Record<string, number>
  failureReplay?: { values: Record<string, string | number>; purpose: 'first_failure_replay' | 'product_diagnostic' }
  successfulVariantFingerprints: string[]
  formalReplayHistory: GameTestReplayIdentity[]
  terminalCode?: GameTestInconclusiveCode
}

export interface GameTestEvidence {
  assertion: GameAssertion
  passed: boolean
  observedAt: number
  detail: string
  data?: Record<string, unknown>
  /** The bridge explicitly lacks this observation, which is not a product failure. */
  unavailable?: boolean
}

export interface GameTestSession {
  id: string
  scenarioId: string
  phase: GameTestPhase
  startedAt: number
  finishedAt?: number
  verdict?: GameTestVerdict
  evidence: GameTestEvidence[]
  reason?: string
  replay: number
  inconclusiveCode?: GameTestInconclusiveCode
  responsibility?: GameTestResponsibility
  scenarioRevision?: number
  scenarioFingerprint?: string
  acceptanceContractFingerprint?: string
  requiredPassCount?: number
  supersededScenarioIds?: string[]
  resolvedVariables?: Record<string, string | number>
  variantFingerprint?: string
  /** A deterministic replay purpose is persisted so a product-repair
   * diagnostic PASS can never be counted as a formal stage PASS. */
  replayPurpose?: 'first_failure_replay' | 'product_diagnostic'
  diagnosticReplay?: boolean
  observerSessionId?: string
  windowFingerprint?: string
  checkpoints?: Record<string, GameCheckpointRecord>
  actionTimeline?: GameActionTimelineEntry[]
  monotonicStartedAt?: number
  monotonicFinishedAt?: number
  failureSignature?: string
  runtimeState?: GameTestRuntimeState
}

export interface ApprovedLayoutRecord {
  approvalId: string
  layoutFingerprint: string
  layoutType?: string
  canvasWidth?: number
  canvasHeight?: number
  elements: Array<{
    id: string
    x: number
    y: number
    width: number
    height: number
    color?: number
    alpha?: number
    shadow?: boolean
  }>
  approvedAt: number
}

export function stateTransitionMatches(assertion: Extract<GameAssertion, { type: 'state_changed' | 'snapshot_changed' }>, before: unknown, after: unknown): boolean {
  const fromMatches = assertion.from === undefined || JSON.stringify(before) === JSON.stringify(assertion.from)
  const toMatches = assertion.to === undefined
    ? JSON.stringify(before) !== JSON.stringify(after)
    : JSON.stringify(after) === JSON.stringify(assertion.to)
  return fromMatches && toMatches
}

const sessions = new Map<string, GameTestSpec>()
const approvedLayouts = new Map<string, ApprovedLayoutRecord>()
let sequence = 0

/** Recompute the layout oracle fingerprint on the host.  The UI may send a
 * convenience fingerprint, but it is never trusted as the approval record's
 * identity.  Defaults mirror GuiLayoutPreviewPanel so a missing optional style
 * cannot produce a different identity on different clients. */
export function computeApprovedLayoutFingerprint(value: { layoutType?: unknown; canvasWidth?: unknown; canvasHeight?: unknown; elements?: unknown }): string {
  const layoutType = String(value.layoutType || 'custom-screen')
  const canvasWidth = numberValue(value.canvasWidth) && Number(value.canvasWidth) > 0 ? Number(value.canvasWidth) : 1280
  const canvasHeight = numberValue(value.canvasHeight) && Number(value.canvasHeight) > 0 ? Number(value.canvasHeight) : 720
  const elements = Array.isArray(value.elements) ? value.elements.map((entry, index) => {
    const item = record(entry) || {}
    return {
      id: String(item.id || `el-${index}`),
      type: String(item.type || 'custom'),
      label: String(item.label || ''),
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      width: Number(item.width) || 100,
      height: Number(item.height) || 20,
      color: numberValue(item.color) ? Number(item.color) : 0xffffffff,
      alpha: numberValue(item.alpha) ? Number(item.alpha) : 255,
      shadow: typeof item.shadow === 'boolean' ? item.shadow : true
    }
  }) : []
  const canonical = JSON.stringify({ layoutType, canvasWidth, canvasHeight, elements })
  let hash = 2166136261
  for (const char of canonical) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function registerApprovedLayoutRecord(value: unknown): { ok: true; record: ApprovedLayoutRecord } | { ok: false; error: string } {
  const raw = record(value)
  if (!raw || !nonEmptyString(raw.approvalId) || !nonEmptyString(raw.layoutFingerprint) || !Array.isArray(raw.elements)) return { ok: false, error: 'approved layout record is incomplete.' }
  const elements = raw.elements.map((entry) => {
    const item = record(entry) || {}
    return {
      id: String(item.id || ''), x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height),
      ...(numberValue(item.color) ? { color: Number(item.color) } : {}),
      ...(numberValue(item.alpha) ? { alpha: Number(item.alpha) } : {}),
      ...(typeof item.shadow === 'boolean' ? { shadow: item.shadow } : {})
    }
  })
  if (elements.some((item) => !item.id || ![item.x, item.y, item.width, item.height].every(Number.isFinite))) return { ok: false, error: 'approved layout element is invalid.' }
  const approvedAt = numberValue(raw.approvedAt) ? Number(raw.approvedAt) : Date.now()
  // GUI previews use a fixed 1280x720 logical canvas. Persist both the
  // logical dimensions and normalized coordinates so a replay at another
  // Minecraft window size cannot accidentally pass on fixed pixels.
  const canvasWidth = numberValue(raw.canvasWidth) && Number(raw.canvasWidth) > 0 ? Number(raw.canvasWidth) : 1280
  const canvasHeight = numberValue(raw.canvasHeight) && Number(raw.canvasHeight) > 0 ? Number(raw.canvasHeight) : 720
  // Records emitted by the controller use logical pixels, while persisted
  // GameTestSpec records may already contain normalized coordinates.  Do not
  // normalize a second time: that would make a valid approved layout drift
  // toward the origin after session restore.
  const alreadyNormalized = Boolean(raw.canvasWidth && raw.canvasHeight) && elements.every((element) =>
    element.x >= 0 && element.x <= 1 && element.y >= 0 && element.y <= 1 &&
    element.width >= 0 && element.width <= 1 && element.height >= 0 && element.height <= 1
  )
  const normalizedElements = alreadyNormalized
    ? elements
    : elements.map((element) => ({
        ...element,
        x: element.x / canvasWidth,
        y: element.y / canvasHeight,
        width: element.width / canvasWidth,
        height: element.height / canvasHeight
      }))
  const result: ApprovedLayoutRecord = { approvalId: raw.approvalId, layoutFingerprint: raw.layoutFingerprint, ...(nonEmptyString(raw.layoutType) ? { layoutType: raw.layoutType } : {}), canvasWidth, canvasHeight, elements: normalizedElements, approvedAt }
  const previous = approvedLayouts.get(result.approvalId)
  if (previous) {
    const comparable = (recordValue: ApprovedLayoutRecord) => JSON.stringify({
      approvalId: recordValue.approvalId,
      layoutFingerprint: recordValue.layoutFingerprint,
      layoutType: recordValue.layoutType,
      canvasWidth: recordValue.canvasWidth,
      canvasHeight: recordValue.canvasHeight,
      elements: recordValue.elements
    })
    if (comparable(previous) !== comparable(result)) {
      return { ok: false, error: 'approved layout record is immutable and cannot be replaced for the same approvalId.' }
    }
    return { ok: true, record: previous }
  }
  approvedLayouts.set(result.approvalId, result)
  return { ok: true, record: result }
}

export function getApprovedLayoutRecord(approvalId: string, fingerprint?: string): ApprovedLayoutRecord | undefined {
  const record = approvedLayouts.get(approvalId)
  return record && (!fingerprint || record.layoutFingerprint === fingerprint) ? record : undefined
}

const PLACEHOLDER_RE = /<[^>]+>|\b(?:modid|item_id|block_id|entity_id|hotkey|widget_index)\b/i

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableFingerprintValue(child)]))
  }
  return value
}

export const GAME_TEST_WORLD = SHARED_GAME_TEST_WORLD
export const GAME_TEST_REGION = SHARED_GAME_TEST_REGION

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`
}

/** A stable identity for a scenario's executable contract. Runtime IDs and
 * timestamps are deliberately excluded so repeated invalid submissions can be
 * detected across fresh test-session IDs. */
export function gameTestScenarioFingerprint(spec: Pick<GameTestSpec, 'featureType' | 'subject' | 'setup' | 'actions' | 'assertions' | 'cleanup' | 'visualOnly' | 'acceptanceContract' | 'requiredPassCount' | 'baselineCheckpoint' | 'checkpoints' | 'variables' | 'approvedLayoutId' | 'approvedLayoutFingerprint'>): string {
  return JSON.stringify(stableFingerprintValue({
    featureType: spec.featureType,
    subject: spec.subject,
    setup: spec.setup,
    actions: spec.actions,
    assertions: spec.assertions,
    cleanup: spec.cleanup,
    visualOnly: Boolean(spec.visualOnly),
    acceptanceContract: spec.acceptanceContract,
    requiredPassCount: Math.max(1, Number(spec.requiredPassCount || 1)),
    baselineCheckpoint: spec.baselineCheckpoint,
    checkpoints: spec.checkpoints,
    variables: spec.variables,
    approvedLayoutId: spec.approvedLayoutId,
    approvedLayoutFingerprint: spec.approvedLayoutFingerprint
  }))
}

export function gameTestVariantFingerprint(values: Record<string, string | number>, _observerSessionId?: string): string {
  // Runtime identity is deliberately excluded.  This fingerprint proves that
  // two replays used different resolved inputs; observerSessionId is audited
  // separately as a process/JVM independence signal.
  return JSON.stringify(stableFingerprintValue({ values }))
}

/** Stable identity for the acceptance contract independent of scenario IDs or
 * timestamps. Persisting it separately makes supersession and audit reports
 * explicit instead of requiring consumers to decode the scenario fingerprint. */
export function acceptanceContractFingerprint(contract: AcceptanceContract | undefined): string | undefined {
  return contract ? JSON.stringify(stableFingerprintValue(contract)) : undefined
}

export function supersedeGameTestSpec(previousScenarioId: string, replacementScenarioId: string): void {
  if (!previousScenarioId || previousScenarioId === replacementScenarioId) return
  const previous = sessions.get(previousScenarioId)
  const replacement = sessions.get(replacementScenarioId)
  if (!previous || !replacement) return
  replacement.scenarioRevision = Math.max(
    Number(replacement.scenarioRevision || 1),
    Number(previous.scenarioRevision || 1) + 1
  )
  replacement.supersededScenarioIds = [...new Set([...(replacement.supersededScenarioIds || []), previousScenarioId])]
  previous.supersededScenarioIds = [...new Set([...(previous.supersededScenarioIds || []), replacementScenarioId])]
  sessions.set(previousScenarioId, previous)
  sessions.set(replacementScenarioId, replacement)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function featureType(value: unknown): GameFeatureType | null {
  const candidate = String(value || '') as GameFeatureType
  return ['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui'].includes(candidate)
    ? candidate
    : null
}

function defaultSetup(): GameAction[] {
  return [
    { type: 'command', command: 'gamemode creative @s', label: '切换创造模式' },
    { type: 'command', command: 'weather clear', label: '清除天气' },
    { type: 'command', command: 'time set day', label: '固定时间' },
    { type: 'command', command: 'tp @s 0.5 100 0.5 0 0', label: '传送到测试原点' },
    { type: 'command', command: 'clear @s', label: '清理背包' },
    { type: 'command', command: 'effect clear @s', label: '清理状态效果' },
    { type: 'command', command: 'kill @e[tag=modcrafting_test]', label: '清理测试实体' },
    { type: 'command', command: 'fill -16 96 -16 16 112 16 air', label: '清理测试区域' },
    { type: 'command', command: 'fill -16 99 -16 16 99 16 stone', label: '创建测试平台' }
  ]
}

function defaultCleanup(): GameAction[] {
  return [
    { type: 'command', command: 'kill @e[tag=modcrafting_test]', label: '清理测试实体' },
    { type: 'command', command: 'clear @s', label: '清理测试物品' }
  ]
}

const ASSERTION_TYPES = new Set<GameAssertion['type']>([
  'command_result', 'inventory_contains', 'main_hand', 'block_equals', 'entity_exists',
  'screen_matches', 'widget_state', 'player_state', 'recipe_exists', 'state_changed',
  'snapshot_value', 'snapshot_changed', 'snapshot_unchanged', 'snapshot_relation',
  'elapsed_between', 'combat_event', 'render_trace', 'hud_text'
])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function numberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function numericOrVariable(value: unknown): boolean {
  return numberValue(value) || (typeof value === 'string' && /^\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}$/.test(value))
}

function requiredPassCountValue(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) return undefined
  return Number(value)
}

function normalizeRuntimeState(value: unknown): GameTestRuntimeState | undefined {
  const raw = record(value)
  if (!raw) return undefined
  const failureCounts = record(raw.failureCounts)
  const failureReplay = record(raw.failureReplay)
  const replayValues = record(failureReplay?.values)
  const purpose = failureReplay?.purpose === 'product_diagnostic' || failureReplay?.purpose === 'first_failure_replay'
    ? failureReplay.purpose
    : undefined
  const replayHistory = Array.isArray(raw.formalReplayHistory)
    ? raw.formalReplayHistory.map((entry) => {
        const item = record(entry) || {}
        return {
          ...(nonEmptyString(item.observerSessionId) ? { observerSessionId: item.observerSessionId } : {}),
          ...(nonEmptyString(item.variantFingerprint) ? { variantFingerprint: item.variantFingerprint } : {}),
          ...(nonEmptyString(item.minecraftProcessId) ? { minecraftProcessId: item.minecraftProcessId } : {}),
          ...(nonEmptyString(item.windowFingerprint) ? { windowFingerprint: item.windowFingerprint } : {}),
          ...(Number.isInteger(item.scenarioRevision) ? { scenarioRevision: Number(item.scenarioRevision) } : {}),
          ...(nonEmptyString(item.scenarioFingerprint) ? { scenarioFingerprint: item.scenarioFingerprint } : {}),
          ...(nonEmptyString(item.acceptanceContractFingerprint) ? { acceptanceContractFingerprint: item.acceptanceContractFingerprint } : {}),
          recordedAt: numberValue(item.recordedAt) ? Number(item.recordedAt) : Date.now()
        }
      })
    : []
  return {
    evidenceRepairAttempts: Math.max(0, Math.min(3, Number(raw.evidenceRepairAttempts || 0))),
    environmentRecoveryAttempts: Math.max(0, Math.min(2, Number(raw.environmentRecoveryAttempts || 0))),
    failureCounts: Object.fromEntries(Object.entries(failureCounts || {}).filter(([key, count]) => nonEmptyString(key) && Number.isFinite(Number(count))).map(([key, count]) => [key, Math.max(0, Math.min(3, Number(count)))])),
    ...(purpose && replayValues ? { failureReplay: { values: Object.fromEntries(Object.entries(replayValues).filter(([, item]) => typeof item === 'string' || typeof item === 'number')) as Record<string, string | number>, purpose } } : {}),
    successfulVariantFingerprints: Array.isArray(raw.successfulVariantFingerprints) ? raw.successfulVariantFingerprints.filter(nonEmptyString).slice(0, 16) : [],
    formalReplayHistory: replayHistory.slice(0, 16),
    ...(raw.terminalCode && typeof raw.terminalCode === 'string' ? { terminalCode: raw.terminalCode as GameTestInconclusiveCode } : {})
  }
}

function checkpointName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)
}

function validateCheckpointRef(item: Record<string, unknown>, name: string): boolean {
  return item[name] === undefined || checkpointName(item[name])
}

function validateNormalizedPosition(value: unknown): boolean {
  const position = record(value)
  return position !== null && Object.entries(position).every(([key, child]) =>
    ['xMin', 'xMax', 'yMin', 'yMax'].includes(key) && numberValue(child) && Number(child) >= 0 && Number(child) <= 1
  )
}

function validateSnapshotOperand(value: unknown): value is SnapshotOperand {
  const operand = record(value)
  return Boolean(operand && checkpointName(operand.checkpoint) && nonEmptyString(operand.source) &&
    ['player', 'serverPlayer', 'screen', 'entity', 'renderTrace', 'hudTrace', 'combatTrace'].includes(String(operand.source)) &&
    nonEmptyString(operand.pointer) && String(operand.pointer).startsWith('/'))
}

/** Shared runtime validation for both native tool schemas and restored sessions. */
export function validateGameAssertions(value: unknown): { ok: true; assertions: GameAssertion[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'assertions must contain at least one objective assertion.' }
  const assertions: GameAssertion[] = []
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index])
    const path = `assertions[${index}]`
    if (!item) return { ok: false, error: `${path} must be an object.` }
    if ('kind' in item && !('type' in item)) return { ok: false, error: `${path}.kind is unsupported; use type.` }
    const type = item.type
    if (!nonEmptyString(type) || !ASSERTION_TYPES.has(type as GameAssertion['type'])) return { ok: false, error: `${path}.type is invalid; allowed: ${[...ASSERTION_TYPES].join(', ')}.` }
    const str = (name: string) => nonEmptyString(item[name])
    const num = (name: string) => numberValue(item[name])
    let valid = false
    switch (type) {
      case 'command_result': valid = str('command') && (item.minResult === undefined || num('minResult')); break
      case 'inventory_contains': valid = str('itemId') && (item.countAtLeast === undefined || num('countAtLeast')); break
      case 'main_hand': valid = str('itemId'); break
      case 'block_equals': valid = num('x') && num('y') && num('z') && str('blockId'); break
      case 'entity_exists': valid = (item.entityType === undefined || str('entityType')) && (item.tag === undefined || str('tag')) && (item.exists === undefined || typeof item.exists === 'boolean') && (str('entityType') || str('tag')); break
      case 'screen_matches': valid = str('screenName') && validateCheckpointRef(item, 'checkpoint'); break
      case 'widget_state': valid = str('label') && (item.enabled === undefined || typeof item.enabled === 'boolean') && (item.labelText === undefined || str('labelText')); break
      case 'player_state': valid = str('path') && Object.prototype.hasOwnProperty.call(item, 'equals') && validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'recipe_exists': valid = str('recipeId'); break
      case 'state_changed': valid = str('path') && validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_value': valid = str('source') && str('pointer') && String(item.pointer).startsWith('/') && Object.prototype.hasOwnProperty.call(item, 'equals') &&
        validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_changed': valid = str('source') && str('pointer') && String(item.pointer).startsWith('/') &&
        validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_unchanged': valid = str('source') && str('pointer') && String(item.pointer).startsWith('/') &&
        validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_relation': {
        const modern = validateSnapshotOperand(item.left) && validateSnapshotOperand(item.right)
        const legacy = str('source') && str('pointer') && String(item.pointer).startsWith('/') && checkpointName(item.leftCheckpoint) && checkpointName(item.rightCheckpoint)
        valid = (modern || legacy) &&
        ['equals', 'not_equals', 'approximately', 'ratio'].includes(String(item.operator)) &&
        (item.tolerance === undefined || (numberValue(item.tolerance) && item.tolerance >= 0)) &&
        (item.normalizer === undefined || item.normalizer === 'inventory_v1' || item.normalizer === 'player_state_v1') &&
        (item.operator !== 'ratio' || numberValue(item.ratio) || numberValue(item.expected)); break
      }
      case 'elapsed_between': valid = checkpointName(item.fromCheckpoint) && checkpointName(item.toCheckpoint) &&
        (item.minMs === undefined || (numberValue(item.minMs) && item.minMs >= 0)) &&
        (item.maxMs === undefined || (numberValue(item.maxMs) && item.maxMs >= 0)) &&
        (item.minWorldTicks === undefined || (numberValue(item.minWorldTicks) && item.minWorldTicks >= 0)) &&
        (item.maxWorldTicks === undefined || (numberValue(item.maxWorldTicks) && item.maxWorldTicks >= 0)) &&
        (item.minMs !== undefined || item.maxMs !== undefined || item.minWorldTicks !== undefined || item.maxWorldTicks !== undefined); break
      case 'combat_event': valid = (item.victimUuid === undefined || str('victimUuid')) &&
        (item.victimType === undefined || str('victimType')) && (item.victimName === undefined || str('victimName')) &&
        (item.victimTag === undefined || str('victimTag')) && (item.attackerUuid === undefined || str('attackerUuid')) &&
        (item.attackerCheckpoint === undefined || checkpointName(item.attackerCheckpoint)) &&
        (item.attackerIsPlayer === undefined || typeof item.attackerIsPlayer === 'boolean') &&
        (item.damageType === undefined || str('damageType')) && (item.killed === undefined || typeof item.killed === 'boolean') &&
        (item.exists === undefined || typeof item.exists === 'boolean') && validateCheckpointRef(item, 'checkpoint') &&
        (item.sinceCheckpoint === undefined || checkpointName(item.sinceCheckpoint)) &&
        Boolean(item.victimUuid || item.victimType || item.victimName || item.victimTag || item.attackerUuid || item.attackerCheckpoint || item.damageType || item.killed !== undefined) &&
        (item.attackerIsPlayer !== true || str('attackerUuid') || str('attackerCheckpoint')); break
      case 'render_trace': valid = (str('entityUuid') || str('entityType') || str('rendererClass') || str('modelClass') || str('textureId')) &&
        validateCheckpointRef(item, 'checkpoint') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'hud_text': valid = str('text') && (item.match === undefined || item.match === 'exact' || item.match === 'contains') &&
        (item.exists === undefined || typeof item.exists === 'boolean') &&
        (item.maxAgeMs === undefined || (numberValue(item.maxAgeMs) && item.maxAgeMs >= 0)) &&
        (item.position === undefined || (record(item.position) !== null && Object.entries(record(item.position) || {}).every(([key, value]) => ['xMin', 'xMax', 'yMin', 'yMax'].includes(key) && numberValue(value)))) &&
        (item.normalizedPosition === undefined || validateNormalizedPosition(item.normalizedPosition)) &&
        (item.color === undefined || Number.isInteger(item.color)) && (item.alphaMin === undefined || (numberValue(item.alphaMin) && item.alphaMin >= 0 && item.alphaMin <= 255)) &&
         (item.approvedLayoutElementId === undefined || str('approvedLayoutElementId')) &&
         (item.shadow === undefined || typeof item.shadow === 'boolean') &&
        (item.requireAttackerVictimSemantics === undefined || typeof item.requireAttackerVictimSemantics === 'boolean') &&
        (item.attackerCheckpoint === undefined || checkpointName(item.attackerCheckpoint)) &&
        (item.requireAttackerVictimSemantics !== true || (str('attackerCheckpoint') && str('token'))) &&
        (item.sinceCheckpoint === undefined || checkpointName(item.sinceCheckpoint)) && validateCheckpointRef(item, 'checkpoint') &&
        (item.exists !== false || item.maxAgeMs !== undefined || item.sinceCheckpoint !== undefined) &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
    }
    if (!valid) return { ok: false, error: `${path} has incomplete or invalid ${type} fields.` }
    if (PLACEHOLDER_RE.test(JSON.stringify(item))) return { ok: false, error: `${path} contains an unresolved placeholder.` }
    assertions.push(item as GameAssertion)
  }
  return { ok: true, assertions }
}

function validateObserverCapabilities(assertions: GameAssertion[]): { ok: true } | { ok: false; error: string } {
  const supportedFields: Record<string, Set<string>> = {
    player: new Set([
      'ok', 'name', 'uuid', 'x', 'y', 'z', 'yaw', 'pitch', 'health', 'maxHealth',
      'entityType', 'width', 'height', 'eyeHeight', 'movementSpeed', 'scoreboardTags',
      'food', 'hunger', 'saturation', 'air', 'experienceLevel', 'inventory', 'dimension'
    ]),
    serverPlayer: new Set(['available', 'uuid', 'name', 'x', 'y', 'z', 'yaw', 'pitch', 'health', 'maxHealth', 'hunger', 'saturation', 'selectedSlot', 'inventory', 'width', 'height', 'eyeHeight', 'dimension', 'worldTick']),
    screen: new Set(['ok', 'inWorld', 'className', 'simpleName', 'title', 'kind', 'pausesGame', 'scaledWidth', 'scaledHeight', 'windowWidth', 'windowHeight', 'widgets']),
    entity: new Set(['type', 'name', 'uuid', 'tags', 'x', 'y', 'z', 'distance', 'health', 'maxHealth']),
    renderTrace: new Set(['sequence', 'entityUuid', 'entityType', 'rendererClass', 'modelClass', 'textureId', 'worldTick', 'observedAt']),
    hudTrace: new Set(['sequence', 'text', 'x', 'y', 'normalizedX', 'normalizedY', 'rightMargin', 'textWidth', 'screenWidth', 'screenHeight', 'color', 'alpha', 'shadow', 'worldTick', 'observedAt']),
    combatTrace: new Set(['sequence', 'victimUuid', 'victimType', 'victimName', 'victimTags', 'attackerUuid', 'attackerType', 'attackerIsPlayer', 'damageType', 'killed', 'worldTick', 'observedAt'])
  }
  const validatePointer = (index: number, source: string, pointer: string): string | undefined => {
    const fields = supportedFields[source]
    if (!fields || !pointer.startsWith('/')) return undefined
    const first = pointer.slice(1).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~')
    // entity snapshots are arrays; allow a numeric entity index followed by a
    // concrete field while still rejecting arbitrary unsupported fields.
    const field = /^\d+$/.test(first) ? pointer.slice(1).split('/')[1] : first
    if (!field || /^\d+$/.test(first) && !fields.has(field)) {
      return `assertions[${index}] uses unsupported ${source} field "${field || first}"; Observer V2 exposes: ${[...fields].join(', ')}.`
    }
    if (!/^\d+$/.test(first) && !fields.has(field)) {
      return `assertions[${index}] uses unsupported ${source} field "${field}"; Observer V2 exposes: ${[...fields].join(', ')}.`
    }
    return undefined
  }
  for (const [index, assertion] of assertions.entries()) {
    if (assertion.type === 'render_trace' && (assertion.modelClass || assertion.textureId)) {
      return {
        ok: false,
        error: `assertions[${index}] uses render_trace fields not exposed by Observer V2 capabilities (modelClass/textureId); use entityType, rendererClass, entityUuid, or a player snapshot pointer.`
      }
    }
    if (['snapshot_value', 'snapshot_changed', 'snapshot_unchanged'].includes(assertion.type) && !['player', 'serverPlayer', 'screen', 'entity', 'renderTrace', 'hudTrace', 'combatTrace'].includes(assertion.source)) {
      return { ok: false, error: `assertions[${index}].source is not available in Observer V2 capabilities.` }
    }
    if (assertion.type === 'snapshot_value' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_unchanged') {
      const error = validatePointer(index, assertion.source, assertion.pointer)
      if (error) return { ok: false, error }
    }
    if (assertion.type === 'snapshot_relation') {
      const operands = assertion.left && assertion.right
        ? [assertion.left, assertion.right]
        : [{ checkpoint: assertion.leftCheckpoint, source: assertion.source, pointer: assertion.pointer }, { checkpoint: assertion.rightCheckpoint, source: assertion.source, pointer: assertion.pointer }]
      for (const operand of operands) {
        if (!operand || !nonEmptyString(operand.source) || !nonEmptyString(operand.pointer)) return { ok: false, error: `assertions[${index}] relation operand is incomplete.` }
        const error = validatePointer(index, operand.source, operand.pointer)
        if (error) return { ok: false, error }
      }
    }
    if (assertion.type === 'combat_event' && !supportedFields.combatTrace.has('victimUuid')) {
      return { ok: false, error: `assertions[${index}] requires combatTrace capabilities.` }
    }
    if (assertion.type === 'player_state' && assertion.path.includes('.')) {
      const field = assertion.path.split('.')[0]
      if (!supportedFields.player.has(field)) {
        return { ok: false, error: `assertions[${index}] uses unsupported player field "${field}"; Observer V2 exposes: ${[...supportedFields.player].join(', ')}.` }
      }
    }
  }
  return { ok: true }
}

function assertionComparable(value: GameAssertion): string {
  const copy = { ...(value as Record<string, unknown>) }
  delete copy.requirementId
  return JSON.stringify(copy)
}

function validateContractCoverage(contract: AcceptanceContract | undefined, assertions: GameAssertion[]): { ok: true } | { ok: false; error: string } {
	if (!contract) return { ok: true }
	const requirementIds = new Set(contract.requirements.map((requirement) => requirement.id))
	for (const [index, assertion] of assertions.entries()) {
		if (assertion.requirementId && !requirementIds.has(assertion.requirementId)) {
			return { ok: false, error: `assertions[${index}].requirementId "${assertion.requirementId}" is not present in acceptanceContract.requirements.` }
		}
	}
	const available = assertions.map(assertionComparable)
  for (const requirement of contract.requirements) {
    if (requirement.oracle.type !== 'game_assertion') continue
    const expected = assertionComparable(requirement.oracle.assertion)
    if (!available.includes(expected)) {
      return { ok: false, error: `acceptanceContract requirement "${requirement.id}" has no matching GameTestSpec assertion.` }
    }
  }
  return { ok: true }
}

function validateActions(value: unknown, path: string): { ok: true; actions: GameAction[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, actions: [] }
  if (!Array.isArray(value)) return { ok: false, error: `${path} must be an action array.` }
  const actions: GameAction[] = []
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index])
    const itemPath = `${path}[${index}]`
    if (!item || !nonEmptyString(item.type)) return { ok: false, error: `${itemPath}.type must be command, input, wait, wait_until, set_player_state, kill_player, or respawn.` }
    const meta = {
      ...(nonEmptyString(item.label) ? { label: item.label } : {}),
      ...(checkpointName(item.checkpoint) ? { checkpoint: item.checkpoint } : {})
    }
    if (item.checkpoint !== undefined && !checkpointName(item.checkpoint)) return { ok: false, error: `${itemPath}.checkpoint must be an identifier.` }
    if (item.type === 'command' && nonEmptyString(item.command)) actions.push({ type: 'command', command: item.command, ...meta })
    else if (item.type === 'input' && nonEmptyString(item.action)) {
      const action = item.action === 'key' ? 'key_press' : item.action
      const allowed = new Set(['click_at', 'click_widget', 'set_text', 'key_press', 'key_down', 'key_up', 'mouse_click', 'mouse_move', 'scroll', 'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'use', 'attack', 'inventory', 'drop', 'swap_hands'])
      if (!allowed.has(action)) return { ok: false, error: `${itemPath}.action is unsupported; use a concrete mc_input action such as key_press.` }
      const actionArgs = record(item.args) || {}
      if ((action === 'key_press' || action === 'key_down' || action === 'key_up') && !nonEmptyString(actionArgs.key)) {
        return { ok: false, error: `${itemPath}.args.key is required for ${action}.` }
      }
      actions.push({ type: 'input', action, ...(Object.keys(actionArgs).length ? { args: actionArgs } : {}), ...meta })
    }
    else if (item.type === 'wait' && numericOrVariable(item.ms) && (typeof item.ms === 'string' || item.ms <= MAX_GAME_TEST_WAIT_MS)) actions.push({ type: 'wait', ms: item.ms as number, ...meta })
    else if (item.type === 'wait' && numberValue(item.ms)) return { ok: false, error: `${itemPath}.ms must be <= ${MAX_GAME_TEST_WAIT_MS}.` }
    else if (item.type === 'wait_until') {
      const allowed = new Set(['death_screen', 'server_player_available', 'screen_not_death'])
      if (!allowed.has(String(item.condition))) return { ok: false, error: `${itemPath}.condition must be death_screen, server_player_available, or screen_not_death.` }
      if (!numericOrVariable(item.timeoutMs) || (typeof item.timeoutMs !== 'string' && (item.timeoutMs < 1 || item.timeoutMs > MAX_GAME_TEST_WAIT_MS))) return { ok: false, error: `${itemPath}.timeoutMs must be between 1 and ${MAX_GAME_TEST_WAIT_MS}.` }
      if (item.pollMs !== undefined && (!numericOrVariable(item.pollMs) || (typeof item.pollMs !== 'string' && (item.pollMs < 25 || item.pollMs > 5_000)))) return { ok: false, error: `${itemPath}.pollMs must be between 25 and 5000.` }
      actions.push({ type: 'wait_until', condition: item.condition as 'death_screen' | 'server_player_available' | 'screen_not_death', timeoutMs: item.timeoutMs as number, ...(item.pollMs === undefined ? {} : { pollMs: item.pollMs as number }), ...meta })
    }
    else if (item.type === 'set_player_state') {
      const state = record(item.state)
      const inventory = state && Array.isArray(state.inventory) ? state.inventory : []
      const validState = state && numericOrVariable(state.x) && numericOrVariable(state.y) && numericOrVariable(state.z) && numericOrVariable(state.health) && numericOrVariable(state.hunger) &&
        (state.saturation === undefined || numericOrVariable(state.saturation)) &&
        (state.selectedSlot === undefined || numericOrVariable(state.selectedSlot)) &&
        inventory.every((entry) => {
          const itemEntry = record(entry)
          return Boolean(itemEntry && numericOrVariable(itemEntry.slot) && numericOrVariable(itemEntry.count) && nonEmptyString(itemEntry.itemId))
        })
      if (!validState) return { ok: false, error: `${itemPath}.state must contain bounded x/y/z, health, hunger and normalized inventory entries.` }
      actions.push({
        type: 'set_player_state',
        state: {
          x: state.x as number, y: state.y as number, z: state.z as number, health: state.health as number, hunger: state.hunger as number,
          ...(state.saturation === undefined ? {} : { saturation: state.saturation as number }),
          ...(state.selectedSlot === undefined ? {} : { selectedSlot: state.selectedSlot as number }),
          ...(inventory.length ? { inventory: inventory.map((entry) => { const itemEntry = record(entry)!; return { slot: itemEntry.slot as number, itemId: String(itemEntry.itemId), count: itemEntry.count as number } }) } : {})
        },
        ...meta
      })
    }
    else if (item.type === 'kill_player' || item.type === 'respawn') actions.push({ type: item.type, ...meta } as GameAction)
    else return { ok: false, error: `${itemPath} has incomplete action fields.` }
  }
  return { ok: true, actions }
}

function validateAssertionTimeline(actions: GameAction[], assertions: GameAssertion[]): { ok: true } | { ok: false; error: string } {
  const terminalTargets = new Map<string, Set<string>>()
  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index]
    const afterAction = assertion.type === 'state_changed' || assertion.type === 'player_state' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_unchanged' || assertion.type === 'snapshot_value' || assertion.type === 'render_trace' || assertion.type === 'hud_text' ? assertion.afterAction : undefined
    if (afterAction !== undefined && afterAction >= actions.length) {
      return { ok: false, error: `assertions[${index}].afterAction=${afterAction} exceeds actions length ${actions.length}.` }
    }
    if (assertion.type !== 'state_changed' && assertion.type !== 'snapshot_changed') continue
    if (assertion.afterAction === undefined && assertion.to !== undefined) {
      const path = assertion.type === 'state_changed' ? assertion.path : `${assertion.source}:${assertion.pointer}`
      const targets = terminalTargets.get(path) || new Set<string>()
      targets.add(JSON.stringify(assertion.to))
      terminalTargets.set(path, targets)
    }
  }
  const hasTimeline = assertions.some((assertion) => (assertion.type === 'state_changed' || assertion.type === 'snapshot_changed') && assertion.afterAction !== undefined)
  if (hasTimeline) {
    const ambiguous = assertions.findIndex((assertion) => (assertion.type === 'player_state' || assertion.type === 'snapshot_value') && assertion.afterAction === undefined)
    if (ambiguous >= 0) {
      return { ok: false, error: `assertions[${ambiguous}].afterAction is required because this is a multi-stage interaction test.` }
    }
  }
  for (const [path, targets] of terminalTargets) {
    if (targets.size > 1) {
      return {
        ok: false,
        error: `state_changed path "${path}" has contradictory terminal values. Use ordered actions and afterAction (zero-based action index) for each transition.`
      }
    }
  }
  return { ok: true }
}

function validateVariables(value: unknown): { ok: true; variables?: Record<string, GameTestVariableSpec> } | { ok: false; error: string } {
  if (value === undefined) return { ok: true }
  const raw = record(value)
  if (!raw) return { ok: false, error: 'variables must be an object.' }
  const variables: Record<string, GameTestVariableSpec> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) return { ok: false, error: 'variables.' + name + ' has an invalid name.' }
    const spec = record(entry)
    if (!spec || (spec.type !== 'integer' && spec.type !== 'number' && spec.type !== 'token')) return { ok: false, error: 'variables.' + name + '.type must be integer, number or token.' }
    if (spec.type === 'integer' || spec.type === 'number') {
      const integerRange = spec.type === 'integer'
      if (!numberValue(spec.min) || !numberValue(spec.max) || Number(spec.min) > Number(spec.max) || Number(spec.max) - Number(spec.min) > 1000000 || (integerRange && (!Number.isInteger(spec.min) || !Number.isInteger(spec.max)))) {
        return { ok: false, error: 'variables.' + name + ' numeric range is invalid.' }
      }
      if (spec.step !== undefined && (!numberValue(spec.step) || Number(spec.step) <= 0 || (integerRange && !Number.isInteger(spec.step)))) return { ok: false, error: 'variables.' + name + '.step is invalid.' }
      if (spec.values !== undefined && (!Array.isArray(spec.values) || spec.values.length < 1 || spec.values.length > 64 || !spec.values.every((item) => numberValue(item) && Number(item) >= Number(spec.min) && Number(item) <= Number(spec.max) && (!integerRange || Number.isInteger(item))))) {
        return { ok: false, error: 'variables.' + name + '.values must contain in-range numeric candidates.' }
      }
      variables[name] = { type: integerRange ? 'integer' : 'number', min: Number(spec.min), max: Number(spec.max), ...(spec.step === undefined ? {} : { step: Number(spec.step) }), ...(spec.values === undefined ? {} : { values: spec.values.map(Number) }) }
    } else {
      if (!Array.isArray(spec.values) || spec.values.length < 1 || spec.values.length > 64 || !spec.values.every((item) => nonEmptyString(item) && /^[A-Za-z0-9_.:-]{1,48}$/.test(item))) {
        return { ok: false, error: 'variables.' + name + ' token values are invalid.' }
      }
      variables[name] = { type: 'token', values: spec.values.map(String) }
    }
  }
  return { ok: true, variables }
}

function validateStrictScenario(
  actions: GameAction[],
  assertions: GameAssertion[],
  rawCheckpoints: unknown,
  baselineCheckpoint: unknown,
  variables: unknown,
  approvedLayoutId: unknown,
  approvedLayoutFingerprint: unknown
): { ok: true; checkpoints?: string[]; baselineCheckpoint?: string; variables?: Record<string, GameTestVariableSpec> } | { ok: false; error: string; code: GameTestInconclusiveCode } {
  const hasStrictFields = rawCheckpoints !== undefined || baselineCheckpoint !== undefined || variables !== undefined || approvedLayoutId !== undefined || approvedLayoutFingerprint !== undefined || actions.some((action) => Boolean(action.checkpoint)) || assertions.some((assertion) => 'checkpoint' in assertion || assertion.type === 'snapshot_relation' || assertion.type === 'elapsed_between' || assertion.type === 'combat_event')
  const parsedVariables = validateVariables(variables)
  if (!parsedVariables.ok) return { ...parsedVariables, code: 'SPEC_RUNTIME_VARIABLE_INVALID' }
  if (!hasStrictFields) return { ok: true, variables: parsedVariables.variables }
  const checkpoints = Array.isArray(rawCheckpoints) ? rawCheckpoints : []
  if (!checkpoints.length) return { ok: false, error: 'strict game tests must declare checkpoints.', code: 'SPEC_MISSING_CHECKPOINT' }
  if (!checkpoints.every(checkpointName) || new Set(checkpoints).size !== checkpoints.length) return { ok: false, error: 'checkpoints must contain unique identifiers.', code: 'SPEC_MISSING_CHECKPOINT' }
  const checkpointSet = new Set(checkpoints as string[])
  const baseline = baselineCheckpoint === undefined ? undefined : checkpointName(baselineCheckpoint) ? baselineCheckpoint : undefined
  if (baselineCheckpoint !== undefined && !baseline) return { ok: false, error: 'baselineCheckpoint must reference a declared checkpoint.', code: 'SPEC_MISSING_CHECKPOINT' }
  const actionCheckpointSet = new Set<string>()
  for (const [index, action] of actions.entries()) {
    if (action.checkpoint && !checkpointSet.has(action.checkpoint)) return { ok: false, error: 'actions[' + index + '].checkpoint is not declared.', code: 'SPEC_MISSING_CHECKPOINT' }
    if (!action.checkpoint) return { ok: false, error: 'actions[' + index + '] requires a unique checkpoint in strict mode.', code: 'SPEC_MISSING_CHECKPOINT' }
    if (actionCheckpointSet.has(action.checkpoint)) return { ok: false, error: 'actions[' + index + '].checkpoint is duplicated; every strict action must produce a unique named checkpoint.', code: 'SPEC_MISSING_CHECKPOINT' }
    actionCheckpointSet.add(action.checkpoint)
    if (action.type === 'set_player_state' || action.type === 'kill_player' || action.type === 'respawn') {
      if (!action.checkpoint) return { ok: false, error: 'actions[' + index + '] requires a named checkpoint in strict mode.', code: 'SPEC_MISSING_CHECKPOINT' }
    }
    if (action.type === 'set_player_state' && actions.slice(0, index).some((candidate) => candidate.type === 'kill_player')) {
      return { ok: false, error: 'actions[' + index + '].set_player_state is not allowed after kill_player.', code: 'SPEC_INVALID_ASSERTION' }
    }
  }
  for (const [index, assertion] of assertions.entries()) {
    if (Object.prototype.hasOwnProperty.call(assertion, 'afterAction') && assertion.afterAction !== undefined) {
      return { ok: false, error: 'strict game tests must bind assertions to named checkpoints; afterAction is not deterministic.', code: 'SPEC_MISSING_CHECKPOINT' }
    }
    const refs: string[] = []
    if ('checkpoint' in assertion && typeof assertion.checkpoint === 'string') refs.push(assertion.checkpoint)
    if (assertion.type === 'snapshot_relation') {
      if (assertion.left && assertion.right) refs.push(assertion.left.checkpoint, assertion.right.checkpoint)
      else refs.push(assertion.leftCheckpoint || '', assertion.rightCheckpoint || '')
    }
    if (assertion.type === 'elapsed_between') refs.push(assertion.fromCheckpoint, assertion.toCheckpoint)
    if ((assertion.type === 'hud_text' || assertion.type === 'combat_event') && assertion.sinceCheckpoint) refs.push(assertion.sinceCheckpoint)
    if (assertion.type === 'hud_text' && assertion.requireAttackerVictimSemantics && assertion.attackerCheckpoint) refs.push(assertion.attackerCheckpoint)
    if (assertion.type === 'combat_event' && assertion.attackerCheckpoint) refs.push(assertion.attackerCheckpoint)
    for (const ref of refs) if (!checkpointSet.has(ref)) return { ok: false, error: 'assertions[' + index + '] references undeclared checkpoint "' + ref + '".', code: 'SPEC_MISSING_CHECKPOINT' }
    if (assertion.type === 'snapshot_relation' && assertion.operator === 'approximately' && assertion.tolerance === undefined) {
      return { ok: false, error: 'assertions[' + index + '] approximately relation requires tolerance.', code: 'SPEC_INVALID_RELATION' }
    }
    if (assertion.type === 'hud_text' && assertion.approvedLayoutElementId && (!nonEmptyString(approvedLayoutId) || !nonEmptyString(approvedLayoutFingerprint))) {
      return { ok: false, error: 'assertions[' + index + '] references a HUD layout without an approved layout id/fingerprint.', code: 'LAYOUT_ORACLE_UNLINKED' }
    }
    if ((assertion.type === 'hud_text' || assertion.type === 'combat_event') && !assertion.sinceCheckpoint) {
      return { ok: false, error: 'assertions[' + index + '] trace assertions require sinceCheckpoint to bind evidence to a fresh cursor.', code: 'SPEC_MISSING_CHECKPOINT' }
    }
    if (assertion.type === 'combat_event' && assertion.attackerIsPlayer === true && !assertion.attackerUuid && !assertion.attackerCheckpoint) {
      return { ok: false, error: 'player-attributed combat_event must bind attackerUuid or attackerCheckpoint to the observed player UUID.', code: 'SPEC_INVALID_ASSERTION' }
    }
  }
  return { ok: true, checkpoints: checkpoints as string[], baselineCheckpoint: baseline, variables: parsedVariables.variables }
}

/** Creates a V2 scenario only when it has concrete target IDs and assertions. */
export function createGameTestSpec(args: Record<string, unknown>): { ok: true; spec: GameTestSpec } | { ok: false; error: string } {
  const kind = featureType(args.feature_type)
  if (!kind) return { ok: false, error: 'feature_type 必须是六种受支持的游戏功能类型之一。' }

  const subjectId = stringValue(args.subject_id) || stringValue(args.target_id)
  const modId = stringValue(args.mod_id)
  const hotkey = stringValue(args.hotkey)
  if ((kind === 'entity_behavior' || kind === 'new_item' || kind === 'new_block' || kind === 'new_recipe') && !subjectId) {
    return { ok: false, error: 'V2 测试需要 concrete subject_id（HUD/GUI 可提供 hotkey）；禁止使用占位符。' }
  }
  if ([subjectId, modId, hotkey].filter(Boolean).some((item) => PLACEHOLDER_RE.test(String(item)))) {
    return { ok: false, error: '测试目标包含未替换占位符。请提供实际命名空间 ID、热键或控件标识。' }
  }

  const validatedAssertions = validateGameAssertions(args.assertions)
  if (!validatedAssertions.ok) return validatedAssertions
  const suppliedActions = validateActions(args.actions, 'actions')
  if (!suppliedActions.ok) return suppliedActions
  const assertions = validatedAssertions.assertions
  const capabilities = validateObserverCapabilities(assertions)
  if (!capabilities.ok) return capabilities
  if (assertions.length === 0) {
    return { ok: false, error: 'V2 测试必须包含至少一条客观 assertions；截图和“命令已发送”不构成断言。' }
  }
  const invalid = assertions.find((assertion) => JSON.stringify(assertion).match(PLACEHOLDER_RE))
  if (invalid) return { ok: false, error: `断言包含未替换占位符：${JSON.stringify(invalid)}` }

  const setup = defaultSetup()
  const actions: GameAction[] = [...suppliedActions.actions]
  if (actions.length === 0 && kind === 'new_item') {
    actions.push({ type: 'command', command: `give @s ${subjectId} 1`, label: '给予目标物品' })
  } else if (actions.length === 0 && kind === 'player_interaction' && hotkey) {
    actions.push({ type: 'input', action: 'key_press', args: { key: hotkey }, label: 'trigger interaction' })
    actions.push({ type: 'wait', ms: 500, label: 'wait for interaction' })
  } else if (actions.length === 0 && kind === 'player_interaction' && subjectId) {
    actions.push({ type: 'command', command: `give @s ${subjectId} 1`, label: 'give interaction item' })
  } else if (actions.length === 0 && kind === 'new_block') {
    actions.push({ type: 'command', command: `setblock 0 100 4 ${subjectId}`, label: '放置目标方块' })
  } else if (actions.length === 0 && kind === 'entity_behavior') {
    actions.push({ type: 'command', command: `summon ${subjectId} 0 100 4 {Tags:["modcrafting_test"]}`, label: '召唤测试实体' })
    actions.push({ type: 'wait', ms: 500, label: '等待实体初始化' })
  } else if (actions.length === 0 && kind === 'hud_gui' && hotkey) {
    actions.push({ type: 'input', action: 'key_press', args: { key: hotkey }, label: '触发目标界面' })
    actions.push({ type: 'wait', ms: 700, label: '等待界面打开' })
  }

  const timeline = validateAssertionTimeline(actions, assertions)
  if (!timeline.ok) return timeline
  if (actions.length === 0) {
    return { ok: false, error: 'V2 游戏测试必须包含至少一个可执行 action；不能只提交断言或截图。' }
  }

  const strict = validateStrictScenario(
    actions,
    assertions,
    args.checkpoints ?? args.checkpoint_names,
    args.baselineCheckpoint ?? args.baseline_checkpoint,
    args.variables,
    args.approvedLayoutId ?? args.approved_layout_id,
    args.approvedLayoutFingerprint ?? args.approved_layout_fingerprint
  )
  if (!strict.ok) return { ok: false, error: strict.error }

  const rawRequiredPassCount = args.required_pass_count ?? args.requiredPassCount
  const requiredPassCount = requiredPassCountValue(rawRequiredPassCount)
  if (rawRequiredPassCount !== undefined && requiredPassCount === undefined) {
    return { ok: false, error: 'required_pass_count must be an integer from 1 to 3.' }
  }

  const suppliedContract = args.acceptanceContract && typeof args.acceptanceContract === 'object'
    ? validateAcceptanceContract(args.acceptanceContract, (assertion) => {
        const candidate = validateGameAssertions([assertion])
        return candidate.ok ? { ok: true } : { ok: false, error: candidate.error }
      })
    : undefined
  if (suppliedContract && !suppliedContract.ok) return suppliedContract
  const coverage = validateContractCoverage(suppliedContract?.ok ? suppliedContract.contract : undefined, assertions)
  if (!coverage.ok) return coverage
  if (!Boolean(args.visual_only) && suppliedContract?.ok && suppliedContract.contract.requirements.some((requirement) => requirement.oracle.type === 'user_confirmation')) {
    return { ok: false, error: 'Automated game tests cannot mix user_confirmation with objective game assertions; move visual review to a separate visual-only review.' }
  }

  const spec: GameTestSpec = {
    version: 2,
    id: nextId('scenario'),
    featureType: kind,
    subject: { ...(modId ? { modId } : {}), ...(subjectId ? { id: subjectId } : {}), ...(hotkey ? { hotkey } : {}) },
    setup,
    actions,
    assertions,
    cleanup: defaultCleanup(),
    visualOnly: Boolean(args.visual_only),
    ...(suppliedContract?.ok ? { acceptanceContract: suppliedContract.contract } : {}),
    scenarioRevision: 1,
    ...(strict.checkpoints ? { checkpoints: strict.checkpoints } : {}),
    ...(strict.baselineCheckpoint ? { baselineCheckpoint: strict.baselineCheckpoint } : {}),
    ...(strict.variables ? { variables: strict.variables } : {}),
    ...((args.approvedLayoutId ?? args.approved_layout_id) ? { approvedLayoutId: String(args.approvedLayoutId ?? args.approved_layout_id) } : {}),
    ...((args.approvedLayoutFingerprint ?? args.approved_layout_fingerprint) ? { approvedLayoutFingerprint: String(args.approvedLayoutFingerprint ?? args.approved_layout_fingerprint) } : {}),
    ...(requiredPassCount && requiredPassCount > 1 ? { requiredPassCount } : {}),
    createdAt: Date.now()
  }
  if (spec.approvedLayoutId) {
    const approved = getApprovedLayoutRecord(spec.approvedLayoutId, spec.approvedLayoutFingerprint)
    if (approved) spec.approvedLayoutRecord = approved
    if (spec.assertions.some((assertion) => assertion.type === 'hud_text' && assertion.approvedLayoutElementId) && !approved) {
      return { ok: false, error: 'LAYOUT_ORACLE_UNLINKED: HUD assertion requires a host-approved layout record with matching approvalId and fingerprint.' }
    }
    if (approved) {
      const hudElements = spec.assertions
        .filter((assertion): assertion is Extract<GameAssertion, { type: 'hud_text' }> => assertion.type === 'hud_text' && Boolean(assertion.approvedLayoutElementId))
        .map((assertion) => approved.elements.find((element) => element.id === assertion.approvedLayoutElementId))
      if (hudElements.some((element) => !element || element.color === undefined || element.alpha === undefined || element.shadow === undefined)) {
        return { ok: false, error: 'LAYOUT_ORACLE_UNLINKED: approved HUD element must include normalized position, ARGB color, alpha and shadow style.' }
      }
    }
  }
  spec.acceptanceContractFingerprint = acceptanceContractFingerprint(spec.acceptanceContract)
  spec.scenarioFingerprint = gameTestScenarioFingerprint(spec)
  sessions.set(spec.id, spec)
  return { ok: true, spec }
}

export function getGameTestSpec(id: string): GameTestSpec | undefined {
  return sessions.get(id)
}

/** Restores a persisted spec without changing its scenario ID. */
export function registerGameTestSpec(value: unknown): { ok: true; spec: GameTestSpec } | { ok: false; error: string } {
  const raw = record(value)
  if (!raw || raw.version !== 2 || !nonEmptyString(raw.id) || !featureType(raw.featureType)) return { ok: false, error: 'Invalid V2 GameTestSpec.' }
  const subject = record(raw.subject) || {}
  const asserted = validateGameAssertions(raw.assertions)
  const setup = validateActions(raw.setup, 'setup')
  const actions = validateActions(raw.actions, 'actions')
  const cleanup = validateActions(raw.cleanup, 'cleanup')
  if (!asserted.ok) return asserted
  const capabilities = validateObserverCapabilities(asserted.assertions)
  if (!capabilities.ok) return capabilities
  if (!setup.ok) return setup
  if (!actions.ok) return actions
  if (!cleanup.ok) return cleanup
  if (actions.actions.length === 0) return { ok: false, error: 'Persisted V2 GameTestSpec must contain at least one executable action.' }
  const timeline = validateAssertionTimeline(actions.actions, asserted.assertions)
  if (!timeline.ok) return timeline
  const strict = validateStrictScenario(
    actions.actions,
    asserted.assertions,
    raw.checkpoints,
    raw.baselineCheckpoint,
    raw.variables,
    raw.approvedLayoutId,
    raw.approvedLayoutFingerprint
  )
  if (!strict.ok) return { ok: false, error: strict.error }
  const restoredContract = raw.acceptanceContract && typeof raw.acceptanceContract === 'object'
    ? validateAcceptanceContract(raw.acceptanceContract, (assertion) => {
        const candidate = validateGameAssertions([assertion])
        return candidate.ok ? { ok: true } : { ok: false, error: candidate.error }
      })
    : undefined
  if (restoredContract && !restoredContract.ok) return restoredContract
  const restoredCoverage = validateContractCoverage(
    restoredContract?.ok ? restoredContract.contract : undefined,
    asserted.assertions
  )
  if (!restoredCoverage.ok) return restoredCoverage
  if (!Boolean(raw.visualOnly) && restoredContract?.ok && restoredContract.contract.requirements.some((requirement) => requirement.oracle.type === 'user_confirmation')) {
    return { ok: false, error: 'Persisted automated game tests cannot mix user_confirmation with objective game assertions.' }
  }
  const rawRequiredPassCount = raw.requiredPassCount ?? raw.required_pass_count
  const requiredPassCount = requiredPassCountValue(rawRequiredPassCount)
  if (rawRequiredPassCount !== undefined && requiredPassCount === undefined) return { ok: false, error: 'Persisted requiredPassCount must be an integer from 1 to 3.' }
  let restoredApprovedLayout: ApprovedLayoutRecord | undefined
  if (raw.approvedLayoutId && record(raw.approvedLayoutRecord)) {
    const registered = registerApprovedLayoutRecord(raw.approvedLayoutRecord)
    if (!registered.ok) return registered
    if (registered.record.approvalId !== raw.approvedLayoutId || (raw.approvedLayoutFingerprint && registered.record.layoutFingerprint !== raw.approvedLayoutFingerprint)) {
      return { ok: false, error: 'LAYOUT_ORACLE_UNLINKED: persisted approved layout record does not match its id/fingerprint.' }
    }
    restoredApprovedLayout = registered.record
  }
  const spec: GameTestSpec = {
    version: 2,
    id: raw.id,
    featureType: featureType(raw.featureType)!,
    subject: {
      ...(nonEmptyString(subject.modId) ? { modId: subject.modId } : {}),
      ...(nonEmptyString(subject.id) ? { id: subject.id } : {}),
      ...(nonEmptyString(subject.hotkey) ? { hotkey: subject.hotkey } : {})
    },
    setup: setup.actions,
    actions: actions.actions,
    assertions: asserted.assertions,
    cleanup: cleanup.actions,
    visualOnly: Boolean(raw.visualOnly),
    acceptanceContract: restoredContract?.ok
      ? restoredContract.contract
      : legacyAcceptanceContract(asserted.assertions, Boolean(raw.visualOnly)),
    scenarioRevision: Number.isInteger(raw.scenarioRevision) && Number(raw.scenarioRevision) > 0 ? Number(raw.scenarioRevision) : 1,
    ...(requiredPassCount && requiredPassCount > 1 ? { requiredPassCount } : {}),
    ...(strict.checkpoints ? { checkpoints: strict.checkpoints } : {}),
    ...(strict.baselineCheckpoint ? { baselineCheckpoint: strict.baselineCheckpoint } : {}),
    ...(strict.variables ? { variables: strict.variables } : {}),
    ...(nonEmptyString(raw.approvedLayoutId) ? { approvedLayoutId: raw.approvedLayoutId } : {}),
    ...(nonEmptyString(raw.approvedLayoutFingerprint) ? { approvedLayoutFingerprint: raw.approvedLayoutFingerprint } : {}),
    ...(restoredApprovedLayout ? { approvedLayoutRecord: restoredApprovedLayout } : {}),
    ...(normalizeRuntimeState(raw.runtimeState) ? { runtimeState: normalizeRuntimeState(raw.runtimeState) } : {}),
    ...(Array.isArray(raw.supersededScenarioIds) ? { supersededScenarioIds: raw.supersededScenarioIds.filter(nonEmptyString) } : {}),
    createdAt: numberValue(raw.createdAt) ? raw.createdAt : Date.now()
  }
  if (spec.assertions.some((assertion) => assertion.type === 'hud_text' && assertion.approvedLayoutElementId) && (!spec.approvedLayoutId || !spec.approvedLayoutRecord)) {
    return { ok: false, error: 'LAYOUT_ORACLE_UNLINKED: persisted HUD assertion has no host-approved layout record.' }
  }
  if (spec.approvedLayoutRecord) {
    const hudElements = spec.assertions
      .filter((assertion): assertion is Extract<GameAssertion, { type: 'hud_text' }> => assertion.type === 'hud_text' && Boolean(assertion.approvedLayoutElementId))
      .map((assertion) => spec.approvedLayoutRecord!.elements.find((element) => element.id === assertion.approvedLayoutElementId))
    if (hudElements.some((element) => !element || element.color === undefined || element.alpha === undefined || element.shadow === undefined)) {
      return { ok: false, error: 'LAYOUT_ORACLE_UNLINKED: persisted approved HUD element is missing color, alpha or shadow style.' }
    }
  }
  spec.acceptanceContractFingerprint = nonEmptyString(raw.acceptanceContractFingerprint)
    ? raw.acceptanceContractFingerprint
    : acceptanceContractFingerprint(spec.acceptanceContract)
  if (raw.visualReviewDecision === 'accepted' || raw.visualReviewDecision === 'rejected') {
    spec.visualReviewDecision = raw.visualReviewDecision
  }
  const reviewEvidence = record(raw.visualReviewEvidence)
  if (reviewEvidence && (reviewEvidence.decision === 'accepted' || reviewEvidence.decision === 'rejected') && nonEmptyString(reviewEvidence.prompt) && numberValue(reviewEvidence.reviewedAt)) {
    spec.visualReviewEvidence = {
      decision: reviewEvidence.decision,
      prompt: reviewEvidence.prompt,
      ...(nonEmptyString(reviewEvidence.screenshotToolId) ? { screenshotToolId: reviewEvidence.screenshotToolId } : {}),
      ...(numberValue(reviewEvidence.capturedAt) ? { capturedAt: reviewEvidence.capturedAt } : {}),
      reviewedAt: reviewEvidence.reviewedAt
    }
  }
  spec.scenarioFingerprint = nonEmptyString(raw.scenarioFingerprint) ? raw.scenarioFingerprint : gameTestScenarioFingerprint(spec)
  sessions.set(spec.id, spec)
  return { ok: true, spec }
}

/** Extracts legacy fenced V2 specs from persisted assistant and tool output. */
export function hydrateGameTestSpecsFromText(text: string): number {
  let restored = 0
  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>
      const source = record(parsed.gameTest) || (parsed.version === 2 ? parsed : null)
      if (source && registerGameTestSpec(source).ok) restored++
    } catch { /* Ignore non-spec JSON fences. */ }
  }
  return restored
}

export function formatGameTestSpec(spec: GameTestSpec): string {
  return [
    `# V2 确定性测试场景：${spec.featureType}`,
    `场景 ID：${spec.id}`,
    `目标：${spec.subject.id || spec.subject.hotkey || 'unknown'}`,
    `断言数：${spec.assertions.length}`,
    ...(spec.requiredPassCount && spec.requiredPassCount > 1 ? [`独立 PASS 次数：${spec.requiredPassCount}`] : []),
    '执行方式：调用 mc_run_test({"scenarioId":"' + spec.id + '"})。',
    '```json',
    JSON.stringify(spec, null, 2),
    '```'
  ].join('\n')
}

export function createInconclusiveSession(
  scenarioId: string,
  reason: string,
  options: {
    code?: GameTestInconclusiveCode
    responsibility?: GameTestResponsibility
    scenarioRevision?: number
    scenarioFingerprint?: string
    acceptanceContractFingerprint?: string
    requiredPassCount?: number
    supersededScenarioIds?: string[]
    runtimeState?: GameTestRuntimeState
  } = {}
): GameTestSession {
  const now = Date.now()
  return {
    id: nextId('test'), scenarioId, phase: 'finished', startedAt: now, finishedAt: now,
    verdict: 'INCONCLUSIVE', evidence: [], reason, replay: 0,
    inconclusiveCode: options.code,
    responsibility: options.responsibility,
    scenarioRevision: options.scenarioRevision,
    scenarioFingerprint: options.scenarioFingerprint,
    acceptanceContractFingerprint: options.acceptanceContractFingerprint,
    requiredPassCount: options.requiredPassCount,
    supersededScenarioIds: options.supersededScenarioIds,
    runtimeState: options.runtimeState
  }
}
