/** Shared, host-neutral Fabric and Observer V2 contracts. */
export const FABRIC_TARGET = {
  minecraft: '1.21.4',
  loader: '0.16.10',
  fabricApi: '0.116.0+1.21.4',
  yarn: '1.21.4+build.1',
  loom: '1.17.12',
  gradle: '9.5.0'
} as const

export const GAME_TEST_WORLD = 'ModCrafting Test World'
export const GAME_TEST_REGION = { minX: -16, maxX: 16, minY: 96, maxY: 112, minZ: -16, maxZ: 16 } as const
export type GameTestVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'
export type GameFeatureType = 'new_item' | 'new_block' | 'new_recipe' | 'entity_behavior' | 'player_interaction' | 'hud_gui'
export type GameAction =
  | { type: 'command'; command: string; label?: string }
  | { type: 'input'; action: string; args?: Record<string, unknown>; label?: string }
  | { type: 'wait'; ms: number; label?: string }
export type GameAssertion =
  | { type: 'inventory_contains'; itemId: string; countAtLeast?: number }
  | { type: 'block_equals'; x: number; y: number; z: number; blockId: string }
  | { type: 'entity_exists'; entityType?: string; tag?: string; exists?: boolean }
  | { type: 'snapshot_value'; source: string; pointer: string; equals: unknown }
  | { type: 'snapshot_changed'; source: string; pointer: string; from?: unknown; to?: unknown }
  | { type: 'hud_text'; text: string; match?: 'exact' | 'contains' }
  | { type: 'command_result'; command: string; minResult?: number }

export interface GameTestSpec {
  version: 2
  id: string
  featureType: GameFeatureType
  subject: { modId?: string; id?: string; hotkey?: string }
  setup: GameAction[]
  actions: GameAction[]
  assertions: GameAssertion[]
  cleanup: GameAction[]
  visualOnly?: boolean
}

export function isAllowedBridgeApiPath(apiPath: string): boolean {
  return /^\/v[12]\/(capabilities|command|snapshot|query|inspect|screen|inventory|world|entity|chat|input|screenshot)(?:[/?]|$)/.test(apiPath)
}

export function pointerValue(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined
  return pointer.slice(1).split('/').reduce<unknown>((current, raw) => {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) return current[Number(key)]
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, value)
}

export function validateGameTestSpec(value: unknown): { ok: true; spec: GameTestSpec } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'game test must be an object' }
  const raw = value as Record<string, unknown>
  const type = raw.featureType
  if (raw.version !== 2 || typeof raw.id !== 'string' || !raw.id.trim()) return { ok: false, error: 'game test requires version=2 and id' }
  if (!['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui'].includes(String(type))) return { ok: false, error: 'unsupported featureType' }
  for (const field of ['setup', 'actions', 'assertions', 'cleanup']) if (!Array.isArray(raw[field])) return { ok: false, error: `game test field ${field} must be an array` }
  if ((raw.assertions as unknown[]).length === 0) return { ok: false, error: 'game test requires at least one assertion' }
  return { ok: true, spec: raw as unknown as GameTestSpec }
}
