/**
 * Dialect-aware readers for resource content.
 *
 * The project-wide diagnostics stay in `node.ts` (they judge a whole project);
 * this module only answers "what does this JSON mean under this dialect", which
 * is what readers and migrations need.
 */
import type { ResourceDialect } from './layout.ts'

export interface RecipeRefs {
  /** Result item id, whichever field the dialect uses. */
  result: { id: string; count: number }
  /** Ingredient item ids and `#tag` references, in document order. */
  ingredients: string[]
  type: string | undefined
}

const asId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>
    const id = entry.id ?? entry.item
    if (typeof id === 'string' && id) return id
    if (typeof entry.tag === 'string' && entry.tag) return `#${entry.tag.replace(/^#/, '')}`
  }
  return undefined
}

const collectIngredient = (value: unknown, output: string[]): void => {
  const id = asId(value)
  if (id) { output.push(id); return }
  if (Array.isArray(value)) for (const entry of value) collectIngredient(entry, output)
}

/**
 * Reads both `result.id` (1.20.5+) and `result.item` (older), and both plain
 * string ingredients (1.21.2+) and `{item}/{tag}` objects. Readers must use this
 * instead of reaching into `result.id` directly, otherwise an older project
 * silently reports "unknown output".
 */
export function readRecipeRefs(content: string): RecipeRefs | undefined {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    parsed = value as Record<string, unknown>
  } catch { return undefined }

  const resultRaw = parsed.result
  let result = { id: '', count: 1 }
  if (typeof resultRaw === 'string') {
    result = { id: resultRaw, count: 1 }
  } else if (resultRaw && typeof resultRaw === 'object' && !Array.isArray(resultRaw)) {
    const entry = resultRaw as Record<string, unknown>
    const id = asId(entry) ?? ''
    const count = Number(entry.count ?? 1)
    result = { id, count: Number.isFinite(count) && count > 0 ? count : 1 }
  }

  const ingredients: string[] = []
  if (parsed.key && typeof parsed.key === 'object' && !Array.isArray(parsed.key)) {
    for (const value of Object.values(parsed.key as Record<string, unknown>)) collectIngredient(value, ingredients)
  }
  collectIngredient(parsed.ingredients, ingredients)
  collectIngredient(parsed.ingredient, ingredients)

  return { result, ingredients, type: typeof parsed.type === 'string' ? parsed.type : undefined }
}

/** True when the document's own field shapes match the target dialect. */
export function isRecipeInTargetDialect(content: string, dialect: ResourceDialect): boolean {
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    parsed = value as Record<string, unknown>
  } catch { return false }

  const resultRaw = parsed.result
  const usesIdObject = Boolean(resultRaw && typeof resultRaw === 'object' && !Array.isArray(resultRaw) && 'id' in (resultRaw as Record<string, unknown>))
  const usesItemObject = Boolean(resultRaw && typeof resultRaw === 'object' && !Array.isArray(resultRaw) && 'item' in (resultRaw as Record<string, unknown>) && !('id' in (resultRaw as Record<string, unknown>)))
  if (dialect.recipeResult === 'id-object' && usesItemObject) return false
  if (dialect.recipeResult === 'item-object' && usesIdObject) return false

  const looksString = typeof resultRaw === 'string'
  if (dialect.recipeResult === 'id-object' && looksString && parsed.type !== 'minecraft:smelting' && parsed.type !== 'minecraft:blasting') return false

  return true
}
