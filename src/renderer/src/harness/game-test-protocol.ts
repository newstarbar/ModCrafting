import { legacyAcceptanceContract, type AcceptanceContract } from './acceptance-contract.ts'

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

export type GameAction =
  | { type: 'command'; command: string; label?: string }
  | { type: 'input'; action: string; args?: Record<string, unknown>; label?: string }
  | { type: 'wait'; ms: number; label?: string }

export type SnapshotSource = 'player' | 'serverPlayer' | 'screen' | 'entity' | 'renderTrace' | 'hudTrace'

export type GameAssertion = ({ requirementId?: string } & (
  | { type: 'command_result'; command: string; minResult?: number; label?: string }
  | { type: 'inventory_contains'; itemId: string; countAtLeast?: number; label?: string }
  | { type: 'main_hand'; itemId: string; label?: string }
  | { type: 'block_equals'; x: number; y: number; z: number; blockId: string; label?: string }
  | { type: 'entity_exists'; entityType?: string; tag?: string; exists?: boolean; label?: string }
  | { type: 'screen_matches'; screenName: string; label?: string }
  | { type: 'widget_state'; label: string; enabled?: boolean; labelText?: string }
  | { type: 'player_state'; path: string; equals: unknown; afterAction?: number; label?: string }
  | { type: 'recipe_exists'; recipeId: string; label?: string }
  | { type: 'state_changed'; path: string; from?: unknown; to?: unknown; afterAction?: number; label?: string }
  | { type: 'snapshot_value'; source: SnapshotSource; pointer: string; equals: unknown; afterAction?: number; label?: string }
  | { type: 'snapshot_changed'; source: SnapshotSource; pointer: string; from?: unknown; to?: unknown; afterAction?: number; label?: string }
  | { type: 'render_trace'; entityType?: string; rendererClass?: string; modelClass?: string; textureId?: string; afterAction?: number; label?: string }
  | { type: 'hud_text'; text: string; match?: 'exact' | 'contains'; afterAction?: number; label?: string }
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
  createdAt: number
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
}

export function stateTransitionMatches(assertion: Extract<GameAssertion, { type: 'state_changed' | 'snapshot_changed' }>, before: unknown, after: unknown): boolean {
  const fromMatches = assertion.from === undefined || JSON.stringify(before) === JSON.stringify(assertion.from)
  const toMatches = assertion.to === undefined
    ? JSON.stringify(before) !== JSON.stringify(after)
    : JSON.stringify(after) === JSON.stringify(assertion.to)
  return fromMatches && toMatches
}

const sessions = new Map<string, GameTestSpec>()
let sequence = 0

const PLACEHOLDER_RE = /<[^>]+>|\b(?:modid|item_id|block_id|entity_id|hotkey|widget_index)\b/i

export const GAME_TEST_WORLD = 'ModCrafting Test World'
export const GAME_TEST_REGION = { minX: -16, maxX: 16, minY: 96, maxY: 112, minZ: -16, maxZ: 16 }

function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`
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
  'snapshot_value', 'snapshot_changed', 'render_trace', 'hud_text'
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
      case 'screen_matches': valid = str('screenName'); break
      case 'widget_state': valid = str('label') && (item.enabled === undefined || typeof item.enabled === 'boolean') && (item.labelText === undefined || str('labelText')); break
      case 'player_state': valid = str('path') && Object.prototype.hasOwnProperty.call(item, 'equals') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'recipe_exists': valid = str('recipeId'); break
      case 'state_changed': valid = str('path') &&
        (Object.prototype.hasOwnProperty.call(item, 'from') || Object.prototype.hasOwnProperty.call(item, 'to')) &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_value': valid = str('source') && str('pointer') && String(item.pointer).startsWith('/') && Object.prototype.hasOwnProperty.call(item, 'equals') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'snapshot_changed': valid = str('source') && str('pointer') && String(item.pointer).startsWith('/') &&
        (Object.prototype.hasOwnProperty.call(item, 'from') || Object.prototype.hasOwnProperty.call(item, 'to')) &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'render_trace': valid = (str('entityType') || str('rendererClass') || str('modelClass') || str('textureId')) &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
      case 'hud_text': valid = str('text') && (item.match === undefined || item.match === 'exact' || item.match === 'contains') &&
        (item.afterAction === undefined || (Number.isInteger(item.afterAction) && Number(item.afterAction) >= 0)); break
    }
    if (!valid) return { ok: false, error: `${path} has incomplete or invalid ${type} fields.` }
    if (PLACEHOLDER_RE.test(JSON.stringify(item))) return { ok: false, error: `${path} contains an unresolved placeholder.` }
    assertions.push(item as GameAssertion)
  }
  return { ok: true, assertions }
}

function validateActions(value: unknown, path: string): { ok: true; actions: GameAction[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, actions: [] }
  if (!Array.isArray(value)) return { ok: false, error: `${path} must be an action array.` }
  const actions: GameAction[] = []
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index])
    const itemPath = `${path}[${index}]`
    if (!item || !nonEmptyString(item.type)) return { ok: false, error: `${itemPath}.type must be command, input, or wait.` }
    if (item.type === 'command' && nonEmptyString(item.command)) actions.push({ type: 'command', command: item.command, ...(nonEmptyString(item.label) ? { label: item.label } : {}) })
    else if (item.type === 'input' && nonEmptyString(item.action)) {
      const action = item.action === 'key' ? 'key_press' : item.action
      const allowed = new Set(['click_at', 'click_widget', 'set_text', 'key_press', 'key_down', 'key_up', 'mouse_click', 'mouse_move', 'scroll', 'forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint', 'use', 'attack', 'inventory', 'drop', 'swap_hands'])
      if (!allowed.has(action)) return { ok: false, error: `${itemPath}.action is unsupported; use a concrete mc_input action such as key_press.` }
      const actionArgs = record(item.args) || {}
      if ((action === 'key_press' || action === 'key_down' || action === 'key_up') && !nonEmptyString(actionArgs.key)) {
        return { ok: false, error: `${itemPath}.args.key is required for ${action}.` }
      }
      actions.push({ type: 'input', action, ...(Object.keys(actionArgs).length ? { args: actionArgs } : {}), ...(nonEmptyString(item.label) ? { label: item.label } : {}) })
    }
    else if (item.type === 'wait' && numberValue(item.ms)) actions.push({ type: 'wait', ms: item.ms, ...(nonEmptyString(item.label) ? { label: item.label } : {}) })
    else return { ok: false, error: `${itemPath} has incomplete action fields.` }
  }
  return { ok: true, actions }
}

function validateAssertionTimeline(actions: GameAction[], assertions: GameAssertion[]): { ok: true } | { ok: false; error: string } {
  const terminalTargets = new Map<string, Set<string>>()
  for (let index = 0; index < assertions.length; index++) {
    const assertion = assertions[index]
    const afterAction = assertion.type === 'state_changed' || assertion.type === 'player_state' || assertion.type === 'snapshot_changed' || assertion.type === 'snapshot_value' || assertion.type === 'render_trace' || assertion.type === 'hud_text' ? assertion.afterAction : undefined
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
    ...(args.acceptanceContract && typeof args.acceptanceContract === 'object' ? { acceptanceContract: args.acceptanceContract as AcceptanceContract } : {}),
    createdAt: Date.now()
  }
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
  if (!setup.ok) return setup
  if (!actions.ok) return actions
  if (!cleanup.ok) return cleanup
  const timeline = validateAssertionTimeline(actions.actions, asserted.assertions)
  if (!timeline.ok) return timeline
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
    acceptanceContract: raw.acceptanceContract && typeof raw.acceptanceContract === 'object'
      ? raw.acceptanceContract as AcceptanceContract
      : legacyAcceptanceContract(asserted.assertions, Boolean(raw.visualOnly)),
    createdAt: numberValue(raw.createdAt) ? raw.createdAt : Date.now()
  }
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
    '执行方式：调用 mc_run_test({"scenarioId":"' + spec.id + '"})。',
    '```json',
    JSON.stringify(spec, null, 2),
    '```'
  ].join('\n')
}

export function createInconclusiveSession(scenarioId: string, reason: string): GameTestSession {
  const now = Date.now()
  return { id: nextId('test'), scenarioId, phase: 'finished', startedAt: now, finishedAt: now, verdict: 'INCONCLUSIVE', evidence: [], reason, replay: 0 }
}
