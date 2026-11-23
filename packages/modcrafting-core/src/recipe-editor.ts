import { buildRecipeContent, type RecipeKind, type GeneralRecipeInput } from './recipe-format.ts'
import { FABRIC_TARGET } from './domain.ts'
import type { CraftingGridData } from './recipe-grid.ts'

/**
 * Readers must accept both `{item}`/`{tag}` objects (before 1.21.2) and plain
 * strings, otherwise opening an older recipe shows empty ingredients.
 */
const ingredientId = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>
    if (typeof entry.item === 'string') return entry.item
    if (typeof entry.tag === 'string') return `#${entry.tag.replace(/^#/, '')}`
  }
  return ''
}

export type RecipeDraft = CraftingGridData & { type: RecipeKind; experience: number; cookingTime: number }
export const newRecipeDraft = (): RecipeDraft => ({ type: 'shaped', grid: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ itemId: '', count: 0 }))), outputItem: '', outputCount: 1, experience: 0, cookingTime: 200 })
export function recipeDraftFromContent(content: string): RecipeDraft {
  const raw = JSON.parse(content), draft = newRecipeDraft()
  draft.type = ({ 'minecraft:crafting_shaped': 'shaped', 'minecraft:crafting_shapeless': 'shapeless', 'minecraft:smelting': 'smelting', 'minecraft:blasting': 'blasting', 'minecraft:stonecutting': 'stonecutting' } as Record<string, RecipeKind>)[raw.type]
  if (!draft.type) throw Error('该配方类型仅支持只读查看')
  if (draft.type === 'shaped') raw.pattern.forEach((row: string, y: number) => [...row].forEach((symbol, x) => { if (symbol !== ' ') { const id = ingredientId(raw.key[symbol]); if (id) draft.grid[y][x] = { itemId: id, count: 1 } } }))
  else (raw.ingredients || [raw.ingredient]).map(ingredientId).forEach((id: string, index: number) => { if (id) draft.grid[Math.floor(index / 3)][index % 3] = { itemId: id, count: 1 } })
  draft.outputItem = typeof raw.result === 'string' ? raw.result : String(raw.result.id ?? raw.result.item ?? '')
  draft.outputCount = typeof raw.result === 'string' ? 1 : raw.result.count ?? 1
  draft.experience = raw.experience ?? 0; draft.cookingTime = raw.cookingtime ?? 200
  return draft
}
export function recipeContentFromDraft(draft: RecipeDraft, baseContent = '{}', mcVersion?: string): string {
  const base = JSON.parse(baseContent), input: GeneralRecipeInput = { type: draft.type, result: { item: draft.outputItem, count: draft.outputCount }, mcVersion: mcVersion?.trim() || FABRIC_TARGET.minecraft }
  const ingredient = (id: string) => id.startsWith('#') ? { tag: id.slice(1) } : { item: id }
  if (draft.type === 'shaped') {
    const positions = draft.grid.flatMap((row, y) => row.flatMap((cell, x) => cell.itemId ? [{ x, y }] : []))
    if (!positions.length) throw Error('请至少放入一种材料')
    const minX = Math.min(...positions.map(p => p.x)), maxX = Math.max(...positions.map(p => p.x)), minY = Math.min(...positions.map(p => p.y)), maxY = Math.max(...positions.map(p => p.y))
    const ids: string[] = []; input.keys = {}
    input.pattern = draft.grid.slice(minY, maxY + 1).map(row => row.slice(minX, maxX + 1).map(cell => {
      if (!cell.itemId) return ' '
      if (!ids.includes(cell.itemId)) ids.push(cell.itemId)
      const symbol = 'ABCDEFGHI'[ids.indexOf(cell.itemId)]; input.keys![symbol] = ingredient(cell.itemId); return symbol
    }).join(''))
  } else if (draft.type === 'shapeless') input.ingredients = draft.grid.flat().filter(cell => cell.itemId).map(cell => ({ item: cell.itemId, count: 1 }))
  else { input.ingredient = ingredient(draft.grid[0][0].itemId); input.experience = draft.experience; input.cookingTime = draft.cookingTime }
  const generated = JSON.parse(buildRecipeContent(input))
  const metadata = { ...base }
  for (const key of ['type', 'pattern', 'key', 'ingredients', 'ingredient', 'result', 'experience', 'cookingtime']) delete metadata[key]
  if (base.type !== generated.type) { delete metadata.category; delete metadata.group }
  else if (base.category !== undefined && generated.category !== undefined) generated.category = base.category
  if (typeof generated.result === 'object' && typeof base.result === 'object') generated.result = { ...base.result, ...generated.result }
  return JSON.stringify({ ...metadata, ...generated }, null, 2) + '\n'
}
