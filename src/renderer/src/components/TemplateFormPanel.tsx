import { useState, useEffect, useCallback } from 'react'
import { templateSchemas, FormField, generatePromptFromForm, chineseToEnglishId, CraftingGridData } from './template-schemas'
import { formFieldsJsonBlock, isQuickCreateTemplate, normalizeFormFieldsForCodegen } from '../project/template-params'
import CraftingGrid, { GridSlot } from './CraftingGrid'
import TemplatePreview from './mc/TemplatePreview'

interface TemplateFormPanelProps {
  templateId: string
  onConfirm: (result: { prompt: string; templateId: string; formData: Record<string, unknown> }) => void
  onCancel: () => void
}

function validateField(field: FormField, value: unknown): string | null {
  if (!field.required) return null
  if (field.type === 'craftingGrid') return null
  if (field.type === 'checkbox') return null
  if (field.type === 'text') {
    if (!String(value ?? '').trim()) return `${field.label}为必填项`
    return null
  }
  if (field.type === 'number') {
    if (value === '' || value === null || value === undefined || isNaN(Number(value))) {
      return `${field.label}为必填项`
    }
    return null
  }
  if (field.type === 'select') {
    if (!value) return `${field.label}为必填项`
    return null
  }
  if (field.type === 'textarea') {
    if (!String(value ?? '').trim()) return `${field.label}为必填项`
    return null
  }
  return null
}

function createEmptyGrid(): GridSlot[][] {
  return Array(3).fill(null).map(() =>
    Array(3).fill(null).map(() => ({ itemId: '', count: 0 }))
  )
}

function renderField(
  field: FormField,
  value: unknown,
  customValue: string,
  onChange: (key: string, value: unknown) => void,
  onCustomChange: (key: string, value: string) => void,
  errorMessage?: string | null
) {
  const renderInput = () => {
    switch (field.type) {
      case 'text':
        return (
          <input
            type="text"
            className="template-form-input"
            placeholder={field.placeholder}
            value={value as string || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        )
      case 'number':
        return (
          <input
            type="number"
            className="template-form-input"
            placeholder={field.placeholder}
            value={value as number || ''}
            min={field.min}
            max={field.max}
            onChange={(e) => onChange(field.key, e.target.value ? parseFloat(e.target.value) : '')}
          />
        )
      case 'select':
        const isCustomSelected = (value as string) === '__custom__'
        return (
          <div className="template-form-select-wrapper">
            <select
              className="template-form-select"
              value={value as string || ''}
              onChange={(e) => {
                onChange(field.key, e.target.value)
                if (e.target.value !== '__custom__') {
                  onCustomChange(field.key, '')
                }
              }}
            >
              {field.options?.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {field.allowCustom && (
                <option value="__custom__">自定义...</option>
              )}
            </select>
            {isCustomSelected && field.allowCustom && (
              <input
                type="text"
                className="template-form-input template-form-custom-input"
                placeholder={field.customPlaceholder || '请输入自定义内容...'}
                value={customValue}
                onChange={(e) => {
                  onCustomChange(field.key, e.target.value)
                  onChange(field.key, e.target.value)
                }}
                autoFocus
              />
            )}
          </div>
        )
      case 'textarea':
        return (
          <textarea
            className="template-form-textarea"
            placeholder={field.placeholder}
            value={value as string || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
            rows={4}
          />
        )
      case 'checkbox':
        return (
          <input
            type="checkbox"
            checked={value as boolean || false}
            onChange={(e) => onChange(field.key, e.target.checked)}
          />
        )
      case 'craftingGrid':
        const gridData = value as CraftingGridData || {
          grid: createEmptyGrid(),
          outputItem: '',
          outputCount: 1
        }
        return (
          <CraftingGrid
            grid={gridData.grid}
            outputItem={gridData.outputItem}
            outputCount={gridData.outputCount}
            onDataChange={(data) => onChange(field.key, data)}
          />
        )
      default:
        return null
    }
  }

  return (
    <div className="template-form-field" key={field.key}>
      <label className="template-form-label">
        {field.label}
        {field.required && <span className="template-form-required">*</span>}
      </label>
      <div className="template-form-control">
        {renderInput()}
      </div>
      {errorMessage && <span className="template-form-error">{errorMessage}</span>}
    </div>
  )
}

export default function TemplateFormPanel({ templateId, onConfirm, onCancel }: TemplateFormPanelProps) {
  const schema = templateSchemas[templateId]
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [customValues, setCustomValues] = useState<Record<string, string>>({})
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const initialData: Record<string, unknown> = {}
    schema?.fields.forEach((field) => {
      if (field.defaultValue !== undefined) {
        initialData[field.key] = field.defaultValue
      } else if (field.type === 'craftingGrid') {
        initialData[field.key] = {
          grid: createEmptyGrid(),
          outputItem: '',
          outputCount: 1
        }
      }
    })
    setFormData(initialData)
    setCustomValues({})
    setValidationErrors({})
  }, [templateId])

  const handleChange = useCallback((key: string, value: unknown) => {
    setValidationErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setFormData((prev) => {
      const next = { ...prev, [key]: value }

      if (schema) {
        for (const field of schema.fields) {
          if (field.autoGenerateFrom === key && !next[field.key]) {
            const generatedId = chineseToEnglishId(String(value))
            next[field.key] = generatedId
          }
        }
      }

      return next
    })
  }, [schema])

  const handleCustomChange = useCallback((key: string, value: string) => {
    setCustomValues((prev) => ({ ...prev, [key]: value }))
  }, [])

  const handleSubmit = () => {
    const errors: Record<string, string> = {}
    for (const field of schema?.fields ?? []) {
      const err = validateField(field, formData[field.key])
      if (err) errors[field.key] = err
    }
    setValidationErrors(errors)
    if (Object.keys(errors).length > 0) return

    let prompt = generatePromptFromForm(templateId, formData)
    if (isQuickCreateTemplate(templateId)) {
      const { formFields } = normalizeFormFieldsForCodegen(templateId, formData)
      prompt += `\n\n${formFieldsJsonBlock(formFields)}`
    }
    onConfirm({
      prompt,
      templateId,
      formData: { ...formData }
    })
  }

  if (!schema) {
    return null
  }

  return (
    <div className="template-form-overlay" onClick={onCancel}>
      <div className="template-form-panel" onClick={(e) => e.stopPropagation()}>
        <div className="template-form-header">
          <h3 className="template-form-title">{schema.name}</h3>
          <p className="template-form-desc">{schema.description}</p>
          <button className="template-form-close" onClick={onCancel}>
            ×
          </button>
        </div>

        <div className="template-form-body">
          <div className="template-form-fields">
            {schema.fields.map((field) =>
              renderField(field, formData[field.key], customValues[field.key] || '', handleChange, handleCustomChange, validationErrors[field.key])
            )}
          </div>
          <TemplatePreview templateId={templateId} formData={formData} />
        </div>

        <div className="template-form-footer">
          <button className="template-form-btn template-form-btn-cancel" onClick={onCancel}>
            取消
          </button>
          <button className="template-form-btn template-form-btn-confirm" onClick={handleSubmit}>
            确认生成
          </button>
        </div>
      </div>
    </div>
  )
}
