import { z } from 'zod'

export const ENTITY_APPEARANCE_VERSION = 1
export const ENTITY_BASE_TEXTURES = { pig: [64, 32], zombie: [64, 64] } as const
export type EntityBase = keyof typeof ENTITY_BASE_TEXTURES
export type EntityTextureSize = [number, number]
export type EntityVector = [number, number, number]
export const entityMotions = ['none', 'walk_left', 'walk_right', 'knee_left', 'knee_right', 'arm_left', 'arm_right'] as const
export type EntityBox = {
  id: string
  name: string
  origin: EntityVector
  size: EntityVector
  pivot: EntityVector
  rotation: EntityVector
  parent?: string
  motion?: typeof entityMotions[number]
  deathRotation?: EntityVector
  mirror?: boolean
}
export type EntityAppearance = {
  version: 1
  mode: 'base' | 'custom'
  textureSize: EntityTextureSize
  boxes: EntityBox[]
}
export type EntityUvRegion = {
  boxId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  u: number
  v: number
}
export type EntitySkinPartId = string
export type EntitySkinPart = {
  id: EntitySkinPartId
  name: string
  x: number
  y: number
  width: number
  height: number
}
const coordinate = z.number().finite().min(-128).max(128)
const triplet = z.tuple([coordinate, coordinate, coordinate])
const positive = z.number().finite().min(1).max(64)
const dimensions = z.tuple([positive, positive, positive])
const rotation = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-180).max(180), z.number().finite().min(-180).max(180)])
const textureSize = z.tuple([z.number().int().min(16).max(512), z.number().int().min(16).max(512)])
export const entityBoxSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  name: z.string().trim().min(1).max(40),
  origin: triplet,
  size: dimensions,
  pivot: triplet,
  rotation,
  parent: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).optional(),
  motion: z.enum(entityMotions).optional(),
  deathRotation: rotation.optional(),
  mirror: z.boolean().optional()
}).strict()
export const entityAppearanceSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['base', 'custom']),
  textureSize,
  boxes: z.array(entityBoxSchema).max(32)
}).strict().superRefine((value, context) => {
  if (value.mode === 'base' && value.boxes.length) context.addIssue({ code: 'custom', path: ['boxes'], message: '基础外观不使用自定义方块部件' })
  if (value.mode === 'custom' && !value.boxes.length) context.addIssue({ code: 'custom', path: ['boxes'], message: '自定义外观至少需要一个方块部件' })
  const ids = new Set<string>()
  for (const box of value.boxes) {
    if (ids.has(box.id)) context.addIssue({ code: 'custom', path: ['boxes'], message: `部件 ID 重复：${box.id}` })
    ids.add(box.id)
  }
  if (value.mode === 'custom') {
    try {
      orderedEntityBoxes(value.boxes as EntityBox[])
      layoutEntityBoxes(value.boxes as EntityBox[], value.textureSize as EntityTextureSize)
    } catch (cause) {
      context.addIssue({ code: 'custom', path: ['boxes'], message: (cause as Error).message })
    }
  }
})

export function baseTextureSize(baseEntity: unknown): EntityTextureSize {
  return [...(ENTITY_BASE_TEXTURES[baseEntity === 'zombie' ? 'zombie' : 'pig'])] as EntityTextureSize
}

// Vanilla zombie skins reuse the right arm/leg UV islands for both sides, so the lower half of the 64×64 texture stays unused.
const ZOMBIE_SKIN_PARTS: readonly EntitySkinPart[] = [
  { id: 'head', name: '头部', x: 0, y: 0, width: 32, height: 16 },
  { id: 'body', name: '躯干', x: 16, y: 16, width: 24, height: 16 },
  { id: 'arm', name: '手臂', x: 40, y: 16, width: 16, height: 16 },
  { id: 'leg', name: '腿部', x: 0, y: 16, width: 16, height: 16 }
]

export function baseSkinParts(baseEntity: unknown): EntitySkinPart[] {
  return baseEntity === 'zombie' ? ZOMBIE_SKIN_PARTS.map(part => ({ ...part })) : []
}

export function newEntityAppearance(baseEntity: unknown): EntityAppearance {
  return { version: ENTITY_APPEARANCE_VERSION, mode: 'base', textureSize: baseTextureSize(baseEntity), boxes: [] }
}

export function defaultEntityBox(index: number): EntityBox {
  return {
    id: `part_${index}`,
    name: `部件 ${index + 1}`,
    origin: [-4, -20, -4],
    size: [8, 8, 8],
    pivot: [0, -16, 0],
    rotation: [0, 0, 0],
    mirror: false
  }
}

export function orderedEntityBoxes(boxes: EntityBox[]): EntityBox[] {
  const byId = new Map(boxes.map(box => [box.id, box]))
  if (byId.size !== boxes.length) throw new Error('部件 ID 不能重复')
  const active = new Set<string>(), done = new Set<string>(), result: EntityBox[] = []
  const visit = (box: EntityBox) => {
    if (done.has(box.id)) return
    if (active.has(box.id)) throw new Error(`父子关节不能循环连接：${box.name}`)
    active.add(box.id)
    if (box.parent) {
      const parent = byId.get(box.parent)
      if (!parent) throw new Error(`部件 ${box.name} 的父级不存在：${box.parent}`)
      visit(parent)
    }
    active.delete(box.id)
    done.add(box.id)
    result.push(box)
  }
  boxes.forEach(visit)
  return result
}

function rotateEntityVector([x, y, z]: EntityVector, degrees: EntityVector): EntityVector {
  const [rx, ry, rz] = degrees.map(value => value * Math.PI / 180)
  const y1 = y * Math.cos(rx) - z * Math.sin(rx), z1 = y * Math.sin(rx) + z * Math.cos(rx)
  const x2 = x * Math.cos(ry) + z1 * Math.sin(ry), z2 = -x * Math.sin(ry) + z1 * Math.cos(ry)
  return [x2 * Math.cos(rz) - y1 * Math.sin(rz), x2 * Math.sin(rz) + y1 * Math.cos(rz), z2]
}

// Authored pivots stay in unposed model space; ModelPart applies local X, then Y, then Z rotation.
export function transformEntityPoint(boxes: EntityBox[], boxId: string, point: EntityVector): EntityVector {
  const byId = new Map(orderedEntityBoxes(boxes).map(box => [box.id, box]))
  let box = byId.get(boxId), result: EntityVector = [...point]
  if (!box) throw new Error(`部件不存在：${boxId}`)
  while (box) {
    const relative = result.map((value, axis) => value - box!.pivot[axis]) as EntityVector
    result = rotateEntityVector(relative, box.rotation).map((value, axis) => value + box!.pivot[axis]) as EntityVector
    box = box.parent ? byId.get(box.parent) : undefined
  }
  return result
}

export function entityBoxMotion(box: EntityBox): NonNullable<EntityBox['motion']> {
  return box.motion ?? (box.id.startsWith('leg_') && !box.parent ? (box.id.includes('right') ? 'walk_right' : 'walk_left') : 'none')
}

export function poseEntityBoxes(boxes: EntityBox[], limbFrequency: number, limbAmplitude: number, deathProgress = 0): EntityBox[] {
  const t = Math.max(0, Math.min(1, deathProgress)), death = t * t * (3 - 2 * t)
  const wave = Math.cos(limbFrequency), amplitude = limbAmplitude * (1 - death)
  return boxes.map(box => {
    const motion = entityBoxMotion(box)
    const angle = motion === 'walk_left' ? wave * 0.7 : motion === 'walk_right' ? -wave * 0.7
      : motion === 'knee_left' ? Math.max(0, -wave) * 0.9 : motion === 'knee_right' ? Math.max(0, wave) * 0.9
        : motion === 'arm_left' ? -wave * 0.35 : motion === 'arm_right' ? wave * 0.35 : 0
    return { ...box, rotation: box.rotation.map((value, axis) => value + (axis === 0 ? angle * amplitude * 180 / Math.PI : 0) + (box.deathRotation?.[axis] ?? 0) * death) as EntityVector }
  })
}

export function articulatedHumanoidBoxes(): EntityBox[] {
  const box = (id: string, name: string, origin: EntityVector, size: EntityVector, pivot: EntityVector, parent?: string, motion: EntityBox['motion'] = 'none'): EntityBox => ({ id, name, origin, size, pivot, rotation: [0, 0, 0], ...(parent ? { parent } : {}), motion })
  return [
    box('pelvis', '骨盆', [-5, -20, -3], [10, 4, 6], [0, -16, 0]),
    box('torso', '躯干 / 腰关节', [-6, -32, -3], [12, 12, 6], [0, -20, 0], 'pelvis'),
    box('head', '头部 / 颈关节', [-4, -40, -4], [8, 8, 8], [0, -32, 0], 'torso'),
    box('arm_left_upper', '左大臂 / 肩关节', [-10, -32, -2], [4, 8, 4], [-6, -30, 0], 'torso', 'arm_left'),
    box('arm_left_lower', '左小臂 / 肘关节', [-10, -24, -2], [4, 8, 4], [-8, -24, 0], 'arm_left_upper'),
    box('arm_right_upper', '右大臂 / 肩关节', [6, -32, -2], [4, 8, 4], [6, -30, 0], 'torso', 'arm_right'),
    box('arm_right_lower', '右小臂 / 肘关节', [6, -24, -2], [4, 8, 4], [8, -24, 0], 'arm_right_upper'),
    box('leg_left_upper', '左大腿 / 髋关节', [-5, -16, -2], [4, 8, 4], [-3, -16, 0], 'pelvis', 'walk_left'),
    box('leg_left_lower', '左小腿 / 膝关节', [-5, -8, -2], [4, 8, 4], [-3, -8, 0], 'leg_left_upper', 'knee_left'),
    box('leg_right_upper', '右大腿 / 髋关节', [1, -16, -2], [4, 8, 4], [3, -16, 0], 'pelvis', 'walk_right'),
    box('leg_right_lower', '右小腿 / 膝关节', [1, -8, -2], [4, 8, 4], [3, -8, 0], 'leg_right_upper', 'knee_right')
  ]
}

/**
 * Minecraft box UV nets are 2*(width+depth) by (height+depth).
 * Pack them into a deterministic square atlas so both the browser and generated Java use the same coordinates.
 */
export function layoutEntityBoxes(boxes: EntityBox[], requested?: EntityTextureSize): { textureSize: EntityTextureSize; regions: EntityUvRegion[] } {
  if (!boxes.length) throw new Error('自定义外观至少需要一个方块部件')
  if (boxes.length > 32) throw new Error('自定义外观最多支持 32 个方块部件')
  const nets = boxes.map((box, index) => {
    const [width, height, depth] = box.size
    const w = Math.ceil(2 * (width + depth))
    const h = Math.ceil(height + depth)
    if (w > 512 || h > 512) throw new Error(`部件 ${box.name} 的 UV 尺寸超过 512，请缩小方块`)
    return { index, box, w, h, x: 2, y: 2 }
  })
  if (requested) {
    const size = Math.max(requested[0], requested[1])
    const packed = pack(nets, size)
    if (!packed) throw new Error(`方块部件无法放入 ${size}×${size} 纹理；请减少部件或缩小尺寸`)
    return { textureSize: [size, size], regions: packed }
  }
  for (const size of [64, 128, 256, 512]) {
    const packed = pack(nets, size)
    if (packed) return { textureSize: [size, size], regions: packed }
  }
  throw new Error('部件过多或尺寸过大，无法放入 512×512 纹理；请减少方块或缩小尺寸')
}

export function customTextureSize(): EntityTextureSize { return [256, 256] }

function pack(nets: Array<{ index: number; box: EntityBox; w: number; h: number; x: number; y: number }>, size: number): EntityUvRegion[] | undefined {
  const gap = 2
  const ordered = [...nets].sort((a, b) => b.h - a.h || a.index - b.index)
  let x = gap, y = gap, rowHeight = 0
  const placed = new Map<number, { x: number; y: number }>()
  for (const net of ordered) {
    if (net.w + gap * 2 > size || net.h + gap * 2 > size) return undefined
    if (x + net.w + gap > size) { x = gap; y += rowHeight + gap; rowHeight = 0 }
    if (y + net.h + gap > size) return undefined
    placed.set(net.index, { x, y })
    x += net.w + gap
    rowHeight = Math.max(rowHeight, net.h)
  }
  return nets.map((net) => {
    const at = placed.get(net.index)!
    return { boxId: net.box.id, name: net.box.name, x: at.x, y: at.y, width: net.w, height: net.h, u: at.x, v: at.y }
  })
}

export function validateEntityTexture(bytes: Buffer, expected: EntityTextureSize): string | undefined {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return '纹理必须是 PNG'
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width !== expected[0] || height !== expected[1]) return `纹理尺寸必须为 ${expected[0]}×${expected[1]}，当前为 ${width}×${height}`
  return undefined
}

export function validatePixelTexture(bytes: Buffer, min = 16, max = 512): string | undefined {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return '纹理必须是 PNG'
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width < min || height < min || width > max || height > max) return `纹理尺寸必须在 ${min}×${min} 到 ${max}×${max} 之间，当前为 ${width}×${height}`
  return undefined
}
