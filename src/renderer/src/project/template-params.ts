import { chineseToEnglishId, templateSchemas } from '../components/template-schemas.ts'

export interface TemplateFormParams {
  templateId: string
  name: string
  displayName?: string
  formFields: Record<string, unknown>
}

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

/** Map quick-create form fields to template generate name/displayName + raw params. */
export function buildTemplateParamsFromForm(templateId: string, formData: Record<string, unknown>): TemplateFormParams {
  const schema = templateSchemas[templateId]
  const displayName =
    pickDisplayName(formData, 'blockName', 'itemName', 'foodName', 'entityName', 'toolName', 'armorName', 'recipeName') ||
    schema?.name ||
    templateId

  let name =
    pickId(formData, 'blockId', 'itemId', 'foodId', 'entityId', 'toolId', 'armorId', 'recipeId') ||
    chineseToEnglishId(displayName) ||
    'generated_content'

  name = name.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'generated_content'

  return { templateId, name, displayName, formFields: { ...formData } }
}

export function isQuickCreateTemplate(templateId: string): boolean {
  return templateId !== 'custom-recipe' && Boolean(templateSchemas[templateId])
}
