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

export type GameAssertion =
  | { type: 'command_result'; command: string; minResult?: number; label?: string }
  | { type: 'inventory_contains'; itemId: string; countAtLeast?: number; label?: string }
  | { type: 'main_hand'; itemId: string; label?: string }
  | { type: 'block_equals'; x: number; y: number; z: number; blockId: string; label?: string }
  | { type: 'entity_exists'; entityType?: string; tag?: string; label?: string }
  | { type: 'screen_matches'; screenName: string; label?: string }
  | { type: 'widget_state'; label: string; enabled?: boolean; labelText?: string }
  | { type: 'player_state'; path: string; equals: unknown; label?: string }
  | { type: 'recipe_exists'; recipeId: string; label?: string }
  | { type: 'state_changed'; path: string; from?: unknown; to?: unknown; label?: string }

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

function normalizeAssertions(value: unknown): GameAssertion[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is GameAssertion => Boolean(item) && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string')
}

/** Creates a V2 scenario only when it has concrete target IDs and assertions. */
export function createGameTestSpec(args: Record<string, unknown>): { ok: true; spec: GameTestSpec } | { ok: false; error: string } {
  const kind = featureType(args.feature_type)
  if (!kind) return { ok: false, error: 'feature_type 必须是六种受支持的游戏功能类型之一。' }

  const subjectId = stringValue(args.subject_id) || stringValue(args.target_id)
  const modId = stringValue(args.mod_id)
  const hotkey = stringValue(args.hotkey)
  if ((kind !== 'hud_gui' && !subjectId) || (kind === 'hud_gui' && !hotkey && !subjectId)) {
    return { ok: false, error: 'V2 测试需要 concrete subject_id（HUD/GUI 可提供 hotkey）；禁止使用占位符。' }
  }
  if ([subjectId, modId, hotkey].filter(Boolean).some((item) => PLACEHOLDER_RE.test(String(item)))) {
    return { ok: false, error: '测试目标包含未替换占位符。请提供实际命名空间 ID、热键或控件标识。' }
  }

  const assertions = normalizeAssertions(args.assertions)
  if (assertions.length === 0) {
    return { ok: false, error: 'V2 测试必须包含至少一条客观 assertions；截图和“命令已发送”不构成断言。' }
  }
  const invalid = assertions.find((assertion) => JSON.stringify(assertion).match(PLACEHOLDER_RE))
  if (invalid) return { ok: false, error: `断言包含未替换占位符：${JSON.stringify(invalid)}` }

  const setup = defaultSetup()
  const actions: GameAction[] = []
  if (kind === 'new_item' || kind === 'player_interaction') {
    actions.push({ type: 'command', command: `give @s ${subjectId} 1`, label: '给予目标物品' })
  } else if (kind === 'new_block') {
    actions.push({ type: 'command', command: `setblock 0 100 4 ${subjectId}`, label: '放置目标方块' })
  } else if (kind === 'entity_behavior') {
    actions.push({ type: 'command', command: `summon ${subjectId} 0 100 4 {Tags:["modcrafting_test"]}`, label: '召唤测试实体' })
    actions.push({ type: 'wait', ms: 500, label: '等待实体初始化' })
  } else if (kind === 'hud_gui' && hotkey) {
    actions.push({ type: 'input', action: 'key_press', args: { key: hotkey }, label: '触发目标界面' })
    actions.push({ type: 'wait', ms: 700, label: '等待界面打开' })
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
    createdAt: Date.now()
  }
  sessions.set(spec.id, spec)
  return { ok: true, spec }
}

export function getGameTestSpec(id: string): GameTestSpec | undefined {
  return sessions.get(id)
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
