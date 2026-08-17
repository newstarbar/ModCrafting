import type { Tool, ToolContext, ToolExecutionPayload } from './tools.ts'
import { callMcBridge, mcEnsureTestWorldTool, type BridgeCallResult } from './mc-observer-tools.ts'
import {
  GAME_TEST_WORLD,
  MAX_GAME_TEST_WAIT_MS,
  acceptanceContractFingerprint,
  createInconclusiveSession,
  gameTestScenarioFingerprint,
  gameTestVariantFingerprint,
  getApprovedLayoutRecord,
  getGameTestSpec,
  stateTransitionMatches,
  type GameAction,
  type GameAssertion,
  type GameTestEvidence,
  type GameTestInconclusiveCode,
  type GameTestResponsibility,
  type GameTestRuntimeState,
  type GameTestSession,
  type GameTestVerdict
} from './game-test-protocol.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const successfulVariantsByScenario = new Map<string, Set<string>>()
type ReplayPurpose = 'first_failure_replay' | 'product_diagnostic'
const failureReplayByScenario = new Map<string, { values: Record<string, string | number>; purpose: ReplayPurpose }>()

function runtimeStateForSpec(spec: ReturnType<typeof getGameTestSpec>): GameTestRuntimeState {
  const current = spec?.runtimeState
  return current || {
    evidenceRepairAttempts: 0,
    environmentRecoveryAttempts: 0,
    failureCounts: {},
    successfulVariantFingerprints: [],
    formalReplayHistory: []
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function pathValue(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => asRecord(current)[key], value)
}

function pointerValue(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined
  return pointer.slice(1).split('/').reduce<unknown>((current, token) => {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) return current[Number(key)]
    return asRecord(current)[key]
  }, value)
}

function snapshotSource(data: Record<string, unknown>, source: string): unknown {
  const aliases: Record<string, string> = { player: 'player', serverPlayer: 'serverPlayer', screen: 'screen', entity: 'entities', renderTrace: 'renderTrace', hudTrace: 'hudTrace', combatTrace: 'combatTrace' }
  return data[aliases[source] || source]
}

function resultText(result: BridgeCallResult): string {
  return result.ok ? JSON.stringify(result.data) : String(result.error || result.data.error || 'bridge request failed')
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

function worldTick(data: Record<string, unknown> | undefined): number | undefined {
  if (!data) return undefined
  const direct = Number(data.worldTime ?? data.worldTick)
  if (Number.isFinite(direct)) return direct
  const server = asRecord(data.serverPlayer)
  const nested = Number(server.worldTick)
  return Number.isFinite(nested) ? nested : undefined
}

function windowFingerprint(data: Record<string, unknown> | undefined): string | undefined {
  const screen = asRecord(data?.screen)
  const width = Number(screen.windowWidth ?? screen.scaledWidth ?? screen.screenWidth ?? screen.width)
  const height = Number(screen.windowHeight ?? screen.scaledHeight ?? screen.screenHeight ?? screen.height)
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? `${width}x${height}` : undefined
}

function traceCursor(data: Record<string, unknown> | undefined, key: 'hudTrace' | 'renderTrace' | 'combatTrace'): number {
  const explicit = asRecord(data?.traceCursors)[key]
  if (Number.isFinite(Number(explicit))) return Number(explicit)
  const trace = Array.isArray(data?.[key]) ? data?.[key] as Record<string, unknown>[] : []
  return trace.reduce((max, entry) => Math.max(max, Number(entry.sequence || 0)), 0)
}

function replaceVariables(value: unknown, variables: Record<string, string | number>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}$/)
    if (exact && Object.prototype.hasOwnProperty.call(variables, exact[1])) return variables[exact[1]]
    return value.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (full, name: string) => Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : full)
  }
  if (Array.isArray(value)) return value.map((entry) => replaceVariables(entry, variables))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, replaceVariables(child, variables)]))
  return value
}

function unresolvedVariable(value: unknown): string | undefined {
  const match = JSON.stringify(value).match(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/)
  return match?.[1]
}

function resolvedPlayerStateError(value: unknown): string | undefined {
  const state = asRecord(value)
  const numeric = (name: string): number | undefined => {
    const parsed = Number(state[name])
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const x = numeric('x'); const y = numeric('y'); const z = numeric('z')
  const health = numeric('health'); const hunger = numeric('hunger')
  if ([x, y, z, health, hunger].some((item) => item === undefined)) return 'set_player_state contains an unresolved or non-numeric runtime value.'
  if (x! < -16 || x! > 16 || z! < -16 || z! > 16 || y! < 96 || y! > 112) return 'set_player_state coordinates are outside the ModCrafting test region.'
  if (health! <= 0 || health! > 20 || hunger! < 0 || hunger! > 20) return 'set_player_state health/hunger is outside the supported player bounds.'
  const saturation = state.saturation === undefined ? undefined : numeric('saturation')
  if (saturation !== undefined && (saturation < 0 || saturation > 20)) return 'set_player_state saturation is outside the supported player bounds.'
  const selectedSlot = state.selectedSlot === undefined ? undefined : numeric('selectedSlot')
  if (selectedSlot !== undefined && (!Number.isInteger(selectedSlot) || selectedSlot < 0 || selectedSlot > 8)) return 'set_player_state selectedSlot must be an integer from 0 to 8.'
  if (state.inventory !== undefined) {
    if (!Array.isArray(state.inventory)) return 'set_player_state inventory must be an array.'
    for (const entry of state.inventory) {
      const row = asRecord(entry)
      const slot = Number(row.slot); const count = Number(row.count)
      if (!Number.isInteger(slot) || slot < 0 || slot > 40 || !Number.isInteger(count) || count < 1 || count > 64 || !String(row.itemId || '').trim()) {
        return 'set_player_state inventory contains an invalid slot, count or item id.'
      }
    }
  }
  return undefined
}

async function runAction(action: GameAction, instanceId?: string, variables: Record<string, string | number> = {}): Promise<{ ok: boolean; detail: string; data?: Record<string, unknown> }> {
  if (action.type === 'wait') {
    const resolved = replaceVariables(action, variables) as Extract<GameAction, { type: 'wait' }>
    const durationValue = Number(resolved.ms)
    if (!Number.isFinite(durationValue)) return { ok: false, detail: 'wait contains an unresolved or non-numeric runtime value.', data: { code: 'SPEC_RUNTIME_VARIABLE_INVALID' } }
    const duration = Math.max(0, Math.min(durationValue, MAX_GAME_TEST_WAIT_MS))
    await sleep(duration)
    return { ok: true, detail: `waited ${duration}ms` }
  }
  if (action.type === 'wait_until') {
    const resolved = replaceVariables(action, variables) as Extract<GameAction, { type: 'wait_until' }>
    const timeoutValue = Number(resolved.timeoutMs)
    const pollValue = Number(resolved.pollMs || 100)
    if (!Number.isFinite(timeoutValue) || !Number.isFinite(pollValue)) return { ok: false, detail: 'wait_until contains an unresolved or non-numeric runtime value.', data: { code: 'SPEC_RUNTIME_VARIABLE_INVALID' } }
    const timeout = Math.max(1, Math.min(timeoutValue, MAX_GAME_TEST_WAIT_MS))
    const poll = Math.max(25, Math.min(pollValue, 5_000))
    const deadline = monotonicNow() + timeout
    let last: BridgeCallResult | undefined
    while (monotonicNow() < deadline) {
      last = await snapshot(instanceId)
      if (!last.ok) return { ok: false, detail: resultText(last), data: last.data }
      const screen = asRecord(last.data.screen)
      const serverPlayer = asRecord(last.data.serverPlayer)
      const simple = String(screen.simpleName || screen.className || screen.kind || '').toLowerCase()
      const death = /death|gameover|dead/.test(simple) || /death|gameover|dead/.test(String(screen.title || '').toLowerCase())
      const matched = resolved.condition === 'death_screen' ? death : resolved.condition === 'screen_not_death' ? !death : serverPlayer.available === true
      if (matched) return { ok: true, detail: `wait_until ${resolved.condition} matched`, data: last.data }
      await sleep(poll)
    }
    return { ok: false, detail: `wait_until ${resolved.condition} timed out`, data: last?.data }
  }
  if (action.type === 'set_player_state' || action.type === 'kill_player' || action.type === 'respawn') {
    const resolved = replaceVariables(action, variables) as GameAction
    if (resolved.type === 'set_player_state') {
      const stateError = resolvedPlayerStateError(resolved.state)
      if (stateError) return { ok: false, detail: stateError, data: { code: 'SPEC_RUNTIME_VARIABLE_INVALID' } }
    }
    const result = await callMcBridge('POST', '/v2/player-state', {
      action: resolved.type,
      ...(resolved.type === 'set_player_state' ? { state: resolved.state } : {})
    }, instanceId)
    return { ok: result.ok && result.data.executed !== false, detail: resultText(result), data: result.data }
  }
  if (action.type === 'input') {
    const resolved = replaceVariables(action, variables) as Extract<GameAction, { type: 'input' }>
    const result = await callMcBridge('POST', '/v1/input', { action: resolved.action, ...(resolved.args || {}) }, instanceId)
    return { ok: result.ok, detail: resultText(result), data: result.data }
  }
  const resolved = replaceVariables(action, variables) as Extract<GameAction, { type: 'command' }>
  const result = await callMcBridge('POST', '/v2/command', { command: resolved.command }, instanceId)
  const executed = result.data.executed === true
  return { ok: result.ok && executed, detail: resultText(result), data: result.data }
}

/** Classify an action failure before workflow routing.  A rejected command is a
 * test-spec defect; bridge/process readiness failures belong to environment
 * recovery and must never be treated as a product assertion failure. */
function actionFailureClassification(result: { detail: string; data?: Record<string, unknown> }): {
  code: GameTestInconclusiveCode
  responsibility: GameTestResponsibility
} {
  const signal = `${String(result.data?.code || '')} ${String(result.data?.error || '')} ${result.detail}`
  if (String(result.data?.code || '') === 'SPEC_RUNTIME_VARIABLE_INVALID') {
    return { code: 'SPEC_RUNTIME_VARIABLE_INVALID', responsibility: 'agent_test_design' }
  }
  if (/(?:bridge|observer|unavailable|not[_ -]?ready|offline|timeout|timed out|connection|instance|minecraft process|没有运行中的游戏实例|观测桥未就绪)/i.test(signal)) {
    return { code: 'OBSERVER_UNAVAILABLE', responsibility: 'environment' }
  }
  return { code: 'SPEC_ACTION_FAILED', responsibility: 'agent_test_design' }
}

async function snapshot(instanceId?: string): Promise<BridgeCallResult> {
  return callMcBridge('POST', '/v2/snapshot', {
    blocks: [{ x: 0, y: 100, z: 4 }],
    entityRadius: 32,
    includeRecipes: true
  }, instanceId)
}

function inconclusiveFor(
  spec: ReturnType<typeof getGameTestSpec>,
  scenarioId: string,
  reason: string,
  code: GameTestInconclusiveCode,
  responsibility: GameTestResponsibility
) {
  return createInconclusiveSession(scenarioId, reason, {
    code,
    responsibility,
    scenarioRevision: spec?.scenarioRevision,
    scenarioFingerprint: spec?.scenarioFingerprint || (spec ? gameTestScenarioFingerprint(spec) : undefined),
    acceptanceContractFingerprint: spec?.acceptanceContractFingerprint || acceptanceContractFingerprint(spec?.acceptanceContract),
    requiredPassCount: spec?.requiredPassCount,
    supersededScenarioIds: spec?.supersededScenarioIds,
    runtimeState: spec?.runtimeState
  })
}

function resolveVariables(spec: ReturnType<typeof getGameTestSpec>, scenarioId?: string): { values: Record<string, string | number>; replayPurpose?: ReplayPurpose; independentReplayProven?: boolean } {
  const durableState = runtimeStateForSpec(spec)
  const queuedFailureReplay = scenarioId ? failureReplayByScenario.get(scenarioId) || durableState.failureReplay : undefined
  if (queuedFailureReplay) {
    if (scenarioId && !failureReplayByScenario.has(scenarioId)) failureReplayByScenario.set(scenarioId, queuedFailureReplay)
    return { values: { ...queuedFailureReplay.values }, replayPurpose: queuedFailureReplay.purpose }
  }
  const prior = scenarioId && spec?.requiredPassCount && spec.requiredPassCount > 1
    ? successfulVariantsByScenario.get(scenarioId) || new Set(durableState.successfulVariantFingerprints)
    : new Set<string>()
  if (scenarioId && prior.size && !successfulVariantsByScenario.has(scenarioId)) successfulVariantsByScenario.set(scenarioId, prior)
  let last: Record<string, string | number> = {}
  for (let attempt = 0; attempt < (prior.size ? 10 : 1); attempt++) {
  const resolved: Record<string, string | number> = {}
  for (const [name, definition] of Object.entries(spec?.variables || {})) {
    if (definition.type === 'token') {
      const values = definition.values || []
      resolved[name] = values.length ? values[Math.floor(Math.random() * values.length)] : `${name}_${Date.now().toString(36)}`
    } else {
      const min = Number(definition.min || 0)
      const max = Number(definition.max ?? min)
      const candidates = Array.isArray(definition.values) ? definition.values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : []
      if (candidates.length) {
        resolved[name] = candidates[Math.floor(Math.random() * candidates.length)]
        continue
      }
      const step = Number(definition.step || (definition.type === 'integer' ? 1 : 0))
      if (step > 0) {
        const count = Math.max(0, Math.floor((max - min) / step + 1e-9))
        const selected = min + Math.floor(Math.random() * (count + 1)) * step
        resolved[name] = definition.type === 'integer' ? Math.round(selected) : Number(selected.toFixed(6))
      } else {
        resolved[name] = definition.type === 'integer' ? Math.floor(min + Math.random() * Math.max(1, max - min + 1)) : min + Math.random() * Math.max(0, max - min)
      }
    }
  }
    last = resolved
    if (!prior.has(variantFingerprintForSpec(spec, resolved))) return { values: resolved, independentReplayProven: true }
  }
  // A required independent replay must never silently reuse the first formal
  // variant.  The host gets ten bounded resampling attempts; if every sample
  // collides, return a structured inconclusive result instead of executing a
  // duplicate run that could be mistaken for independent evidence.
  return { values: last, independentReplayProven: false }
}

/** A replay must differ in a value that actually participates in the scenario.
 * An unused random token cannot manufacture independence while P/A/C or HUD
 * inputs remain identical. Setup is included because fixtures may use a value
 * while preparing the dedicated test world. */
function variantFingerprintForSpec(spec: ReturnType<typeof getGameTestSpec>, values: Record<string, string | number>): string {
  const declared = Object.keys(values)
  const source = JSON.stringify({ setup: spec?.setup || [], actions: spec?.actions || [], assertions: spec?.assertions || [], cleanup: spec?.cleanup || [] })
  const used = Object.fromEntries(declared.filter((name) => new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\}\\}`).test(source)).map((name) => [name, values[name]]))
  return gameTestVariantFingerprint(used)
}

function snapshotWithCheckpointMeta(result: BridgeCallResult, observedAt: number): Record<string, unknown> {
  return { ...(result.data || {}), __checkpointObservedAt: observedAt, __checkpointMonotonicAt: monotonicNow() }
}

function checkpointSummary(data: Record<string, unknown>): Record<string, unknown> {
  return {
    observedAt: data.__checkpointObservedAt || data.observedAt,
    worldTime: data.worldTime,
    worldName: data.worldName,
    observerSessionId: data.observerSessionId,
    player: data.player,
    serverPlayer: data.serverPlayer,
    inventory: data.inventory,
    screen: data.screen,
    traceCursors: data.traceCursors
  }
}

function capabilitySupportsSpec(spec: ReturnType<typeof getGameTestSpec>, capabilities: Record<string, unknown>): { ok: true } | { ok: false; detail: string } {
  const observation = asRecord(capabilities.observation)
  const advertisedSnapshotFields = asRecord(capabilities.snapshotFields)
  const fieldsFor = (source: string): Set<string> | undefined => {
    const raw = advertisedSnapshotFields[source]
    return Array.isArray(raw) ? new Set(raw.map(String)) : undefined
  }
  const firstPointerField = (pointer: string): string => pointer.slice(1).split('/')[0].replace(/~1/g, '/').replace(/~0/g, '~')
  const requireSnapshotField = (source: string, pointer: string, index: number): string | undefined => {
    const fields = fieldsFor(source)
    const field = firstPointerField(pointer)
    if (!fields) return `Observer V2 ${source} capability field list is unavailable for assertion ${index}.`
    return !fields.has(field) ? `Observer V2 ${source} capability is missing field ${field} for assertion ${index}.` : undefined
  }
  for (const assertion of spec?.assertions || []) {
    const index = spec?.assertions?.indexOf(assertion) ?? 0
    if (assertion.type === 'combat_event') {
      if (observation.combatTrace !== true) return { ok: false, detail: 'Observer V2 combatTrace capability is unavailable.' }
      const fields = Array.isArray(observation.combatTraceFields) ? new Set(observation.combatTraceFields.map(String)) : undefined
      const required = ['sequence', 'observedAt', ...(assertion.victimTag ? ['victimTags'] : []), ...(assertion.victimUuid ? ['victimUuid'] : []), ...(assertion.victimType ? ['victimType'] : []), ...(assertion.victimName ? ['victimName'] : []), ...(assertion.attackerUuid || assertion.attackerCheckpoint ? ['attackerUuid'] : []), ...(assertion.attackerIsPlayer !== undefined ? ['attackerIsPlayer'] : []), ...(assertion.damageType ? ['damageType'] : []), ...(assertion.killed !== undefined ? ['killed'] : [])]
      if (!fields || required.some((field) => !fields.has(field))) return { ok: false, detail: 'Observer V2 combatTrace capability is missing a required field.' }
    }
    if (assertion.type === 'hud_text') {
      if (observation.hudTrace !== true) return { ok: false, detail: 'Observer V2 HUD trace capability is unavailable.' }
      const fields = Array.isArray(observation.hudTraceFields) ? new Set(observation.hudTraceFields.map(String)) : undefined
      const required = ['sequence', 'text', 'observedAt', ...(assertion.normalizedPosition || assertion.approvedLayoutElementId ? ['normalizedX', 'normalizedY'] : []), ...(assertion.color !== undefined || assertion.approvedLayoutElementId ? ['color'] : []), ...(assertion.alphaMin !== undefined || assertion.approvedLayoutElementId ? ['alpha'] : []), ...(assertion.shadow !== undefined || assertion.approvedLayoutElementId ? ['shadow'] : [])]
      if (!fields || required.some((field) => !fields.has(field))) return { ok: false, detail: 'Observer V2 hudTrace capability is missing a required field.' }
    }
    if (assertion.type === 'snapshot_relation') {
      const operands = assertion.left && assertion.right ? [assertion.left, assertion.right] : [{ source: assertion.source, pointer: assertion.pointer }]
      for (const operand of operands) {
        if (!['player', 'serverPlayer', 'screen'].includes(operand.source)) continue
        const missing = requireSnapshotField(operand.source, operand.pointer, index)
        if (missing) return { ok: false, detail: missing }
      }
    }
  }
  return { ok: true }
}

function hasObjectiveContract(spec: ReturnType<typeof getGameTestSpec>): boolean {
  return Boolean(spec?.acceptanceContract?.requirements.some((requirement) => requirement.oracle.type === 'game_assertion'))
}

function evidence(assertion: GameAssertion, passed: boolean, detail: string, data?: Record<string, unknown>, unavailable = false): GameTestEvidence {
  return { assertion, passed, detail, data, unavailable, observedAt: Date.now() }
}

function inventoryEntries(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const inventory = asRecord(data.inventory)
  return ['hotbar', 'main', 'armor', 'offhand']
    .flatMap((key) => Array.isArray(inventory[key]) ? inventory[key] as Record<string, unknown>[] : [])
}

function freshTraceEntries(data: Record<string, unknown>, key: 'renderTrace' | 'hudTrace' | 'combatTrace', beforeData?: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const trace = Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : undefined
  if (!trace || !beforeData) return trace
  const cursor = traceCursor(beforeData, key)
  if (cursor > 0 && trace.some((entry) => Number(entry.sequence || 0) > 0)) return trace.filter((entry) => Number(entry.sequence || 0) > cursor)
  const threshold = Number(beforeData.observedAt || 0)
  return threshold > 0 ? trace.filter((entry) => Number(entry.observedAt || 0) > threshold) : trace
}

function normalizedInventory(data: Record<string, unknown>, source = 'player'): string {
  const sourceRecord = asRecord(data[source])
  const inventory = asRecord(sourceRecord.inventory || data.inventory)
  const flat = Array.isArray(sourceRecord.inventory) ? sourceRecord.inventory as Record<string, unknown>[] : Array.isArray(data.inventory) ? data.inventory as Record<string, unknown>[] : []
  const rows = (flat.length ? flat : ['hotbar', 'main', 'armor', 'offhand'].flatMap((key) => Array.isArray(inventory[key]) ? inventory[key] as Record<string, unknown>[] : []))
    .map((entry) => ({ slot: Number(entry.slot ?? entry.index ?? -1), id: String(entry.id || entry.itemId || ''), count: Number(entry.count || 0), components: entry.components || entry.componentFingerprint || undefined }))
    .sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id))
  const selectedSlot = sourceRecord.selectedSlot ?? inventory.selectedSlot ?? asRecord(data.player).selectedSlot ?? -1
  return JSON.stringify({ selectedSlot: Number(selectedSlot), rows })
}

function normalizedPlayerState(data: Record<string, unknown>, source: string): string {
  const player = asRecord(data[source])
  return JSON.stringify({ x: Number(player.x), y: Number(player.y), z: Number(player.z), health: Number(player.health), hunger: Number(player.hunger ?? player.food), saturation: Number(player.saturation), selectedSlot: Number(player.selectedSlot ?? -1), dimension: String(player.dimension || ''), inventory: normalizedInventory(data, source) })
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function numericRelation(left: unknown, right: unknown, operator: string, expected: unknown, tolerance = 0.01, ratio?: number): boolean {
  const l = Number(left)
  const r = Number(right)
  if (!Number.isFinite(l) || !Number.isFinite(r)) return false
  if (operator === 'equals') return Math.abs(l - r) <= tolerance
  if (operator === 'not_equals') return Math.abs(l - r) > tolerance
  if (operator === 'approximately') return Math.abs(l - r) <= tolerance
  const target = Number(ratio ?? expected)
  return Number.isFinite(target) && Math.abs((l === 0 ? Number.POSITIVE_INFINITY : r / l) - target) <= tolerance
}

export function assertionFromSnapshot(
  assertion: GameAssertion,
  data: Record<string, unknown>,
  beforeData?: Record<string, unknown>,
  checkpoints: Record<string, Record<string, unknown>> = {},
  approvedLayout?: ReturnType<typeof getApprovedLayoutRecord>
): GameTestEvidence {
  if (assertion.type === 'inventory_contains') {
    const count = inventoryEntries(data)
      .filter((entry) => entry.id === assertion.itemId)
      .reduce((sum, entry) => sum + Number(entry.count || 0), 0)
    const min = assertion.countAtLeast ?? 1
    return evidence(assertion, count >= min, `inventory ${assertion.itemId}: ${count}/${min}`, data)
  }
  if (assertion.type === 'main_hand') {
    const player = asRecord(data.player)
    const hand = asRecord(player.mainHand)
    return evidence(assertion, hand.id === assertion.itemId, `main hand: ${String(hand.id || 'empty')}`, data)
  }
  if (assertion.type === 'block_equals') {
    const blocks = Array.isArray(data.blocks) ? data.blocks as Record<string, unknown>[] : []
    const block = blocks.find((entry) => entry.x === assertion.x && entry.y === assertion.y && entry.z === assertion.z)
    return evidence(assertion, block?.blockId === assertion.blockId, `block: ${String(block?.blockId || 'missing')}`, data)
  }
  if (assertion.type === 'entity_exists') {
    const entities = Array.isArray(data.entities) ? data.entities as Record<string, unknown>[] : []
    const exists = entities.some((entry) =>
      (!assertion.entityType || entry.type === assertion.entityType) &&
      (!assertion.tag || (Array.isArray(entry.tags) && entry.tags.includes(assertion.tag)))
    )
    const expected = assertion.exists ?? true
    return evidence(assertion, exists === expected, `matching entities: ${entities.length}; expected ${expected ? 'present' : 'absent'}`, data)
  }
  if (assertion.type === 'screen_matches') {
    const screen = asRecord(data.screen)
    const actual = String(screen.simpleName || screen.className || '')
    return evidence(assertion, actual.toLowerCase().includes(assertion.screenName.toLowerCase()), `screen: ${actual || 'in_game'}`, data)
  }
  if (assertion.type === 'widget_state') {
    const widgets = Array.isArray(data.widgets) ? data.widgets as Record<string, unknown>[] : []
    const widget = widgets.find((entry) => String(entry.message || '').includes(assertion.label))
    const enabled = assertion.enabled === undefined || widget?.active === assertion.enabled
    const text = assertion.labelText === undefined || String(widget?.message || '').includes(assertion.labelText)
    return evidence(assertion, Boolean(widget) && enabled && text, `widget ${assertion.label}: ${widget ? 'found' : 'missing'}`, data)
  }
  if (assertion.type === 'player_state') {
    const actual = pathValue(asRecord(data.player), assertion.path)
    return evidence(assertion, JSON.stringify(actual) === JSON.stringify(assertion.equals), `player ${assertion.path}: ${JSON.stringify(actual)}`, data)
  }
  if (assertion.type === 'recipe_exists') {
    if (data.recipeQuerySupported !== true) {
      return evidence(assertion, false, 'recipe query is unavailable in this bridge version', data, true)
    }
    const recipes = Array.isArray(data.recipes) ? data.recipes : []
    return evidence(assertion, recipes.includes(assertion.recipeId), `recipe ${assertion.recipeId}: ${recipes.includes(assertion.recipeId) ? 'found' : 'missing'}`, data)
  }
  if (assertion.type === 'state_changed') {
    const before = pathValue(beforeData || {}, assertion.path)
    const after = pathValue(data, assertion.path)
    return evidence(assertion, stateTransitionMatches(assertion, before, after), `state ${assertion.path}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, data)
  }
  if (assertion.type === 'snapshot_value') {
    const source = snapshotSource(data, assertion.source)
    if (source === undefined) return evidence(assertion, false, `snapshot source ${assertion.source} is unavailable`, data, true)
    const actual = pointerValue(source, assertion.pointer)
    return evidence(assertion, JSON.stringify(actual) === JSON.stringify(assertion.equals), `${assertion.source}${assertion.pointer}: ${JSON.stringify(actual)}`, data)
  }
  if (assertion.type === 'snapshot_changed') {
    const source = snapshotSource(data, assertion.source)
    const beforeSource = snapshotSource(beforeData || {}, assertion.source)
    if (source === undefined || beforeSource === undefined) return evidence(assertion, false, `snapshot source ${assertion.source} is unavailable`, data, true)
    const before = pointerValue(beforeSource, assertion.pointer)
    const after = pointerValue(source, assertion.pointer)
    return evidence(assertion, stateTransitionMatches(assertion, before, after), `${assertion.source}${assertion.pointer}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, data)
  }
  if (assertion.type === 'snapshot_unchanged') {
    const source = snapshotSource(data, assertion.source)
    const beforeSource = snapshotSource(beforeData || {}, assertion.source)
    if (source === undefined || beforeSource === undefined) return evidence(assertion, false, `snapshot source ${assertion.source} is unavailable`, data, true)
    const before = pointerValue(beforeSource, assertion.pointer)
    const after = pointerValue(source, assertion.pointer)
    return evidence(assertion, JSON.stringify(before) === JSON.stringify(after), `${assertion.source}${assertion.pointer}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, data)
  }
  if (assertion.type === 'snapshot_relation') {
    const leftOperand = assertion.left || { checkpoint: assertion.leftCheckpoint || '', source: assertion.source!, pointer: assertion.pointer! }
    const rightOperand = assertion.right || { checkpoint: assertion.rightCheckpoint || '', source: assertion.source!, pointer: assertion.pointer! }
    const resolvedLeftData = checkpoints[leftOperand.checkpoint]
    const resolvedRightData = checkpoints[rightOperand.checkpoint]
    if (!resolvedLeftData || !resolvedRightData) return evidence(assertion, false, 'checkpoint relation unavailable: ' + leftOperand.checkpoint + ' -> ' + rightOperand.checkpoint, data, true)
    const leftSource = snapshotSource(resolvedLeftData, leftOperand.source)
    const rightSource = snapshotSource(resolvedRightData, rightOperand.source)
    if (leftSource === undefined || rightSource === undefined) return evidence(assertion, false, 'checkpoint relation source unavailable: ' + leftOperand.source + ' -> ' + rightOperand.source, data, true)
    const leftPointerValue = pointerValue(leftSource, leftOperand.pointer)
    const rightPointerValue = pointerValue(rightSource, rightOperand.pointer)
    if (leftPointerValue === undefined || rightPointerValue === undefined) return evidence(assertion, false, 'checkpoint relation field unavailable: ' + leftOperand.pointer + ' -> ' + rightOperand.pointer, data, true)
    const left = assertion.normalizer === 'inventory_v1' ? normalizedInventory(resolvedLeftData, leftOperand.source) : assertion.normalizer === 'player_state_v1' ? normalizedPlayerState(resolvedLeftData, leftOperand.source) : leftPointerValue
    const right = assertion.normalizer === 'inventory_v1' ? normalizedInventory(resolvedRightData, rightOperand.source) : assertion.normalizer === 'player_state_v1' ? normalizedPlayerState(resolvedRightData, rightOperand.source) : rightPointerValue
    const tolerance = assertion.tolerance ?? 0.01
    const passed = assertion.operator === 'equals' || assertion.operator === 'not_equals'
      ? (typeof left === 'number' && typeof right === 'number'
          ? numericRelation(left, right, assertion.operator, assertion.expected, tolerance, assertion.ratio)
          : assertion.operator === 'equals' ? valuesEqual(left, right) : !valuesEqual(left, right))
      : numericRelation(left, right, assertion.operator, assertion.expected, tolerance, assertion.ratio)
    return evidence(assertion, passed, 'relation ' + leftOperand.checkpoint + ':' + leftOperand.source + leftOperand.pointer + ' ' + assertion.operator + ' ' + rightOperand.checkpoint + ':' + rightOperand.source + rightOperand.pointer + ': ' + JSON.stringify(left) + ' vs ' + JSON.stringify(right), data)
  }
  if (assertion.type === 'elapsed_between') {
    const left = checkpoints[assertion.fromCheckpoint]
    const right = checkpoints[assertion.toCheckpoint]
    if (!left || !right) return evidence(assertion, false, 'elapsed checkpoints unavailable: ' + assertion.fromCheckpoint + ' -> ' + assertion.toCheckpoint, data, true)
    const elapsedMs = Number(right.__checkpointMonotonicAt || right.__checkpointObservedAt || 0) - Number(left.__checkpointMonotonicAt || left.__checkpointObservedAt || 0)
    const leftTick = worldTick(left)
    const rightTick = worldTick(right)
    const tickDelta = leftTick !== undefined && rightTick !== undefined ? rightTick - leftTick : undefined
    const passed = (assertion.minMs === undefined || elapsedMs >= assertion.minMs) &&
      (assertion.maxMs === undefined || elapsedMs <= assertion.maxMs) &&
      (assertion.minWorldTicks === undefined || (tickDelta !== undefined && tickDelta >= assertion.minWorldTicks)) &&
      (assertion.maxWorldTicks === undefined || (tickDelta === undefined ? false : tickDelta <= assertion.maxWorldTicks))
    return evidence(assertion, passed, 'elapsed ' + assertion.fromCheckpoint + '->' + assertion.toCheckpoint + ': ' + elapsedMs + 'ms/' + (tickDelta ?? 'unknown') + ' ticks', data)
  }
  if (assertion.type === 'combat_event') {
    const traceBaseline = assertion.sinceCheckpoint ? checkpoints[assertion.sinceCheckpoint] : beforeData
    const trace = freshTraceEntries(data, 'combatTrace', traceBaseline)
    if (!trace) return evidence(assertion, false, 'combat trace is unavailable in this bridge version', data, true)
    const attackerCheckpoint = assertion.attackerCheckpoint ? checkpoints[assertion.attackerCheckpoint] : undefined
    const attackerSource = attackerCheckpoint ? (snapshotSource(attackerCheckpoint, 'serverPlayer') || snapshotSource(attackerCheckpoint, 'player')) : undefined
    const checkpointAttackerUuid = attackerSource ? String(pointerValue(attackerSource, '/uuid') || '') : ''
    if (assertion.attackerCheckpoint && !checkpointAttackerUuid) {
      return evidence(assertion, false, `combat attacker checkpoint ${assertion.attackerCheckpoint} has no player UUID`, data, true)
    }
    const found = trace.some((entry) => {
      const tags = Array.isArray(entry.victimTags) ? entry.victimTags.map(String) : []
      return (!assertion.victimUuid || entry.victimUuid === assertion.victimUuid) &&
        (!assertion.victimType || entry.victimType === assertion.victimType) &&
        (!assertion.victimName || String(entry.victimName || '').includes(assertion.victimName)) &&
        (!assertion.victimTag || tags.includes(assertion.victimTag)) &&
        (!assertion.attackerUuid || entry.attackerUuid === assertion.attackerUuid) &&
        (!checkpointAttackerUuid || entry.attackerUuid === checkpointAttackerUuid) &&
        (assertion.attackerIsPlayer === undefined || entry.attackerIsPlayer === assertion.attackerIsPlayer) &&
        (!assertion.damageType || String(entry.damageType || '').includes(assertion.damageType)) &&
        (assertion.killed === undefined || entry.killed === assertion.killed)
    })
    const expected = assertion.exists ?? true
    return evidence(assertion, found === expected, 'combat trace matching entries: ' + trace.length + '; expected ' + (expected ? 'present' : 'absent'), data)
  }
  if (assertion.type === 'render_trace') {
    const trace = freshTraceEntries(data, 'renderTrace', beforeData)
    if (!trace) return evidence(assertion, false, 'render trace is unavailable in this bridge version', data, true)
    const found = trace.some((entry) =>
      (!assertion.entityUuid || entry.entityUuid === assertion.entityUuid) &&
      (!assertion.entityType || entry.entityType === assertion.entityType) &&
      (!assertion.rendererClass || String(entry.rendererClass || '').includes(assertion.rendererClass)) &&
      (!assertion.modelClass || String(entry.modelClass || '').includes(assertion.modelClass)) &&
      (!assertion.textureId || String(entry.textureId || '').includes(assertion.textureId))
    )
    return evidence(assertion, found, `render trace matching entries: ${trace.length}`, data)
  }
  if (assertion.type === 'hud_text') {
    const trace = freshTraceEntries(data, 'hudTrace', beforeData)
    if (!trace) return evidence(assertion, false, 'HUD text trace is unavailable in this bridge version', data, true)
    const match = assertion.match || 'contains'
    const position = assertion.position
    // A named checkpoint is a historical observation.  Compare trace age to
    // that checkpoint's host observation time instead of the end of the whole
    // scenario; otherwise a valid H1/H2 draw would look stale after H3/H4 and
    // deterministic lifecycle assertions could never pass.
    const checkpointObservation = assertion.checkpoint ? checkpoints[assertion.checkpoint] : undefined
    const referenceNow = checkpointObservation
      ? Number(checkpointObservation.__checkpointObservedAt || checkpointObservation.observedAt || Date.now())
      : Date.now()
    const found = trace.some((entry) => {
      const textMatches = match === 'exact' ? entry.text === assertion.text : String(entry.text || '').includes(assertion.text)
      const x = Number(entry.x)
      const y = Number(entry.y)
      const positionMatches = !position || (
        (position.xMin === undefined || x >= position.xMin) &&
        (position.xMax === undefined || x <= position.xMax) &&
        (position.yMin === undefined || y >= position.yMin) &&
        (position.yMax === undefined || y <= position.yMax)
      )
      const normalized = assertion.normalizedPosition
      const normalizedMatches = !normalized || (
        (normalized.xMin === undefined || Number(entry.normalizedX) >= normalized.xMin) &&
        (normalized.xMax === undefined || Number(entry.normalizedX) <= normalized.xMax) &&
        (normalized.yMin === undefined || Number(entry.normalizedY) >= normalized.yMin) &&
        (normalized.yMax === undefined || Number(entry.normalizedY) <= normalized.yMax)
      )
      const colorMatches = assertion.color === undefined || Number(entry.color) === assertion.color
      const alphaMatches = assertion.alphaMin === undefined || Number(entry.alpha) >= assertion.alphaMin
      const shadowMatches = assertion.shadow === undefined || Boolean(entry.shadow) === assertion.shadow
      const approved = assertion.approvedLayoutElementId && approvedLayout
      const approvedElement = assertion.approvedLayoutElementId && approved ? approved.elements.find((element) => element.id === assertion.approvedLayoutElementId) : undefined
      const approvedMatches = !assertion.approvedLayoutElementId || Boolean(approvedElement &&
        Math.abs(Number(entry.normalizedX || 0) - Number(approvedElement.x || 0)) <= 0.03 &&
        Math.abs(Number(entry.normalizedY || 0) - Number(approvedElement.y || 0)) <= 0.03 &&
        (approvedElement.color === undefined || Number(entry.color) === approvedElement.color) &&
        (approvedElement.alpha === undefined || Number(entry.alpha) >= approvedElement.alpha) &&
        (approvedElement.shadow === undefined || Boolean(entry.shadow) === approvedElement.shadow))
      const tokenMatches = !assertion.token || String(entry.text || '').includes(assertion.token)
      const attackerCheckpoint = assertion.attackerCheckpoint ? checkpoints[assertion.attackerCheckpoint] : undefined
      const attackerSource = attackerCheckpoint ? (snapshotSource(attackerCheckpoint, 'serverPlayer') || snapshotSource(attackerCheckpoint, 'player')) : undefined
      const attackerName = attackerSource ? String(pointerValue(attackerSource, '/name') || '') : ''
      const semanticMatches = !assertion.requireAttackerVictimSemantics || Boolean(attackerName && assertion.token && String(entry.text || '').includes(attackerName) && String(entry.text || '').includes(assertion.token))
      const traceAge = referenceNow - Number(entry.observedAt)
      const ageMatches = assertion.maxAgeMs === undefined || (Number(entry.observedAt) > 0 && traceAge >= -50 && traceAge <= assertion.maxAgeMs)
      return textMatches && positionMatches && normalizedMatches && colorMatches && alphaMatches && shadowMatches && approvedMatches && tokenMatches && semanticMatches && ageMatches
    })
    const expected = assertion.exists ?? true
    const passed = expected ? found : !found
    return evidence(assertion, passed, `HUD text ${JSON.stringify(assertion.text)}: ${found ? 'found' : 'missing'}; expected ${expected ? 'present' : 'absent'}`, data)
  }
  return evidence(assertion, false, 'unsupported snapshot assertion', data)
}

async function evaluateAssertion(
  assertion: GameAssertion,
  instanceId: string | undefined,
  observedSnapshot?: BridgeCallResult,
  beforeSnapshot?: BridgeCallResult,
  checkpoints: Record<string, Record<string, unknown>> = {},
  approvedLayout?: ReturnType<typeof getApprovedLayoutRecord>
): Promise<GameTestEvidence> {
  if (assertion.type === 'command_result') {
    const result = await callMcBridge('POST', '/v2/command', { command: assertion.command }, instanceId)
    if (!result.ok) return evidence(assertion, false, `command result unavailable: ${resultText(result)}`, result.data, true)
    const returnValue = Number(result.data.result ?? -1)
    const minimum = assertion.minResult ?? 1
    return evidence(assertion, result.ok && result.data.executed === true && returnValue >= minimum, `command result: ${returnValue}/${minimum}; ${resultText(result)}`, result.data)
  }
  const shot = observedSnapshot || await snapshot(instanceId)
	if (!shot.ok) return evidence(assertion, false, `snapshot unavailable: ${resultText(shot)}`, shot.data, true)
  const traceBaseline = assertion.type === 'hud_text' && assertion.sinceCheckpoint ? checkpoints[assertion.sinceCheckpoint] : beforeSnapshot?.data
  return assertionFromSnapshot(assertion, shot.data, traceBaseline, checkpoints, approvedLayout)
}

export function verdictFor(evidenceRows: GameTestEvidence[], visualOnly: boolean): { verdict: GameTestVerdict; reason?: string } {
	if (visualOnly) return { verdict: 'INCONCLUSIVE', reason: '该场景标记为纯视觉验收；客观断言与视觉审核必须分离。' }
  if (evidenceRows.length === 0) return { verdict: 'INCONCLUSIVE', reason: '没有可消费的新断言证据。' }
  if (evidenceRows.some((row) => row.unavailable)) {
    return { verdict: 'INCONCLUSIVE', reason: evidenceRows.filter((row) => row.unavailable).map((row) => row.detail).join('; ') }
  }
  return evidenceRows.every((row) => row.passed)
    ? { verdict: 'PASS' }
    : { verdict: 'FAIL', reason: evidenceRows.filter((row) => !row.passed).map((row) => row.detail).join('; ') }
}

async function persistReport(session: GameTestSession, spec: ReturnType<typeof getGameTestSpec>): Promise<void> {
  if (!spec || typeof window === 'undefined' || !window.api?.saveGameTestReport) return
  try {
    await window.api.saveGameTestReport({ session, spec })
  } catch {
    // Local report persistence must never change the test verdict.
  }
}

export const mcRunTestTool: Tool = {
  name: 'mc_run_test',
  description: '执行 V2 确定性游戏测试会话。仅 scenarioId 对应的结构化断言全部通过才返回 PASS；环境/桥接/视觉证据不足返回 INCONCLUSIVE。',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenarioId: { type: 'string', minLength: 1 },
      instanceId: { type: 'string' }
    },
    required: ['scenarioId']
  },
  readOnly: () => false,
  async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
    const scenarioId = String(args.scenarioId || '')
    const instanceId = typeof args.instanceId === 'string' ? args.instanceId : undefined
    const spec = getGameTestSpec(scenarioId)
    if (!spec) {
      const session = createInconclusiveSession(scenarioId, `Scenario ${scenarioId} is unavailable after session restore; regenerate it with mc_test_scenario.`, { code: 'SPEC_INVALID_ASSERTION', responsibility: 'agent_test_design' })
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }
    if (!spec.acceptanceContract || spec.acceptanceContract.requirements.length === 0) {
      const session = inconclusiveFor(spec, scenarioId, 'Scenario has no valid AcceptanceContract; rebuild it with requirement-level objective game_assertions before execution.', 'SPEC_NO_ASSERTIONS', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }
    if (!hasObjectiveContract(spec) && !spec.visualOnly) {
      const session = inconclusiveFor(spec, scenarioId, 'Automated game tests require at least one AcceptanceContract game_assertion; user_confirmation cannot replace an objective oracle.', 'SPEC_NO_ASSERTIONS', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }
    if (spec.assertions.length === 0) {
      const session = inconclusiveFor(spec, scenarioId, 'Scenario contains no objective assertions.', 'SPEC_NO_ASSERTIONS', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }
    if (spec.actions.length === 0) {
      const session = inconclusiveFor(spec, scenarioId, 'Scenario contains no executable actions.', 'SPEC_NO_ACTIONS', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }
    if (spec.visualOnly && hasObjectiveContract(spec)) {
      const session = inconclusiveFor(spec, scenarioId, 'visualOnly=true cannot replace objective game assertions; regenerate an automated scenario or move the visual preference to a separate review.', 'SPEC_INVALID_ASSERTION', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }

    ctx.onProgress?.('确认测试世界与桥接 V2 能力…')
    const worldResult = await mcEnsureTestWorldTool.execute(ctx, instanceId ? { instanceId } : {})
    if (/未进入|失败|Error:/i.test(String(worldResult))) {
      const session = inconclusiveFor(spec, scenarioId, `测试世界未就绪：${String(worldResult)}`, 'WORLD_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }

    const capabilities = await callMcBridge('GET', '/v2/capabilities', undefined, instanceId)
    if (!capabilities.ok || capabilities.data.protocolVersion !== 2) {
      const session = inconclusiveFor(spec, scenarioId, '观测桥未提供 V2 确定性命令/快照能力；保留 V1 操作但禁止弱成功。', 'OBSERVER_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }

    const strictEvidenceRequired = Boolean(
      spec.checkpoints?.length ||
      spec.baselineCheckpoint ||
      spec.variables ||
      (spec.requiredPassCount && spec.requiredPassCount > 1) ||
      spec.assertions.some((assertion) => assertion.type === 'snapshot_relation' || assertion.type === 'elapsed_between' || assertion.type === 'combat_event' || assertion.type === 'hud_text' || ('checkpoint' in assertion))
    )
    if (strictEvidenceRequired && Number(capabilities.data.capabilityRevision || 0) < 4) {
      const session = inconclusiveFor(spec, scenarioId, 'Observer V2 capability revision 4 is required for strict deterministic evidence.', 'TRACE_CAPABILITY_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility } }
    }

    const resolved = resolveVariables(spec, scenarioId)
    const resolvedVariables = resolved.values
    const replayPurpose = resolved.replayPurpose
    const unresolved = unresolvedVariable({ actions: spec.actions, assertions: spec.assertions })
    if (unresolved) {
      const session = inconclusiveFor(spec, scenarioId, `Runtime variable "${unresolved}" was not declared or could not be resolved.`, 'SPEC_RUNTIME_VARIABLE_INVALID', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint, requiredPassCount: session.requiredPassCount, resolvedVariables } }
    }
    const observerSessionId = typeof capabilities.data.observerSessionId === 'string' ? capabilities.data.observerSessionId : undefined
    const runtimeInstance = instanceId && typeof window !== 'undefined' && window.api?.mcGetInstance ? await window.api.mcGetInstance(instanceId) : undefined
    const minecraftProcessId = typeof (runtimeInstance as Record<string, unknown> | undefined)?.pid === 'number' ? String((runtimeInstance as Record<string, unknown>).pid) : undefined
    const capabilityCheck = capabilitySupportsSpec(spec, capabilities.data)
    if (!capabilityCheck.ok) {
      const session = inconclusiveFor(spec, scenarioId, capabilityCheck.detail, 'TRACE_CAPABILITY_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, observerSessionId } }
    }
    if (spec.assertions.some((assertion) => assertion.type === 'hud_text' && assertion.approvedLayoutElementId) &&
      (!spec.approvedLayoutId || !spec.approvedLayoutFingerprint || !getApprovedLayoutRecord(spec.approvedLayoutId, spec.approvedLayoutFingerprint))) {
      const session = inconclusiveFor(spec, scenarioId, 'HUD assertion is not linked to a host-approved layout record.', 'LAYOUT_ORACLE_UNLINKED', 'agent_test_design')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, observerSessionId } }
    }
    if ((spec.checkpoints?.length || spec.variables || spec.requiredPassCount && spec.requiredPassCount > 1) && !observerSessionId) {
      const session = inconclusiveFor(spec, scenarioId, 'Observer V2 did not expose observerSessionId required for strict evidence and independent replay.', 'TRACE_CAPABILITY_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, observerSessionId } }
    }
    if (resolved.independentReplayProven === false) {
      const session = inconclusiveFor(spec, scenarioId, 'Unable to sample a different runtime variant after 10 bounded attempts; independent replay is not proven.', 'INDEPENDENT_REPLAY_NOT_PROVEN', 'environment')
      session.resolvedVariables = resolvedVariables
      session.variantFingerprint = variantFingerprintForSpec(spec, resolvedVariables)
      session.observerSessionId = observerSessionId
      session.actionTimeline = [{ index: -1, type: 'wait', startedAt: session.startedAt, finishedAt: session.finishedAt || session.startedAt, elapsedMs: 0, ok: false, detail: 'variant resampling exhausted before execution' }]
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint, requiredPassCount: session.requiredPassCount, observerSessionId, variantFingerprint: session.variantFingerprint, resolvedVariables, ...(instanceId ? { instanceId } : {}), ...(minecraftProcessId ? { minecraftProcessId } : {}) } }
    }

    const worldSnapshot = await snapshot(instanceId)
    if (!worldSnapshot.ok || worldSnapshot.data.worldName !== GAME_TEST_WORLD) {
	    const actual = String(worldSnapshot.data.worldName || 'unknown')
	    const session = inconclusiveFor(spec, scenarioId, worldSnapshot.ok
	      ? `测试必须在专用世界“${GAME_TEST_WORLD}”执行；当前世界：${actual}`
	      : `测试世界快照不可用：${resultText(worldSnapshot)}`,
	      worldSnapshot.ok ? 'WORLD_UNAVAILABLE' : 'SNAPSHOT_UNAVAILABLE', 'environment')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint } }
    }

    const runtimeState = runtimeStateForSpec(spec)
    spec.runtimeState = runtimeState
    const session: GameTestSession = {
      id: `test_${Date.now().toString(36)}`,
      scenarioId,
      phase: 'preparing',
      startedAt: Date.now(),
      evidence: [],
      replay: 0,
      scenarioRevision: spec.scenarioRevision,
      scenarioFingerprint: spec.scenarioFingerprint || gameTestScenarioFingerprint(spec),
      acceptanceContractFingerprint: spec.acceptanceContractFingerprint || acceptanceContractFingerprint(spec.acceptanceContract),
      requiredPassCount: spec.requiredPassCount,
      supersededScenarioIds: spec.supersededScenarioIds,
      resolvedVariables,
      variantFingerprint: variantFingerprintForSpec(spec, resolvedVariables),
      ...(replayPurpose ? { replayPurpose } : {}),
      observerSessionId,
      ...(windowFingerprint(worldSnapshot.data) ? { windowFingerprint: windowFingerprint(worldSnapshot.data) } : {}),
      checkpoints: {},
      runtimeState,
    actionTimeline: []
    }
    session.monotonicStartedAt = monotonicNow()
    const resolvedAssertions = spec.assertions.map((assertion) => replaceVariables(assertion, resolvedVariables) as GameAssertion)
    let environmentalFailure: string | undefined
    let environmentalCode: GameTestInconclusiveCode = 'SPEC_ACTION_FAILED'
    let environmentalResponsibility: GameTestResponsibility = 'agent_test_design'
    let baselineSnapshot: BridgeCallResult | undefined
    const actionSnapshots = new Map<number, BridgeCallResult>()
    const checkpointSnapshots = new Map<string, Record<string, unknown>>()
    const captureCheckpoint = (name: string | undefined, result: BridgeCallResult): void => {
      if (!name || !result.ok) return
      const observedAt = Date.now()
      const data = snapshotWithCheckpointMeta(result, observedAt)
      checkpointSnapshots.set(name, data)
      session.checkpoints![name] = {
        name,
        observedAt,
        monotonicAt: Number(data.__checkpointMonotonicAt || 0),
        worldTime: worldTick(data),
        snapshot: checkpointSummary(data),
        traceCursors: { hudTrace: traceCursor(data, 'hudTrace'), renderTrace: traceCursor(data, 'renderTrace'), combatTrace: traceCursor(data, 'combatTrace') }
      }
    }
    const runTimedAction = async (action: GameAction, index: number): Promise<{ result: { ok: boolean; detail: string; data?: Record<string, unknown> }; after?: BridgeCallResult }> => {
      const startedAt = Date.now()
      const before = await snapshot(instanceId)
      const beforeTick = before.ok ? worldTick(before.data) : undefined
      const result = await runAction(action, instanceId, resolvedVariables)
      if (result.ok && (action.type === 'kill_player' || action.type === 'respawn')) await sleep(500)
      const after = result.ok ? await snapshot(instanceId) : undefined
      const finishedAt = Date.now()
      const afterTick = after?.ok ? worldTick(after.data) : undefined
      session.actionTimeline!.push({ index, type: action.type, label: action.label, checkpoint: action.checkpoint, startedAt, finishedAt, elapsedMs: Math.max(0, finishedAt - startedAt), beforeWorldTick: beforeTick, afterWorldTick: afterTick, ok: result.ok && Boolean(after?.ok ?? true), detail: result.detail })
      const resolvedAction = replaceVariables(action, resolvedVariables) as GameAction
      if (resolvedAction.type === 'wait' && Number(resolvedAction.ms) >= 60_000 && (afterTick === undefined || beforeTick === undefined || afterTick - beforeTick < 1200)) {
        environmentalCode = 'WORLD_TIME_NOT_ADVANCED'
        environmentalResponsibility = 'environment'
        environmentalFailure = 'world tick did not advance by at least 1200 during the 60 second wait.'
      }
      if (after?.ok) captureCheckpoint(action.checkpoint, after)
      return { result, after }
    }
    try {
      for (let setupIndex = 0; setupIndex < spec.setup.length; setupIndex++) {
        const action = spec.setup[setupIndex]
        const timed = await runTimedAction(action, -setupIndex - 1)
        const result = timed.result
        if (!result.ok) {
          const classified = actionFailureClassification(result)
          environmentalCode = classified.code
          environmentalResponsibility = classified.responsibility
          environmentalFailure = `环境准备失败：${action.label || action.type}：${result.detail}`
          break
        }
      }
      if (!environmentalFailure) {
        baselineSnapshot = await snapshot(instanceId)
        if (baselineSnapshot.ok) captureCheckpoint(spec.baselineCheckpoint, baselineSnapshot)
        if (!baselineSnapshot.ok) {
          environmentalCode = 'SNAPSHOT_UNAVAILABLE'
          environmentalResponsibility = 'environment'
        }
        if (!baselineSnapshot.ok) environmentalFailure = `动作前快照失败：${resultText(baselineSnapshot)}`
      }
      if (!environmentalFailure) {
        session.phase = 'acting'
        for (let index = 0; index < spec.actions.length; index++) {
          const action = spec.actions[index]
          const timed = await runTimedAction(action, index)
          const result = timed.result
          if (!result.ok) {
            const classified = actionFailureClassification(result)
            environmentalCode = classified.code
            environmentalResponsibility = classified.responsibility
            environmentalFailure = `测试动作失败：${action.label || action.type}：${result.detail}`
            break
          }
          const afterAction = timed.after || await snapshot(instanceId)
          if (!afterAction.ok) {
            environmentalCode = 'SNAPSHOT_UNAVAILABLE'
            environmentalResponsibility = 'environment'
          }
          if (!afterAction.ok) { environmentalFailure = `动作后快照失败（actions[${index}]）：${resultText(afterAction)}`; break }
          actionSnapshots.set(index, afterAction)
          if (environmentalFailure) break
        }
      }
      if (!environmentalFailure) {
        session.phase = 'asserting'
        const previousStateSnapshots = new Map<string, BridgeCallResult>()
        for (const assertion of resolvedAssertions) {
          const namedCheckpoint = 'checkpoint' in assertion && typeof assertion.checkpoint === 'string' ? assertion.checkpoint : undefined
          const checkpoint = assertion.type === 'state_changed' || assertion.type === 'player_state' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_unchanged' || assertion.type === 'snapshot_value' || assertion.type === 'render_trace' || assertion.type === 'hud_text' ? assertion.afterAction : undefined
          const observed = namedCheckpoint
            ? { ok: true, data: checkpointSnapshots.get(namedCheckpoint) || {} } as BridgeCallResult
            : checkpoint === undefined
              ? (actionSnapshots.get(spec.actions.length - 1) || baselineSnapshot)
              : actionSnapshots.get(checkpoint)
          const stateKey = assertion.type === 'state_changed' ? assertion.path : assertion.type === 'snapshot_changed' ? `${assertion.source}:${assertion.pointer}` : ''
          const before = (assertion.type === 'state_changed' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_unchanged') && checkpoint !== undefined
            ? (previousStateSnapshots.get(stateKey) || baselineSnapshot)
            : (assertion.type === 'render_trace' || assertion.type === 'hud_text') && checkpoint !== undefined
              ? (checkpoint > 0 ? actionSnapshots.get(checkpoint - 1) : baselineSnapshot)
              : baselineSnapshot
           const row = await evaluateAssertion(assertion, instanceId, observed, before, Object.fromEntries(checkpointSnapshots.entries()), spec.approvedLayoutId ? getApprovedLayoutRecord(spec.approvedLayoutId, spec.approvedLayoutFingerprint) : undefined)
          session.evidence.push(row)
          if ((assertion.type === 'state_changed' || assertion.type === 'snapshot_changed') && checkpoint !== undefined && observed) {
            previousStateSnapshots.set(stateKey, observed)
          }
        }
      }
    } finally {
      session.phase = 'cleaning'
      for (const action of spec.cleanup) await runAction(action, instanceId, resolvedVariables)
    }

    const visualReviewOnly = Boolean(spec.visualOnly) && !hasObjectiveContract(spec)
    const outcome = environmentalFailure
      ? { verdict: 'INCONCLUSIVE' as const, reason: environmentalFailure, code: environmentalCode, responsibility: environmentalResponsibility }
      : verdictFor(session.evidence, visualReviewOnly)
    session.phase = 'finished'
    session.finishedAt = Date.now()
    session.monotonicFinishedAt = monotonicNow()
    session.verdict = outcome.verdict
    session.reason = outcome.reason
    session.runtimeState = runtimeState
    // Keep the exact first failing variant for the mandatory clean replay.
    // A second identical failure promotes that same variant to a product
    // repair diagnostic replay.  A diagnostic PASS is explicitly marked and
    // cleared before a fresh random formal run can be sampled.
    const queuedReplay = failureReplayByScenario.get(scenarioId)
    if (session.verdict === 'FAIL') {
      const failedAssertions = session.evidence.filter((row) => row.passed === false).map((row) => row.assertion)
      session.failureSignature = JSON.stringify({ scenarioId, failedAssertions })
      runtimeState.failureCounts[session.failureSignature] = Math.min(3, Number(runtimeState.failureCounts[session.failureSignature] || 0) + 1)
      failureReplayByScenario.set(scenarioId, {
        values: { ...(session.resolvedVariables || {}) },
        purpose: queuedReplay?.purpose === 'first_failure_replay' ? 'product_diagnostic' : queuedReplay?.purpose || 'first_failure_replay'
      })
      runtimeState.failureReplay = failureReplayByScenario.get(scenarioId)
    } else if (session.verdict === 'PASS' && queuedReplay) {
      if (queuedReplay.purpose === 'product_diagnostic') {
        session.diagnosticReplay = true
      }
      failureReplayByScenario.delete(scenarioId)
      delete runtimeState.failureReplay
    }
    if (session.verdict === 'PASS' && !session.diagnosticReplay && session.requiredPassCount && session.requiredPassCount > 1) {
      const variants = successfulVariantsByScenario.get(scenarioId) || new Set<string>()
      variants.add(session.variantFingerprint || variantFingerprintForSpec(spec, session.resolvedVariables || {}))
      successfulVariantsByScenario.set(scenarioId, variants)
      runtimeState.successfulVariantFingerprints = [...new Set([...runtimeState.successfulVariantFingerprints, session.variantFingerprint || variantFingerprintForSpec(spec, session.resolvedVariables || {})])].slice(-16)
    }
    if (session.verdict === 'PASS' && !session.diagnosticReplay) {
      const identity = {
        ...(session.observerSessionId ? { observerSessionId: session.observerSessionId } : {}),
        ...(session.variantFingerprint ? { variantFingerprint: session.variantFingerprint } : {}),
        ...(minecraftProcessId ? { minecraftProcessId } : {}),
        ...(session.windowFingerprint ? { windowFingerprint: session.windowFingerprint } : {}),
        ...(session.scenarioRevision !== undefined ? { scenarioRevision: session.scenarioRevision } : {}),
        ...(session.scenarioFingerprint ? { scenarioFingerprint: session.scenarioFingerprint } : {}),
        ...(session.acceptanceContractFingerprint ? { acceptanceContractFingerprint: session.acceptanceContractFingerprint } : {}),
        recordedAt: Date.now()
      }
      runtimeState.formalReplayHistory = [...runtimeState.formalReplayHistory, identity].slice(-16)
    }
    if (outcome.verdict === 'INCONCLUSIVE') {
      const visual = visualReviewOnly
      const defaultCode = 'code' in outcome ? outcome.code : undefined
      const defaultResponsibility = 'responsibility' in outcome ? outcome.responsibility : undefined
      session.inconclusiveCode = visual
        ? 'VISUAL_REVIEW_REQUIRED'
        : Boolean(spec.visualOnly)
          ? 'SPEC_INVALID_ASSERTION'
          : session.evidence.some((row) => row.unavailable) ? 'ASSERTION_CAPABILITY_UNAVAILABLE' : defaultCode
      session.responsibility = visual
        ? 'visual_review'
        : Boolean(spec.visualOnly)
          ? 'agent_test_design'
          : session.evidence.some((row) => row.unavailable) ? 'environment' : defaultResponsibility
      session.scenarioRevision = spec.scenarioRevision
      session.scenarioFingerprint = spec.scenarioFingerprint || gameTestScenarioFingerprint(spec)
      session.acceptanceContractFingerprint = spec.acceptanceContractFingerprint || acceptanceContractFingerprint(spec.acceptanceContract)
      session.supersededScenarioIds = spec.supersededScenarioIds
    }
    await persistReport(session, spec)
    const valid = session.verdict === 'PASS'
    return {
      output: JSON.stringify(session, null, 2),
      validation: { kind: 'game', valid, verdict: session.verdict, version: '1.21.4', checkedAt: Date.now(), inconclusiveCode: session.inconclusiveCode, responsibility: session.responsibility, scenarioRevision: session.scenarioRevision, scenarioFingerprint: session.scenarioFingerprint, acceptanceContractFingerprint: session.acceptanceContractFingerprint, requiredPassCount: session.requiredPassCount, observerSessionId: session.observerSessionId, variantFingerprint: session.variantFingerprint, replayPurpose: session.replayPurpose, diagnosticReplay: session.diagnosticReplay, windowFingerprint: session.windowFingerprint, resolvedVariables: session.resolvedVariables, currentCheckpoint: Object.keys(session.checkpoints || {}).at(-1), failureSignature: session.failureSignature, runtimeState: session.runtimeState, ...(instanceId ? { instanceId } : {}), ...(minecraftProcessId ? { minecraftProcessId } : {}) }
    }
  }
}
