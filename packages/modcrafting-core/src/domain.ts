/** Shared, host-neutral Fabric and Observer V2 contracts. */
import { z } from 'zod'
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
export interface EntityTarget { entityType?: string; name?: string; team?: string }
export type EntityAttributeName = 'health' | 'maxHealth' | 'attackDamage' | 'movementSpeed'
export type GameAssertion =
  | { type: 'inventory_contains'; itemId: string; countAtLeast?: number }
  | { type: 'block_equals'; x: number; y: number; z: number; blockId: string }
  | { type: 'entity_exists'; entityType?: string; tag?: string; exists?: boolean }
  | { type: 'entity_attribute'; target: EntityTarget; attribute: EntityAttributeName; equals?: number; atLeast?: number; atMost?: number }
  | { type: 'entity_name'; target: EntityTarget; contains?: string; equals?: string }
  | { type: 'entity_team'; target: EntityTarget; team: string }
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
  return /^\/v[12]\/(capabilities|command|snapshot|query|inspect|screen|inventory|world|entity|chat|input|screenshot|test-preparation)(?:[/?]|$)/.test(apiPath)
}

export function pointerValue(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) return undefined
  return pointer.slice(1).split('/').reduce<unknown>((current, raw) => {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (['__proto__', 'prototype', 'constructor'].includes(key)) return undefined
    if (Array.isArray(current)) return current[Number(key)]
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, value)
}

const text = z.string().trim().min(1)
const registryId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/)
const label = text.optional()
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), command: text, label }).strict(),
  z.object({ type: z.literal('input'), action: text, args: z.record(z.string(), z.json()).optional(), label }).strict(),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10000), label }).strict()
])
const source = z.enum(['player', 'serverPlayer', 'screen', 'containerSlots', 'entity', 'inventory', 'blocks', 'entities', 'renderTrace', 'hudTrace', 'combatTrace'])
const pointer = text.refine((value) => value.startsWith('/') && !/~(?![01])/.test(value) && !value.slice(1).split('/').some((key) => ['__proto__', 'prototype', 'constructor'].includes(key.replace(/~1/g, '/').replace(/~0/g, '~'))), 'requires a safe JSON pointer')
const entityTarget = z.object({ entityType: registryId.optional(), name: text.optional(), team: text.optional() }).strict().refine((value) => Boolean(value.entityType || value.name || value.team), 'target requires entityType, name or team')
const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inventory_contains'), itemId: registryId, countAtLeast: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal('block_equals'), x: z.number().int(), y: z.number().int(), z: z.number().int(), blockId: registryId }).strict(),
  z.object({ type: z.literal('entity_exists'), entityType: registryId.optional(), tag: text.optional(), exists: z.boolean().optional() }).strict().refine((value) => Boolean(value.entityType || value.tag), 'entity assertion requires type or tag'),
  z.object({ type: z.literal('entity_attribute'), target: entityTarget, attribute: z.enum(['health', 'maxHealth', 'attackDamage', 'movementSpeed']), equals: z.number().optional(), atLeast: z.number().optional(), atMost: z.number().optional() }).strict().refine((value) => value.equals !== undefined || value.atLeast !== undefined || value.atMost !== undefined, 'requires equals, atLeast or atMost'),
  z.object({ type: z.literal('entity_name'), target: entityTarget, contains: text.optional(), equals: text.optional() }).strict().refine((value) => Boolean(value.contains || value.equals), 'entity_name requires contains or equals'),
  z.object({ type: z.literal('entity_team'), target: entityTarget, team: text }).strict(),
  z.object({ type: z.literal('snapshot_value'), source, pointer, equals: z.json() }).strict(),
  z.object({ type: z.literal('snapshot_changed'), source, pointer, from: z.json().optional(), to: z.json().optional() }).strict(),
  z.object({ type: z.literal('hud_text'), text, match: z.enum(['exact', 'contains']).optional() }).strict(),
  z.object({ type: z.literal('command_result'), command: text, minResult: z.number().int().min(0).optional() }).strict()
])
export const gameTestSpecSchema = z.object({
  version: z.literal(2),
  id: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/),
  featureType: z.enum(['new_item', 'new_block', 'new_recipe', 'entity_behavior', 'player_interaction', 'hud_gui']),
  subject: z.object({ modId: text.optional(), id: text.optional(), hotkey: text.optional() }).strict(),
  setup: z.array(actionSchema), actions: z.array(actionSchema).min(1), assertions: z.array(assertionSchema).min(1), cleanup: z.array(actionSchema), visualOnly: z.boolean().optional()
}).strict()

export function validateGameTestSpec(value: unknown): { ok: true; spec: GameTestSpec } | { ok: false; code: 'INVALID_SPEC'; error: string } {
  const parsed = gameTestSpecSchema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'INVALID_SPEC', error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`).join('; ') }
  return { ok: true, spec: parsed.data as GameTestSpec }
}

export function gameTestTemplate(featureType: GameFeatureType = 'new_item'): GameTestSpec {
  return {
    version: 2,
    id: 'my_test',
    featureType,
    subject: {},
    setup: [],
    actions: [{ type: 'wait', ms: 250, label: '等待游戏状态稳定' }],
    assertions: [{ type: 'snapshot_value', source: 'screen', pointer: '/inWorld', equals: true }],
    cleanup: []
  }
}

export const testProfileSchema = z.object({
  version: z.literal(1),
  language: z.enum(['zh_cn', 'en_us']),
  window: z.object({ width: z.number().int().min(800).max(3840), height: z.number().int().min(600).max(2160) }).strict(),
  renderDistance: z.number().int().min(2).max(32),
  maxFps: z.number().int().min(30).max(240),
  volumePercent: z.number().int().min(0).max(100),
  map: z.object({ source: z.enum(['generated', 'save_copy']), terrain: z.enum(['flat', 'normal']), seed: z.string().max(80), sourcePath: z.string().min(1).optional() }).strict().refine((value) => value.source !== 'save_copy' || Boolean(value.sourcePath), 'save_copy requires sourcePath'),
  gameMode: z.enum(['creative', 'survival', 'adventure']),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  allowCommands: z.boolean()
}).strict()
export type TestProfile = z.infer<typeof testProfileSchema>
export const DEFAULT_TEST_PROFILE: TestProfile = {
  version: 1, language: 'zh_cn', window: { width: 1280, height: 720 }, renderDistance: 8, maxFps: 60, volumePercent: 30,
  map: { source: 'generated', terrain: 'flat', seed: '0' }, gameMode: 'creative', difficulty: 'peaceful', allowCommands: true
}
