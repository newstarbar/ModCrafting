import React, { useState, useRef, useEffect } from 'react'
import {
  getAllProviders,
  modelDisplayLabel,
  isKnownModel,
  type LlmProviderDef,
} from '../../../shared/llm-providers.ts'

export interface ProviderModelSelection {
  providerId: string
  modelId: string
  endpoint: string
}

interface ComposerModelMenuProps {
  providerId: string
  modelId: string
  onChange: (selection: ProviderModelSelection) => void
  onOpenApiSettings?: () => void
  disabled?: boolean
}

const ComposerModelMenu: React.FC<ComposerModelMenuProps> = ({
  providerId,
  modelId,
  onChange,
  onOpenApiSettings,
  disabled,
}) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const inPresets = isKnownModel(modelId, providerId)
  const displayLabel = modelDisplayLabel(modelId, providerId)
  const providers = getAllProviders()

  const handleSelect = (provider: LlmProviderDef, model: { id: string }) => {
    onChange({
      providerId: provider.id,
      modelId: model.id,
      endpoint: provider.baseUrl,
    })
    setOpen(false)
  }

  return (
    <div className="composer-menu composer-menu--model" ref={rootRef}>
      <button
        type="button"
        className="composer-menu-trigger composer-menu-trigger--model"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={modelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="composer-menu-trigger-text">{displayLabel}</span>
        <span className="composer-menu-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="composer-menu-popover composer-menu-popover--grouped" role="menu">
          {providers.map((provider) => (
            <div key={provider.id} className="composer-menu-group" role="presentation">
              <div className="composer-menu-group-label">{provider.label}</div>
              {provider.models.map((preset) => (
                <button
                  key={`${provider.id}:${preset.id}`}
                  type="button"
                  role="menuitem"
                  className={`composer-menu-item${
                    providerId === provider.id && modelId === preset.id ? ' composer-menu-item--active' : ''
                  }`}
                  onClick={() => handleSelect(provider, preset)}
                >
                  <span className="composer-menu-item-label">{preset.label}</span>
                  {providerId === provider.id && modelId === preset.id && (
                    <span className="composer-menu-check" aria-hidden>✓</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {!inPresets && modelId && (
            <div className="composer-menu-custom" role="presentation">
              当前：{displayLabel}
            </div>
          )}
          {onOpenApiSettings && (
            <button
              type="button"
              className="composer-menu-item composer-menu-item--footer"
              onClick={() => {
                setOpen(false)
                onOpenApiSettings()
              }}
            >
              自定义模型…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ComposerModelMenu
