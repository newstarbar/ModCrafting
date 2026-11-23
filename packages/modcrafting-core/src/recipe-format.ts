import { FABRIC_TARGET } from './domain.ts'
import { deriveResourceLayout } from './resources/layout.ts'
import { getRegistry } from './version/registry.ts'

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

export interface RecipeValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  namespace?: string
  type?: RecipeKind
}

const RESOURCE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const RECIPE_PATH_RE = /(?:^|\/)src\/main\/resources\/data\/([a-z0-9_.-]+)\/(recipe|recipes)\/([a-z0-9/._-]+)\.json$/

/** Everything the validator needs to know about one target's recipe dialect. */
interface RecipeFormat { mc: string; folder: 'recipe' | 'recipes'; stringIngredients: boolean; resultId: boolean }

function recipeFormat(mcVersion?: string): RecipeFormat {
  const mc = mcVersion?.trim() || FABRIC_TARGET.minecraft
  const layout = deriveResourceLayout(mc, getRegistry())
  return {
    mc,
    folder: layout.recipeDir,
    stringIngredients: layout.recipeIngredient === 'string',
    resultId: layout.recipeResult === 'id-object'
  }
}

function isResourceId(value: unknown, allowTag = false): value is string {
  if (typeof value !== 'string') return false
  const normalized = allowTag ? value.replace(/^#/, '') : value
  return RESOURCE_ID_RE.test(normalized) && (!value.startsWith('#') || allowTag)
}

function validateIngredient(value: unknown, label: string, errors: string[], format: RecipeFormat): void {
  if (isResourceId(value, true)) return
  if (!format.stringIngredients && value && typeof value === 'object' && !Array.isArray(value)) {
    const entry = value as Record<string, unknown>
    const keys = Object.keys(entry)
    const key = keys[0]
    if (keys.length === 1 && (key === 'item' || key === 'tag') && isResourceId(entry[key], key === 'tag')) return
    errors.push(`${label} 必须是 {"item": ...} 或 {"tag": ...}（MC ${format.mc}）`)
    return
  }
  errors.push(format.stringIngredients
    ? `${label} 必须是 ${format.mc} 字符串物品 ID 或 #标签，不能使用旧版 {item/tag} 对象`
    : `${label} 必须是 {"item": ...} 或 {"tag": ...}（MC ${format.mc}）`)
}

function validateResultObject(value: unknown, errors: string[], knownVanillaIds: ReadonlySet<string> | undefined, format: RecipeFormat): void {
  const field = format.resultId ? 'id' : 'item'
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`result 必须是包含 ${field} 的对象`)
    return
  }
  const result = value as Record<string, unknown>
  if ((format.resultId ? 'item' : 'id') in result) errors.push(`MC ${format.mc} 使用 result.${field}，禁止${format.resultId ? '旧版' : ''} result.${format.resultId ? 'item' : 'id'}`)
  if (!isResourceId(result[field])) errors.push(`result.${field} 不是合法资源 ID`)
  if (result.count !== undefined && (!Number.isInteger(result.count) || Number(result.count) < 1)) {
    errors.push('result.count 必须是正整数')
  }
  const id = result[field]
  if (typeof id === 'string' && id.startsWith('minecraft:') && knownVanillaIds && !knownVanillaIds.has(id)) {
    errors.push(`未知的 ${format.mc} 原版物品 ID: ${id}`)
  }
}

export function validateRecipeContent(
  content: string,
  options: { path?: string; modId?: string; knownVanillaIds?: ReadonlySet<string>; mcVersion?: string } = {}
): RecipeValidationResult {
  const format = recipeFormat(options.mcVersion)
  const errors: string[] = []
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object')
    parsed = value as Record<string, unknown>
  } catch (error) {
    return { valid: false, errors: [`配方 JSON 无法解析: ${String(error)}`], warnings }
  }

  let namespace: string | undefined
  if (options.path) {
    const normalizedPath = options.path.replace(/\\/g, '/').replace(/^\/+/, '')
    const match = normalizedPath.match(RECIPE_PATH_RE)
    if (!match || match[2] !== format.folder) {
      errors.push(`MC ${format.mc} 配方路径必须是 src/main/resources/data/<namespace>/${format.folder}/<name>.json`)
    } else {
      namespace = match[1]
      if (options.modId && namespace !== options.modId) {
        errors.push(`配方 namespace ${namespace} 与 fabric.mod.json id ${options.modId} 不一致`)
      }
    }
  }

  const typeMap: Record<string, RecipeKind> = {
    'minecraft:crafting_shaped': 'shaped',
    'minecraft:crafting_shapeless': 'shapeless',
    'minecraft:smelting': 'smelting',
    'minecraft:blasting': 'blasting',
    'minecraft:stonecutting': 'stonecutting'
  }
  const type = typeof parsed.type === 'string' ? typeMap[parsed.type] : undefined
  if (!type) {
    errors.push(`仅支持 shaped、shapeless、smelting、blasting、stonecutting 五种 ${format.mc} 原版配方`)
    return { valid: false, errors, warnings, namespace }
  }

  if (type === 'shapeless') {
    const ingredients = parsed.ingredients
    if (!Array.isArray(ingredients) || ingredients.length < 1 || ingredients.length > 9) {
      errors.push('shapeless ingredients 数量必须为 1–9')
    } else {
      ingredients.forEach((ingredient, index) => validateIngredient(ingredient, `ingredients[${index}]`, errors, format))
    }
    validateResultObject(parsed.result, errors, options.knownVanillaIds, format)
  } else if (type === 'shaped') {
    const pattern = parsed.pattern
    const key = parsed.key
    if (!Array.isArray(pattern) || pattern.length < 1 || pattern.length > 3 || pattern.some((row) => typeof row !== 'string')) {
      errors.push('shaped pattern 必须包含 1–3 个字符串行')
    } else {
      const rows = pattern as string[]
      const width = rows[0].length
      if (width < 1 || width > 3 || rows.some((row) => row.length !== width)) {
        errors.push('shaped pattern 必须等宽且宽度为 1–3')
      }
      const used = new Set(rows.join('').replace(/ /g, '').split('').filter(Boolean))
      if (used.size === 0) errors.push('shaped pattern 不能全为空格')
      if (!key || typeof key !== 'object' || Array.isArray(key)) {
        errors.push('shaped key 必须是对象')
      } else {
        const entries = Object.entries(key as Record<string, unknown>)
        for (const [symbol, ingredient] of entries) {
          if (symbol.length !== 1 || symbol === ' ') errors.push(`key "${symbol}" 必须是单个非空格字符`)
          validateIngredient(ingredient, `key.${symbol}`, errors, format)
          if (!used.has(symbol)) errors.push(`key "${symbol}" 未在 pattern 中使用`)
        }
        for (const symbol of used) {
          if (!(symbol in (key as Record<string, unknown>))) errors.push(`pattern 字符 "${symbol}" 缺少 key 定义`)
        }
      }
    }
    validateResultObject(parsed.result, errors, options.knownVanillaIds, format)
  } else if (type === 'stonecutting') {
    validateIngredient(parsed.ingredient, 'ingredient', errors, format)
    validateResultObject(parsed.result, errors, options.knownVanillaIds, format)
  } else {
    validateIngredient(parsed.ingredient, 'ingredient', errors, format)
    if (!isResourceId(parsed.result)) errors.push(`${type} result 必须是字符串物品 ID`)
    if (typeof parsed.result === 'string' && parsed.result.startsWith('minecraft:') && options.knownVanillaIds && !options.knownVanillaIds.has(parsed.result)) {
      errors.push(`未知的 ${format.mc} 原版物品 ID: ${parsed.result}`)
    }
    if (typeof parsed.experience !== 'number' || !Number.isFinite(parsed.experience) || parsed.experience < 0) {
      errors.push('experience 必须是非负数')
    }
    if (!Number.isInteger(parsed.cookingtime) || Number(parsed.cookingtime) < 1) {
      errors.push('cookingtime 必须是正整数，并使用全小写字段名')
    }
  }

  const ids: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && isResourceId(value.replace(/^#/, ''))) ids.push(value.replace(/^#/, ''))
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(collect)
  }
  collect(parsed)
  if (options.modId) {
    for (const id of ids) {
      const idNamespace = id.split(':')[0]
      if (idNamespace !== 'minecraft' && idNamespace !== options.modId) {
        warnings.push(`外部命名空间 ${idNamespace} 无法离线确认是否由依赖模组注册`)
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [...new Set(warnings)], namespace, type }
}

function normalizeResourcePart(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_\-./]/g, '_').replace(/^\/+|\/+$/g, '')
  return normalized || fallback
}

/**
 * Version predicates now come from the catalog release sequence instead of
 * parsing `1.x.y`, because Minecraft also ships year-based ids (26.1, 26.3).
 * `26.1 > 1.21.11` holds through the release order, never through parseFloat.
 */
export function usesModernRecipeFolder(mcVersion?: string): boolean { return recipeFormat(mcVersion).folder === 'recipe' }

/** MC 1.21.2+ uses plain string ingredients and keys. */
export function usesStringRecipeIngredients(mcVersion?: string): boolean { return recipeFormat(mcVersion).stringIngredients }

/** MC 1.20.5+ uses result.id instead of result.item. */
export function usesResultIdField(mcVersion?: string): boolean { return recipeFormat(mcVersion).resultId }

export function usesModernRecipeFormat(mcVersion?: string): boolean {
  return usesModernRecipeFolder(mcVersion)
}

export function recipeFolder(mcVersion?: string): string {
  return recipeFormat(mcVersion).folder
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
