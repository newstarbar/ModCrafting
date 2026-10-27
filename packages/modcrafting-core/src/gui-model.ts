import { z } from 'zod'

export const GUI_GRID = 8, GUI_ALIGN_THRESHOLD = 4
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
export const guiTypes = ['label', 'panel', 'image', 'button', 'toggle', 'slider', 'slot'] as const
export const guiTypeLabels = { label: '文字', panel: '面板', image: '图片', button: '按钮', toggle: '开关', slider: '滑块', slot: '展示槽位' }
const elementSchema = z.object({
  id: identifier, type: z.enum(guiTypes), label: z.string().max(80), x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(8).max(640), height: z.number().int().min(8).max(480),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/), alpha: z.number().min(0).max(1), shadow: z.boolean(),
  bind: z.string().max(48), action: z.enum(['increment', 'reset', 'close']), target: z.string().max(48),
  initial: z.number().finite(), checked: z.boolean(), min: z.number().int().min(-10000).max(10000), max: z.number().int().min(-10000).max(10000),
  itemId: z.string().regex(/^[a-z0-9_-]+:[a-z0-9_/-]+$/),
  texture: z.string().regex(/^[a-z0-9_-]+:[a-z0-9_/-]+$/).optional()
}).strict()
export const guiLayoutSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-z0-9_-]+:[a-z][a-z0-9_]{0,47}$/), title: z.string().trim().min(1).max(80),
  layoutType: z.enum(['custom-screen', 'option-list', 'hud-overlay']), width: z.number().int().min(160).max(640), height: z.number().int().min(120).max(480),
  anchor: z.enum(['center', 'top-left', 'top-right', 'bottom-left', 'bottom-right']), keyCode: z.number().int().min(65).max(90), elements: z.array(elementSchema).max(64)
}).strict().superRefine((layout, context) => {
  const seen = new Set<string>()
  layout.elements.forEach((element, index) => {
    const fail = (message: string, field = 'id') => context.addIssue({ code: 'custom', path: ['elements', index, field], message })
    if (seen.has(element.id)) fail('元素 ID 必须唯一'); seen.add(element.id)
    if (element.x + element.width > layout.width || element.y + element.height > layout.height) fail('元素必须位于设计画布内', 'x')
    if (['button', 'toggle', 'slider'].includes(element.type) && (element.width < 40 || element.height < 20)) fail('原生控件至少 40×20', 'width')
    if (element.type === 'slot' && (element.width < 20 || element.height < 20)) fail('展示槽位至少 20×20', 'width')
    if (element.type === 'image' && element.texture && element.texture.split(/[:/]/).some(part => !part || part === '.' || part === '..')) fail('图片纹理不允许路径穿越', 'texture')
    if (layout.layoutType === 'hud-overlay' && ['button', 'toggle', 'slider'].includes(element.type)) fail('HUD 不支持交互控件，请使用 Screen', 'type')
    if (element.type === 'slider' && (element.min >= element.max || element.initial < element.min || element.initial > element.max || !Number.isInteger(element.initial))) fail('滑块上下限及整数默认值不合法', 'initial')
    if (element.type === 'label' && element.bind && !['player-health', 'player-food'].includes(element.bind) && !layout.elements.some(item => ['toggle', 'slider'].includes(item.type) && item.id === element.bind)) fail('标签绑定必须指向玩家属性或本布局开关/滑块', 'bind')
    if (element.type === 'button' && element.action === 'increment' && !layout.elements.some(item => item.type === 'slider' && item.id === element.target)) fail('递增按钮必须指定本布局的滑块', 'target')
    if (element.itemId.split(/[:/]/).some(part => !part || part === '.' || part === '..')) fail('物品 ID 不允许路径穿越', 'itemId')
  })
})
export type GuiLayout = z.infer<typeof guiLayoutSchema>
export type GuiElement = z.infer<typeof elementSchema>
export type GuiFile = { path: string; before: string | null; after: string }
export type GuiDocument = { id: string; value?: GuiLayout; editable: boolean; reason?: string; revision: string; files: string[] }
export function newGuiElement(type: GuiElement['type'], id: string): GuiElement {
  return { id, type, label: guiTypeLabels[type], x: 24, y: 24, width: type === 'slot' ? 24 : type === 'panel' ? 160 : 120, height: type === 'panel' ? 96 : 24, color: type === 'panel' ? '#20252c' : '#ffffff', alpha: 1, shadow: true, bind: '', action: 'close', target: '', initial: 5, checked: false, min: 0, max: 10, itemId: 'minecraft:iron_ingot', texture: 'minecraft:item/iron_ingot' }
}
export function newGuiLayout(modId: string, layoutType: GuiLayout['layoutType'] = 'custom-screen'): GuiLayout {
  return { version: 1, id: `${modId}:new_${layoutType === 'hud-overlay' ? 'hud' : 'screen'}`, title: layoutType === 'hud-overlay' ? '我的 HUD' : '我的界面', layoutType, width: 320, height: 240, anchor: layoutType === 'hud-overlay' ? 'top-left' : 'center', keyCode: layoutType === 'hud-overlay' ? 72 : 71, elements: [] }
}
export function guiOrigin(layout: Pick<GuiLayout, 'width' | 'height' | 'anchor'>, width: number, height: number) {
  return { x: layout.anchor.endsWith('right') ? width - layout.width : layout.anchor === 'center' ? Math.trunc((width - layout.width) / 2) : 0, y: layout.anchor.startsWith('bottom') ? height - layout.height : layout.anchor === 'center' ? Math.trunc((height - layout.height) / 2) : 0 }
}
/** Extracted grid/edge semantics from the legacy iframe, with explicit bounds and nearest-guide selection. */
export function moveGuiElement(layout: GuiLayout, element: GuiElement, x: number, y: number, grid = true) {
  const snap = (n: number) => grid ? Math.round(n / GUI_GRID) * GUI_GRID : Math.round(n)
  let nextX = snap(x), nextY = snap(y), guideX: number | undefined, guideY: number | undefined
  let distanceX = GUI_ALIGN_THRESHOLD, distanceY = GUI_ALIGN_THRESHOLD
  for (const other of (grid ? layout.elements : []).filter(item => item.id !== element.id)) {
    for (const target of [other.x, other.x + other.width / 2, other.x + other.width]) for (const edge of [0, element.width / 2, element.width]) {
      const distance = Math.abs(nextX + edge - target); if (distance < distanceX) { distanceX = distance; guideX = target; x = target - edge }
    }
    for (const target of [other.y, other.y + other.height / 2, other.y + other.height]) for (const edge of [0, element.height / 2, element.height]) {
      const distance = Math.abs(nextY + edge - target); if (distance < distanceY) { distanceY = distance; guideY = target; y = target - edge }
    }
  }
  if (guideX !== undefined) nextX = x; if (guideY !== undefined) nextY = y
  return { element: { ...element, x: Math.round(Math.max(0, Math.min(layout.width - element.width, nextX))), y: Math.round(Math.max(0, Math.min(layout.height - element.height, nextY))) }, guideX, guideY }
}
export function resizeGuiElement(layout: GuiLayout, element: GuiElement, width: number, height: number, grid = true): GuiElement {
  const snap = (n: number) => grid ? Math.round(n / GUI_GRID) * GUI_GRID : Math.round(n)
  const interactive = ['button', 'toggle', 'slider'].includes(element.type)
  return { ...element, width: Math.min(layout.width - element.x, Math.max(interactive ? 40 : 8, snap(width))), height: Math.min(layout.height - element.y, Math.max(interactive ? 20 : 8, snap(height))) }
}
