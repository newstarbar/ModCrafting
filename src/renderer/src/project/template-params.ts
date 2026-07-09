import {
  chineseToEnglishId,
  templateSchemas,
  type CraftingGridData,
  type FormField
} from '../components/template-schemas.ts'

export interface TemplateFormParams {
  templateId: string
  name: string
  displayName?: string
  formFields: Record<string, unknown>
}

export interface NormalizedFormFields {
  formFields: Record<string, unknown>
  appliedSummary: string[]
  unsupportedSummary: string[]
}

const BLOCK_UNSUPPORTED_FEATURES = new Set(['powerable', 'farmable', 'flammable', 'custom_drop'])
const BLOCK_UNSUPPORTED_RENDER = new Set(['block_entity', 'custom_model'])
const ITEM_UNSUPPORTED = new Set(['itemType', 'specialEffect'])
const TOOL_UNSUPPORTED = new Set(['specialAbility'])
const ARMOR_UNSUPPORTED = new Set(['specialEffect', 'full_set'])
const ENTITY_UNSUPPORTED = new Set(['specialAbility'])

function pickId(formData: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const raw = formData[key]
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim().replace(/-/g, '_').toLowerCase()
    }
  }
  return ''
}

function pickDisplayName(formData: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const raw = formData[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return ''
}

function schemaDefault(field: FormField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue
  if (field.type === 'craftingGrid') {
    return { grid: [], outputItem: '', outputCount: 1 }
  }
  return undefined
}

function coerceNumber(value: unknown, fallback: number): number {
  if (value === '' || value === null || value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function displayValueForField(field: FormField, value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (field.type === 'select' && field.options) {
    const option = field.options.find((o) => o.value === value)
    if (option) return option.label
  }
  if (field.type === 'craftingGrid') return '(合成网格)'
  return String(value)
}

/** Derive javaPackage folder name from discovered path parts and maven groupId. */
export function modIdToJavaPackage(modId: string): string {
  return modId.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_') || 'mod'
}

/** Derive javaPackage folder name from discovered path parts and maven groupId. */
export function deriveJavaPackage(pkgParts: string[], groupId: string, modId: string): string {
  const modFallback = modIdToJavaPackage(modId)
  const groupParts = groupId.split('.').filter(Boolean)
  if (pkgParts.length > groupParts.length && groupParts.length > 0) {
    const prefixMatch = groupParts.every((part, index) => pkgParts[index] === part)
    if (prefixMatch) {
      const suffix = pkgParts.slice(groupParts.length)
      if (suffix.length === 1) return suffix[0]
      return suffix.join('.')
    }
  }
  const joined = pkgParts.join('.')
  if (joined === groupId) {
    return modFallback
  }
  if (groupId && pkgParts.length === 1 && pkgParts[0] === groupId) {
    return modFallback
  }
  if (!groupId.trim() && (joined.includes('.') || pkgParts.some((p) => p.includes('.')))) {
    return modFallback
  }
  const leaf = pkgParts[pkgParts.length - 1] || joined
  if (leaf === groupId) {
    return modFallback
  }
  return leaf
}

/** Parse main entrypoint class FQN into groupId suffix / javaPackage when possible. */
export function javaPackageFromMainEntry(mainEntry: string, groupId: string, modId: string): string | null {
  const lastDot = mainEntry.lastIndexOf('.')
  if (lastDot <= 0) return null
  const fullPackage = mainEntry.slice(0, lastDot)
  if (groupId && fullPackage.startsWith(`${groupId}.`)) {
    return fullPackage.slice(groupId.length + 1)
  }
  if (fullPackage === groupId) {
    return modId.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_') || null
  }
  const parts = fullPackage.split('.')
  return parts[parts.length - 1] || null
}

export function normalizeFormFieldsForCodegen(templateId: string, formData: Record<string, unknown>): NormalizedFormFields {
  const schema = templateSchemas[templateId]
  const normalized: Record<string, unknown> = { ...formData }
  const appliedSummary: string[] = []
  const unsupportedSummary: string[] = []

  if (schema) {
    for (const field of schema.fields) {
      const fallback = schemaDefault(field)
      let value = normalized[field.key]
      if (field.type === 'number') {
        value = coerceNumber(value, typeof fallback === 'number' ? fallback : 0)
      } else if (value === undefined || value === null || value === '') {
        if (fallback !== undefined) value = fallback
      }
      if (value !== undefined) normalized[field.key] = value
    }
  }

  if (normalized.specialEffect !== undefined && normalized.effect === undefined) {
    normalized.effect = normalized.specialEffect
  }
  if (normalized.protection !== undefined && normalized.durability === undefined) {
    normalized.durability = normalized.protection
  }

  const label = (key: string) => schema?.fields.find((f) => f.key === key)?.label || key

  switch (templateId) {
    case 'custom-block': {
      appliedSummary.push(`${label('hardness')}=${normalized.hardness}`)
      appliedSummary.push(`${label('resistance')}=${normalized.resistance}`)
      appliedSummary.push(`${label('materialStyle')}=${displayValueForField(schema!.fields.find((f) => f.key === 'materialStyle')!, normalized.materialStyle)}`)
      if (normalized.specialFeatures === 'glowing') appliedSummary.push('发光=是')
      if (normalized.customRender === 'particles') appliedSummary.push('粒子效果=是')
      const sf = String(normalized.specialFeatures || 'none')
      if (BLOCK_UNSUPPORTED_FEATURES.has(sf)) {
        unsupportedSummary.push(`${label('specialFeatures')}=${displayValueForField(schema!.fields.find((f) => f.key === 'specialFeatures')!, sf)}`)
      }
      const cr = String(normalized.customRender || 'no')
      if (BLOCK_UNSUPPORTED_RENDER.has(cr)) {
        unsupportedSummary.push(`${label('customRender')}=${displayValueForField(schema!.fields.find((f) => f.key === 'customRender')!, cr)}`)
      }
      break
    }
    case 'custom-item': {
      appliedSummary.push(`${label('maxStackSize')}=${normalized.maxStackSize}`)
      if (normalized.hasDurability === 'yes') appliedSummary.push('耐久度=是')
      for (const key of ITEM_UNSUPPORTED) {
        const v = normalized[key]
        if (v && v !== 'none' && v !== 'normal' && v !== 'no') {
          const field = schema!.fields.find((f) => f.key === key)
          unsupportedSummary.push(`${field?.label || key}=${displayValueForField(field!, v)}`)
        }
      }
      break
    }
    case 'custom-food': {
      appliedSummary.push(`${label('hunger')}=${normalized.hunger}`)
      appliedSummary.push(`${label('saturation')}=${normalized.saturation}`)
      if (normalized.isMeat === 'yes') appliedSummary.push('肉类=是')
      const effect = String(normalized.effect || 'none')
      if (effect !== 'none') {
        const field = schema!.fields.find((f) => f.key === 'effect')
        if (['speed', 'strength', 'jump_boost', 'night_vision', 'regeneration'].includes(effect)) {
          appliedSummary.push(`${label('effect')}=${displayValueForField(field!, effect)}`)
        } else {
          unsupportedSummary.push(`${label('effect')}=${effect}（自定义效果需手动实现）`)
        }
      }
      break
    }
    case 'custom-tool': {
      appliedSummary.push(`${label('toolType')}=${displayValueForField(schema!.fields.find((f) => f.key === 'toolType')!, normalized.toolType)}`)
      appliedSummary.push(`${label('material')}=${displayValueForField(schema!.fields.find((f) => f.key === 'material')!, normalized.material)}`)
      appliedSummary.push(`${label('durability')}=${normalized.durability}`)
      if (normalized.specialAbility && normalized.specialAbility !== 'none') {
        const field = schema!.fields.find((f) => f.key === 'specialAbility')
        unsupportedSummary.push(`${field?.label || '特殊能力'}=${displayValueForField(field!, normalized.specialAbility)}`)
      }
      break
    }
    case 'custom-armor': {
      appliedSummary.push(`${label('armorType')}=${displayValueForField(schema!.fields.find((f) => f.key === 'armorType')!, normalized.armorType)}`)
      appliedSummary.push(`${label('material')}=${displayValueForField(schema!.fields.find((f) => f.key === 'material')!, normalized.material)}`)
      appliedSummary.push(`${label('protection')}=${normalized.protection}`)
      const effect = String(normalized.specialEffect || 'none')
      if (effect !== 'none') {
        unsupportedSummary.push(`${label('specialEffect')}=${displayValueForField(schema!.fields.find((f) => f.key === 'specialEffect')!, effect)}`)
      }
      if (normalized.armorType === 'full_set') {
        unsupportedSummary.push('全套护甲（需分别生成四件）')
      }
      break
    }
    case 'custom-entity': {
      appliedSummary.push(`${label('health')}=${normalized.health}`)
      appliedSummary.push(`${label('entityType')}=${displayValueForField(schema!.fields.find((f) => f.key === 'entityType')!, normalized.entityType)}`)
      appliedSummary.push(`${label('size')}=${displayValueForField(schema!.fields.find((f) => f.key === 'size')!, normalized.size)}`)
      if (normalized.specialAbility && normalized.specialAbility !== 'none') {
        const field = schema!.fields.find((f) => f.key === 'specialAbility')
        unsupportedSummary.push(`${field?.label || '特殊能力'}=${displayValueForField(field!, normalized.specialAbility)}`)
      }
      break
    }
    default:
      break
  }

  return { formFields: normalized, appliedSummary, unsupportedSummary }
}

/** Human-readable bullet list of user-filled form fields. */
export function formatFormSummaryForDisplay(templateId: string, formData: Record<string, unknown>): string {
  const schema = templateSchemas[templateId]
  if (!schema) return ''

  const lines: string[] = []
  for (const field of schema.fields) {
    const value = formData[field.key]
    if (value === undefined || value === null || value === '') continue
    if (field.type === 'craftingGrid') {
      const gridData = value as CraftingGridData
      if (gridData?.outputItem) lines.push(`- ${field.label}：${gridData.outputItem} x${gridData.outputCount || 1}`)
      continue
    }
    const display = displayValueForField(field, value)
    if (display) lines.push(`- ${field.label}：${display}`)
  }
  return lines.join('\n')
}

export function buildQuickCreateUserMessage(options: {
  templateId: string
  displayName?: string
  name: string
  formData: Record<string, unknown>
  createdFiles: string[]
  appliedParams: string[]
  unsupportedParams: string[]
  ok: boolean
  errorDetail?: string
}): string {
  const label = options.displayName ? `${options.templateId}（${options.displayName}）` : options.templateId
  const formSummary = formatFormSummaryForDisplay(options.templateId, options.formData)
  const parts: string[] = []

  if (options.ok) {
    parts.push(`【快捷创建】模板已生成：${label}`)
    parts.push(`内容 ID：${options.name}`)
    if (formSummary) {
      parts.push('', '用户填写：', formSummary)
    }
    if (options.appliedParams.length) {
      parts.push('', '已写入代码的参数：', ...options.appliedParams.map((p) => `- ${p}`))
    }
    if (options.unsupportedParams.length) {
      parts.push('', '暂未实现的参数：', ...options.unsupportedParams.map((p) => `- ${p}`))
    }
    if (options.createdFiles.length) {
      parts.push('', '生成文件：', ...options.createdFiles.map((f) => `- ${f}`))
    }
    parts.push('', `模板ID：${options.templateId}。请直接构建并运行测试，不要重新探索或手搓注册代码。`)
  } else {
    parts.push(`【快捷创建】生成失败：${label}`)
    if (options.errorDetail) parts.push(options.errorDetail)
    if (formSummary) {
      parts.push('', '用户填写：', formSummary)
    }
  }

  return parts.join('\n')
}

/** User message after QuickCreate has written template files and requests build+run only. */
export function isQuickCreateGeneratedMessage(text: string): boolean {
  return (
    /【快捷创建】模板已生成/.test(text) &&
    /模板\s*ID\s*[：:]/i.test(text) &&
    /直接构建/.test(text)
  )
}

export function quickCreateSessionGoal(text: string): string {
  const templateMatch = text.match(/模板\s*ID\s*[：:]\s*(\S+)/i)
  const nameMatch = text.match(/内容\s*ID\s*[：:]\s*(\S+)/i)
  const templateId = templateMatch?.[1]?.replace(/[。.].*$/, '') || 'template'
  const contentId = nameMatch?.[1]
  return contentId ? `快捷创建 ${templateId}（${contentId}）` : `快捷创建 ${templateId}`
}

export function formFieldsJsonBlock(formFields: Record<string, unknown>): string {
  return `【结构化参数 JSON】\n${JSON.stringify(formFields, null, 2)}`
}

/** Map quick-create form fields to template generate name/displayName + normalized params. */
export function buildTemplateParamsFromForm(templateId: string, formData: Record<string, unknown>): TemplateFormParams {
  const schema = templateSchemas[templateId]
  const { formFields } = normalizeFormFieldsForCodegen(templateId, formData)

  const displayName =
    pickDisplayName(formFields, 'blockName', 'itemName', 'foodName', 'entityName', 'toolName', 'armorName', 'recipeName') ||
    schema?.name ||
    templateId

  let name =
    pickId(formFields, 'blockId', 'itemId', 'foodId', 'entityId', 'toolId', 'armorId', 'recipeId') ||
    chineseToEnglishId(displayName) ||
    'generated_content'

  name = name.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'generated_content'

  return { templateId, name, displayName, formFields }
}

export function isQuickCreateTemplate(templateId: string): boolean {
  return templateId !== 'custom-recipe' && Boolean(templateSchemas[templateId])
}
