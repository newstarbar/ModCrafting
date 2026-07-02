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
