import { useState, useEffect, useCallback } from 'react'
import { templateSchemas, FormField, generatePromptFromForm, chineseToEnglishId } from './template-schemas'

interface TemplateFormPanelProps {
  templateId: string
  onConfirm: (prompt: string) => void
  onCancel: () => void
}

function renderField(
  field: FormField,
  value: unknown,
  customValue: string,
  onChange: (key: string, value: unknown) => void,
  onCustomChange: (key: string, value: string) => void
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
    </div>
  )
}

export default function TemplateFormPanel({ templateId, onConfirm, onCancel }: TemplateFormPanelProps) {
  const schema = templateSchemas[templateId]
  const [formData, setFormData] = useState<Record<string, unknown>>({})
  const [customValues, setCustomValues] = useState<Record<string, string>>({})

  useEffect(() => {
    const initialData: Record<string, unknown> = {}
    schema?.fields.forEach((field) => {
      if (field.defaultValue !== undefined) {
        initialData[field.key] = field.defaultValue
      }
    })
    setFormData(initialData)
    setCustomValues({})
  }, [templateId])

  const handleChange = useCallback((key: string, value: unknown) => {
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
    const prompt = generatePromptFromForm(templateId, formData)
    onConfirm(prompt)
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
          {schema.fields.map((field) =>
            renderField(field, formData[field.key], customValues[field.key] || '', handleChange, handleCustomChange)
          )}
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
