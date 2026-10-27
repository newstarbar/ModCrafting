import { z } from 'zod'
import { templateSchemas, type FormField } from './template-schemas.ts'
import { voxelDslSchema } from './voxel-dsl.ts'
import { baseTextureSize, entityAppearanceSchema, newEntityAppearance } from './entity-appearance.ts'

export const contentKinds = ['item', 'food', 'block', 'entity', 'tool', 'armor'] as const
export type ContentKind = typeof contentKinds[number]
export type ContentField = FormField & { unit?: string; step?: number; hint?: string }
const old = (kind: ContentKind, key: string): ContentField => ({ ...templateSchemas['custom-' + kind].fields.find(field => field.key === key)! })
const number = (key: string, label: string, defaultValue: number, min: number, max: number, unit: string, step = 1, hint = ''): ContentField => ({ key, label, type: 'number', defaultValue, min, max, unit, step, hint })
const select = (key: string, label: string, defaultValue: string, values: [string, string][]): ContentField => ({ key, label, type: 'select', defaultValue, options: values.map(([value, label]) => ({ value, label })) })
const stack = () => ({ ...old('item', 'maxStackSize'), label: '最大堆叠', unit: '个', step: 1 })
export const contentForms: Record<ContentKind, { title: string; icon: string; texture: string; hint: string; fields: ContentField[] }> = {
  item: { title: '物品', icon: '◆', texture: 'minecraft:item/iron_ingot', hint: '耐久为 0 表示不可损耗；有耐久的物品必须单件堆叠。特殊事件由 Agent 编写。', fields: [stack(), number('durability', '最大耐久', 0, 0, 10000, '次')] },
  food: { title: '食物', icon: '●', texture: 'minecraft:item/apple', hint: '饱和度为恢复倍率；效果固定持续 30 秒、等级 I。肉类标签和自定义效果由 Agent 编辑。', fields: [stack(), { ...old('food', 'hunger'), min: 0, unit: '饥饿点', step: 1 }, { ...old('food', 'saturation'), unit: '倍率', step: 0.1 }, { key: 'alwaysEdible', label: '饱食时也可食用', type: 'checkbox', defaultValue: false }, { ...old('food', 'effect'), allowCustom: false }] },
  block: { title: '方块', icon: '▣', texture: 'minecraft:block/stone', hint: '硬度 −1 表示不可破坏；爆炸抗性不是挖掘时间。声音材质决定音效，外观由纹理决定。自定义行为、形状与 BlockEntity 由 Agent 实现。', fields: [{ ...old('block', 'hardness'), min: -1, max: 1000, unit: '硬度', step: 0.1 }, { ...old('block', 'resistance'), max: 3600000, unit: '抗性', step: 0.1 }, number('luminance', '发光强度', 0, 0, 15, '级'), { ...old('block', 'materialStyle'), label: '声音材质', allowCustom: false }] },
  entity: { title: '生物', icon: '♟', texture: 'minecraft:entity/pig/pig', hint: '在页面绘制基型皮肤，或切换到自定义方块模型编辑身体、头、腿等部件；碰撞尺寸、复杂 AI 和特殊动画仍交给 Agent。', fields: [select('baseEntity', '原版基型', 'pig', [['pig', '猪（被动）'], ['zombie', '僵尸（敌对）']]), { ...old('entity', 'health'), unit: '生命点', step: 1 }, number('movementSpeed', '移动速度属性', 0.25, 0, 2, '属性值', 0.01), number('attackDamage', '攻击伤害属性', 3, 0, 2048, '伤害点', 0.5)] },
  tool: { title: '工具', icon: '⚒', texture: 'minecraft:item/iron_pickaxe', hint: '攻击伤害为额外基础值（不含玩家自身 1 点）；攻击速度为相对玩家 4 次/秒的修正。采集等级沿用所选材质。', fields: [{ ...old('tool', 'toolType'), allowCustom: false }, { ...old('tool', 'material'), allowCustom: false }, { ...old('tool', 'durability'), unit: '次', step: 1 }, number('miningSpeed', '挖掘速度', 6, 0.1, 128, '倍率', 0.1), number('attackDamage', '攻击伤害', 2, 0, 1000, '额外点', 0.5), number('attackSpeed', '攻击速度修正', -2.8, -3.9, 20, '次/秒', 0.1)] },
  armor: { title: '护甲', icon: '⬟', texture: 'minecraft:item/iron_chestplate', hint: '防护值直接生成护甲属性；穿戴外观与修复材料沿用所选原版材质，物品图标由关联纹理决定。整套请分别创建四个部位。', fields: [{ ...old('armor', 'armorType'), allowCustom: false, options: old('armor', 'armorType').options!.filter(option => option.value !== 'full_set') }, { ...old('armor', 'material'), allowCustom: false }, { ...old('armor', 'protection'), min: 0, unit: '护甲点', step: 1 }, number('durability', '最大耐久', 240, 1, 10000, '次'), number('toughness', '护甲韧性', 0, 0, 20, '点', 0.5), number('knockbackResistance', '击退抗性', 0, 0, 1, '比例', 0.1)] }
}
const resource = /^[a-z0-9_.-]+:[a-z0-9_/-]+$/
export const contentObjectSchema = z.object({
  kind: z.enum(contentKinds), id: z.string().regex(/^[a-z0-9_-]+:[a-z][a-z0-9_]{0,47}$/), displayName: z.string().trim().min(1).max(80),
  texture: z.string().regex(resource), parameters: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  voxel: voxelDslSchema.optional(),
  appearance: entityAppearanceSchema.optional()
}).strict().superRefine((value, context) => {
  const fields = contentForms[value.kind].fields
  for (const field of fields) {
    const raw = value.parameters[field.key]
    let error = ''
    if (field.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < field.min! || raw > field.max! || (field.step ?? 1) === 1 && !Number.isInteger(raw)) error = `${field.label}需要 ${field.min}～${field.max}${(field.step ?? 1) === 1 ? ' 的整数' : ''}`
    } else if (field.type === 'checkbox' ? typeof raw !== 'boolean' : !field.options?.some(option => option.value === raw)) error = `${field.label}不是受支持的选项`
    if (error) context.addIssue({ code: 'custom', path: ['parameters', field.key], message: error })
  }
  for (const key of Object.keys(value.parameters)) if (!fields.some(field => field.key === key)) context.addIssue({ code: 'custom', path: ['parameters', key], message: `当前类型不支持参数 ${key}` })
  if (value.kind === 'item' && Number(value.parameters.durability) > 0 && value.parameters.maxStackSize !== 1) context.addIssue({ code: 'custom', path: ['parameters', 'maxStackSize'], message: '有耐久的物品最大堆叠必须为 1' })
  if (value.kind === 'block' && Number(value.parameters.hardness) < 0 && value.parameters.hardness !== -1) context.addIssue({ code: 'custom', path: ['parameters', 'hardness'], message: '负硬度仅支持 −1（不可破坏）' })
  if (value.texture.split(/[:/]/).some(part => !part || part === '.' || part === '..')) context.addIssue({ code: 'custom', path: ['texture'], message: '纹理引用不允许空段或路径穿越' })
  if (value.voxel && !['block', 'item'].includes(value.kind)) context.addIssue({ code: 'custom', path: ['voxel'], message: '体素模型目前只支持 block 和 item 类型' })
  if (value.appearance && value.kind !== 'entity') context.addIssue({ code: 'custom', path: ['appearance'], message: '只有生物内容支持外观编辑' })
  if (value.kind === 'entity' && value.appearance?.mode === 'base') {
    const expected = baseTextureSize(value.parameters.baseEntity)
    if (value.appearance.textureSize[0] !== expected[0] || value.appearance.textureSize[1] !== expected[1]) context.addIssue({ code: 'custom', path: ['appearance', 'textureSize'], message: `当前基型纹理尺寸应为 ${expected[0]}×${expected[1]}` })
  }
  if (value.kind === 'entity' && value.appearance?.mode === 'custom' && value.texture.startsWith('minecraft:')) context.addIssue({ code: 'custom', path: ['texture'], message: '自定义模型必须使用工程内的 PNG 纹理' })
})
export type ContentObject = z.infer<typeof contentObjectSchema>
export function newContentObject(kind: ContentKind, modId: string): ContentObject {
  const value: ContentObject = { kind, id: `${modId}:new_${kind}`, displayName: `新${contentForms[kind].title}`, texture: contentForms[kind].texture, parameters: Object.fromEntries(contentForms[kind].fields.map(field => [field.key, field.defaultValue!])) }
  if (kind === 'entity') value.appearance = newEntityAppearance(value.parameters.baseEntity)
  return value
}
export type ContentFile = { path: string; before: string | null; after: string; binary?: boolean; size?: number }
export type ContentDocument = { id: string; kind?: ContentKind; value?: ContentObject; editable: boolean; reason?: string; revision: string; files: string[]; image?: string }
