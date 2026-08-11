import type { Tool, ToolContext, ToolExecutionPayload } from './tools.ts'
import { callMcBridge, mcEnsureTestWorldTool, type BridgeCallResult } from './mc-observer-tools.ts'
import {
  GAME_TEST_WORLD,
  createInconclusiveSession,
  getGameTestSpec,
  stateTransitionMatches,
  type GameAction,
  type GameAssertion,
  type GameTestEvidence,
  type GameTestSession,
  type GameTestVerdict
} from './game-test-protocol.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  const aliases: Record<string, string> = { player: 'player', serverPlayer: 'serverPlayer', screen: 'screen', entity: 'entities', renderTrace: 'renderTrace', hudTrace: 'hudTrace' }
  return data[aliases[source] || source]
}

function resultText(result: BridgeCallResult): string {
  return result.ok ? JSON.stringify(result.data) : String(result.error || result.data.error || 'bridge request failed')
}

async function runAction(action: GameAction, instanceId?: string): Promise<{ ok: boolean; detail: string; data?: Record<string, unknown> }> {
  if (action.type === 'wait') {
    await sleep(Math.max(0, Math.min(action.ms, 10_000)))
    return { ok: true, detail: `waited ${action.ms}ms` }
  }
  if (action.type === 'input') {
    const result = await callMcBridge('POST', '/v1/input', { action: action.action, ...(action.args || {}) }, instanceId)
    return { ok: result.ok, detail: resultText(result), data: result.data }
  }
  const result = await callMcBridge('POST', '/v2/command', { command: action.command }, instanceId)
  const executed = result.data.executed === true
  return { ok: result.ok && executed, detail: resultText(result), data: result.data }
}

async function snapshot(instanceId?: string): Promise<BridgeCallResult> {
  return callMcBridge('POST', '/v2/snapshot', {
    blocks: [{ x: 0, y: 100, z: 4 }],
    entityRadius: 32,
    includeRecipes: true
  }, instanceId)
}

function evidence(assertion: GameAssertion, passed: boolean, detail: string, data?: Record<string, unknown>, unavailable = false): GameTestEvidence {
  return { assertion, passed, detail, data, unavailable, observedAt: Date.now() }
}

function inventoryEntries(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const inventory = asRecord(data.inventory)
  return ['hotbar', 'main', 'armor', 'offhand']
    .flatMap((key) => Array.isArray(inventory[key]) ? inventory[key] as Record<string, unknown>[] : [])
}

function assertionFromSnapshot(assertion: GameAssertion, data: Record<string, unknown>, beforeData?: Record<string, unknown>): GameTestEvidence {
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
  if (assertion.type === 'render_trace') {
    const trace = Array.isArray(data.renderTrace) ? data.renderTrace as Record<string, unknown>[] : undefined
    if (!trace) return evidence(assertion, false, 'render trace is unavailable in this bridge version', data, true)
    const found = trace.some((entry) =>
      (!assertion.entityType || entry.entityType === assertion.entityType) &&
      (!assertion.rendererClass || String(entry.rendererClass || '').includes(assertion.rendererClass)) &&
      (!assertion.modelClass || String(entry.modelClass || '').includes(assertion.modelClass)) &&
      (!assertion.textureId || String(entry.textureId || '').includes(assertion.textureId))
    )
    return evidence(assertion, found, `render trace matching entries: ${trace.length}`, data)
  }
  if (assertion.type === 'hud_text') {
    const trace = Array.isArray(data.hudTrace) ? data.hudTrace as Record<string, unknown>[] : undefined
    if (!trace) return evidence(assertion, false, 'HUD text trace is unavailable in this bridge version', data, true)
    const match = assertion.match || 'contains'
    const found = trace.some((entry) => match === 'exact' ? entry.text === assertion.text : String(entry.text || '').includes(assertion.text))
    return evidence(assertion, found, `HUD text ${JSON.stringify(assertion.text)}: ${found ? 'found' : 'missing'}`, data)
  }
  return evidence(assertion, false, 'unsupported snapshot assertion', data)
}

async function evaluateAssertion(
  assertion: GameAssertion,
  instanceId: string | undefined,
  observedSnapshot?: BridgeCallResult,
  beforeSnapshot?: BridgeCallResult
): Promise<GameTestEvidence> {
  if (assertion.type === 'command_result') {
    const result = await callMcBridge('POST', '/v2/command', { command: assertion.command }, instanceId)
    const returnValue = Number(result.data.result ?? -1)
    const minimum = assertion.minResult ?? 1
    return evidence(assertion, result.ok && result.data.executed === true && returnValue >= minimum, `command result: ${returnValue}/${minimum}; ${resultText(result)}`, result.data)
  }
  const shot = observedSnapshot || await snapshot(instanceId)
  if (!shot.ok) return evidence(assertion, false, `snapshot unavailable: ${resultText(shot)}`, shot.data)
  return assertionFromSnapshot(assertion, shot.data, beforeSnapshot?.data)
}

function verdictFor(evidenceRows: GameTestEvidence[], visualOnly: boolean, requiresUserConfirmation: boolean): { verdict: GameTestVerdict; reason?: string } {
  if (visualOnly || requiresUserConfirmation) return { verdict: 'INCONCLUSIVE', reason: '存在需要用户确认的视觉验收项；截图不能自动判定通过。' }
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
      const session = createInconclusiveSession(scenarioId, `Scenario ${scenarioId} is unavailable after session restore; regenerate it with mc_test_scenario.`)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }
    }

    ctx.onProgress?.('确认测试世界与桥接 V2 能力…')
    const worldResult = await mcEnsureTestWorldTool.execute(ctx, instanceId ? { instanceId } : {})
    if (/未进入|失败|Error:/i.test(String(worldResult))) {
      const session = createInconclusiveSession(scenarioId, `测试世界未就绪：${String(worldResult)}`)
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }
    }

    const capabilities = await callMcBridge('GET', '/v2/capabilities', undefined, instanceId)
    if (!capabilities.ok || capabilities.data.protocolVersion !== 2) {
      const session = createInconclusiveSession(scenarioId, '观测桥未提供 V2 确定性命令/快照能力；保留 V1 操作但禁止弱成功。')
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }
    }

    const worldSnapshot = await snapshot(instanceId)
    if (!worldSnapshot.ok || worldSnapshot.data.worldName !== GAME_TEST_WORLD) {
      const actual = String(worldSnapshot.data.worldName || 'unknown')
      const session = createInconclusiveSession(scenarioId, `测试必须在专用世界“${GAME_TEST_WORLD}”执行；当前世界：${actual}`)
      await persistReport(session, spec)
      return { output: JSON.stringify(session, null, 2), validation: { kind: 'game', valid: false, verdict: 'INCONCLUSIVE', version: '1.21.4', checkedAt: Date.now() } }
    }

    const session: GameTestSession = { id: `test_${Date.now().toString(36)}`, scenarioId, phase: 'preparing', startedAt: Date.now(), evidence: [], replay: 0 }
    let environmentalFailure: string | undefined
    let baselineSnapshot: BridgeCallResult | undefined
    const actionSnapshots = new Map<number, BridgeCallResult>()
    try {
      for (const action of spec.setup) {
        const result = await runAction(action, instanceId)
        if (!result.ok) { environmentalFailure = `环境准备失败：${action.label || action.type}：${result.detail}`; break }
      }
      if (!environmentalFailure) {
        baselineSnapshot = await snapshot(instanceId)
        if (!baselineSnapshot.ok) environmentalFailure = `动作前快照失败：${resultText(baselineSnapshot)}`
      }
      if (!environmentalFailure) {
        session.phase = 'acting'
        for (let index = 0; index < spec.actions.length; index++) {
          const action = spec.actions[index]
          const result = await runAction(action, instanceId)
          if (!result.ok) { environmentalFailure = `测试动作失败：${action.label || action.type}：${result.detail}`; break }
          const afterAction = await snapshot(instanceId)
          if (!afterAction.ok) { environmentalFailure = `动作后快照失败（actions[${index}]）：${resultText(afterAction)}`; break }
          actionSnapshots.set(index, afterAction)
        }
      }
      if (!environmentalFailure) {
        session.phase = 'asserting'
        const previousStateSnapshots = new Map<string, BridgeCallResult>()
        for (const assertion of spec.assertions) {
          const checkpoint = assertion.type === 'state_changed' || assertion.type === 'player_state' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_value' || assertion.type === 'render_trace' || assertion.type === 'hud_text' ? assertion.afterAction : undefined
          const observed = checkpoint === undefined
            ? (actionSnapshots.get(spec.actions.length - 1) || baselineSnapshot)
            : actionSnapshots.get(checkpoint)
          const stateKey = assertion.type === 'state_changed' ? assertion.path : assertion.type === 'snapshot_changed' ? `${assertion.source}:${assertion.pointer}` : ''
          const before = (assertion.type === 'state_changed' || assertion.type === 'snapshot_changed') && checkpoint !== undefined
            ? (previousStateSnapshots.get(stateKey) || baselineSnapshot)
            : baselineSnapshot
          const row = await evaluateAssertion(assertion, instanceId, observed, before)
          session.evidence.push(row)
          if ((assertion.type === 'state_changed' || assertion.type === 'snapshot_changed') && checkpoint !== undefined && observed) {
            previousStateSnapshots.set(stateKey, observed)
          }
        }
      }
    } finally {
      session.phase = 'cleaning'
      for (const action of spec.cleanup) await runAction(action, instanceId)
    }

    const outcome = environmentalFailure
      ? { verdict: 'INCONCLUSIVE' as const, reason: environmentalFailure }
      : verdictFor(session.evidence, Boolean(spec.visualOnly), Boolean(spec.acceptanceContract?.requirements.some((requirement) => requirement.oracle.type === 'user_confirmation')))
    session.phase = 'finished'
    session.finishedAt = Date.now()
    session.verdict = outcome.verdict
    session.reason = outcome.reason
    await persistReport(session, spec)
    const valid = session.verdict === 'PASS'
    return {
      output: JSON.stringify(session, null, 2),
      validation: { kind: 'game', valid, verdict: session.verdict, version: '1.21.4', checkedAt: Date.now() }
    }
  }
}
