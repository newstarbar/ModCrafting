export interface RecipeIngredient {
  item: string
  count?: number
}

export interface RecipeResult {
  item: string
  count?: number
}

export interface ShapelessRecipeInput {
  ingredients: RecipeIngredient[]
  result: RecipeResult
}

export type RecipeKind = 'shapeless' | 'shaped' | 'smelting' | 'blasting' | 'stonecutting'

export interface RecipeKey {
  item?: string
  tag?: string
}

export interface GeneralRecipeInput {
  type: RecipeKind
  ingredients?: RecipeIngredient[]
  pattern?: string[]
  keys?: Record<string, RecipeKey>
  ingredient?: RecipeKey
  result: RecipeResult
  experience?: number
  cookingTime?: number
}

function normalizeResourcePart(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_\-./]/g, '_').replace(/^\/+|\/+$/g, '')
  return normalized || fallback
}

export function recipePath(namespace: string, name: string): string {
  const ns = normalizeResourcePart(namespace, 'modcrafting')
  const recipeName = normalizeResourcePart(name, 'generated_recipe')
  return `src/main/resources/data/${ns}/recipes/${recipeName}.json`
}

export function buildShapelessRecipeContent(input: ShapelessRecipeInput): string {
  const ingredients = input.ingredients.flatMap((ingredient) => {
    const count = Math.max(1, Math.min(9, Math.floor(ingredient.count ?? 1)))
    return Array.from({ length: count }, () => ({ item: ingredient.item }))
  })
  const resultCount = Math.max(1, Math.floor(input.result.count ?? 1))
  return JSON.stringify({
    type: 'minecraft:crafting_shapeless',
    category: 'misc',
    ingredients,
    result: {
      item: input.result.item,
      count: resultCount
    }
  }, null, 2)
}

function normalizeResult(result: RecipeResult): { item: string; count?: number } {
  const count = Math.max(1, Math.floor(result.count ?? 1))
  return { item: result.item, count }
}

function normalizeIngredient(input: RecipeKey | undefined): RecipeKey {
  if (!input) return { item: 'minecraft:air' }
  if (input.tag) return { tag: input.tag }
  return { item: input.item || 'minecraft:air' }
}

export function buildRecipeContent(input: GeneralRecipeInput): string {
  if (input.type === 'shapeless') {
    return buildShapelessRecipeContent({
      ingredients: input.ingredients || [],
      result: input.result
    })
  }

  if (input.type === 'shaped') {
    return JSON.stringify({
      type: 'minecraft:crafting_shaped',
      category: 'misc',
      pattern: input.pattern || [],
      key: input.keys || {},
      result: normalizeResult(input.result)
    }, null, 2)
  }

  if (input.type === 'stonecutting') {
    return JSON.stringify({
      type: 'minecraft:stonecutting',
      ingredient: normalizeIngredient(input.ingredient),
      result: input.result.item,
      count: Math.max(1, Math.floor(input.result.count ?? 1))
    }, null, 2)
  }

  return JSON.stringify({
    type: input.type === 'blasting' ? 'minecraft:blasting' : 'minecraft:smelting',
    category: 'misc',
    ingredient: normalizeIngredient(input.ingredient),
    result: input.result.item,
    experience: Number.isFinite(input.experience) ? input.experience : 0,
    cookingtime: Math.max(1, Math.floor(input.cookingTime ?? (input.type === 'blasting' ? 100 : 200)))
  }, null, 2)
}

export function parseRecipeIngredients(value: unknown): RecipeIngredient[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry): RecipeIngredient | null => {
      if (typeof entry === 'string') return { item: entry, count: 1 }
      if (entry && typeof entry === 'object') {
        const item = String((entry as { item?: unknown }).item || '')
        if (!item) return null
        const count = Number((entry as { count?: unknown }).count ?? 1)
        return { item, count: Number.isFinite(count) ? count : 1 }
      }
      return null
    })
    .filter((entry): entry is RecipeIngredient => Boolean(entry))
}
