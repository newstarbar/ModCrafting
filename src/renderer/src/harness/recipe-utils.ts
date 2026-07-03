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
  mcVersion?: string
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
  mcVersion?: string
}

function normalizeResourcePart(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_\-./]/g, '_').replace(/^\/+|\/+$/g, '')
  return normalized || fallback
}

function parseMcVersion(mcVersion?: string): { major: number; minor: number; patch: number } {
  if (!mcVersion) return { major: 1, minor: 21, patch: 4 }
  const parts = mcVersion.trim().split('.').map((p) => Number.parseInt(p, 10))
  return {
    major: Number.isFinite(parts[0]) ? parts[0] : 1,
    minor: Number.isFinite(parts[1]) ? parts[1] : 21,
    patch: Number.isFinite(parts[2]) ? parts[2] : 0
  }
}

/** MC 1.21+ uses singular data/<ns>/recipe/ folder. */
export function usesModernRecipeFolder(mcVersion?: string): boolean {
  const { major, minor } = parseMcVersion(mcVersion)
  return major > 1 || (major === 1 && minor >= 21)
}

/** MC 1.21.2+ uses plain string ingredients and keys. */
export function usesStringRecipeIngredients(mcVersion?: string): boolean {
  const { major, minor, patch } = parseMcVersion(mcVersion)
  if (major > 1) return true
  if (major === 1 && minor > 21) return true
  if (major === 1 && minor === 21 && patch >= 2) return true
  return false
}

/** MC 1.20.5+ uses result.id instead of result.item. */
export function usesResultIdField(mcVersion?: string): boolean {
  const { major, minor, patch } = parseMcVersion(mcVersion)
  if (major > 1) return true
  if (major === 1 && minor > 20) return true
  if (major === 1 && minor === 20 && patch >= 5) return true
  return false
}

export function usesModernRecipeFormat(mcVersion?: string): boolean {
  return usesModernRecipeFolder(mcVersion)
}

export function recipeFolder(mcVersion?: string): string {
  return usesModernRecipeFolder(mcVersion) ? 'recipe' : 'recipes'
}

export function recipePath(namespace: string, name: string, mcVersion?: string): string {
  const ns = normalizeResourcePart(namespace, 'modcrafting')
  const recipeName = normalizeResourcePart(name, 'generated_recipe')
  return `src/main/resources/data/${ns}/${recipeFolder(mcVersion)}/${recipeName}.json`
}

function formatIngredientKey(key: RecipeKey, mcVersion?: string): RecipeKey | string {
  if (usesStringRecipeIngredients(mcVersion)) {
    if (key.tag) return `#${key.tag.replace(/^#/, '')}`
    return key.item || 'minecraft:air'
  }
  if (key.tag) return { tag: key.tag.replace(/^#/, '') }
  return { item: key.item || 'minecraft:air' }
}

function formatResult(result: RecipeResult, mcVersion?: string): Record<string, unknown> {
  const count = Math.max(1, Math.floor(result.count ?? 1))
  if (usesResultIdField(mcVersion)) {
    return { id: result.item, count }
  }
  return { item: result.item, count }
}

export function buildShapelessRecipeContent(input: ShapelessRecipeInput): string {
  const mcVersion = input.mcVersion
  const ingredientList = input.ingredients.flatMap((ingredient) => {
    const count = Math.max(1, Math.min(9, Math.floor(ingredient.count ?? 1)))
    return Array.from({ length: count }, () => ingredient.item)
  })

  const ingredients = usesStringRecipeIngredients(mcVersion)
    ? ingredientList
    : ingredientList.map((item) => ({ item }))

  return JSON.stringify({
    type: 'minecraft:crafting_shapeless',
    category: 'misc',
    ingredients,
    result: formatResult(input.result, mcVersion)
  }, null, 2)
}

function normalizeIngredient(input: RecipeKey | undefined, mcVersion?: string): RecipeKey | string {
  if (!input) return formatIngredientKey({ item: 'minecraft:air' }, mcVersion)
  return formatIngredientKey(input, mcVersion)
}

export function buildRecipeContent(input: GeneralRecipeInput): string {
  const mcVersion = input.mcVersion

  if (input.type === 'shapeless') {
    return buildShapelessRecipeContent({
      ingredients: input.ingredients || [],
      result: input.result,
      mcVersion
    })
  }

  if (input.type === 'shaped') {
    const keys = input.keys || {}
    const formattedKeys: Record<string, RecipeKey | string> = {}
    for (const [symbol, key] of Object.entries(keys)) {
      formattedKeys[symbol] = formatIngredientKey(key, mcVersion)
    }
    return JSON.stringify({
      type: 'minecraft:crafting_shaped',
      category: 'misc',
      pattern: input.pattern || [],
      key: formattedKeys,
      result: formatResult(input.result, mcVersion)
    }, null, 2)
  }

  if (input.type === 'stonecutting') {
    const count = Math.max(1, Math.floor(input.result.count ?? 1))
    if (usesResultIdField(mcVersion)) {
      return JSON.stringify({
        type: 'minecraft:stonecutting',
        ingredient: normalizeIngredient(input.ingredient, mcVersion),
        result: { id: input.result.item, count }
      }, null, 2)
    }
    return JSON.stringify({
      type: 'minecraft:stonecutting',
      ingredient: normalizeIngredient(input.ingredient, mcVersion),
      result: input.result.item,
      count
    }, null, 2)
  }

  const smeltResult = usesResultIdField(mcVersion)
    ? input.result.item
    : input.result.item

  return JSON.stringify({
    type: input.type === 'blasting' ? 'minecraft:blasting' : 'minecraft:smelting',
    category: 'misc',
    ingredient: normalizeIngredient(input.ingredient, mcVersion),
    result: smeltResult,
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
