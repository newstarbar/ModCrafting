import React, { useState, useRef, useEffect } from 'react'
import {
  getAllProviders,
  modelDisplayLabel,
  isKnownModel,
  type LlmProviderDef,
} from '../../../shared/llm-providers.ts'
import { allRoutingPresets, TASK_TEMPLATE_LABELS, type ModelRoutingConfig, type RoutingSelection } from '../../../shared/model-routing.ts'

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
  routingConfig?: ModelRoutingConfig
  routingSelection?: RoutingSelection
  onRoutingSelectionChange?: (selection: RoutingSelection) => void
}

const ComposerModelMenu: React.FC<ComposerModelMenuProps> = ({
  providerId,
  modelId,
  onChange,
  onOpenApiSettings,
  disabled,
  routingConfig,
  routingSelection,
  onRoutingSelectionChange,
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
  const routed = routingSelection?.mode === 'routed'
  const selectedPreset = routed ? allRoutingPresets(routingConfig).find((preset) => preset.id === (routingSelection.customPresetId || routingSelection.strategyId)) : null
  const displayLabel = routed ? `${selectedPreset?.label || '路由'} · ${TASK_TEMPLATE_LABELS[routingSelection?.taskTemplateId || 'auto']}` : modelDisplayLabel(modelId, providerId)
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
          {onRoutingSelectionChange && (
            <>
              <div className="composer-menu-group" role="presentation">
                <div className="composer-menu-group-label">多模型路由</div>
                {allRoutingPresets(routingConfig).map((preset) => (
                  <button key={preset.id} type="button" role="menuitem"
                    className={`composer-menu-item${routed && (routingSelection?.customPresetId || routingSelection?.strategyId) === preset.id ? ' composer-menu-item--active' : ''}`}
                    onClick={() => { onRoutingSelectionChange({ mode: 'routed', strategyId: preset.id, customPresetId: preset.builtIn ? undefined : preset.id, taskTemplateId: routingSelection?.taskTemplateId || 'auto' }); setOpen(false) }}>
                    <span className="composer-menu-item-label">{preset.label}</span>
                    <span className="composer-menu-item-meta">{preset.budget.maxDelegations} 次委派</span>
                  </button>
                ))}
              </div>
              {routed && (
                <div className="composer-menu-group" role="presentation">
                  <div className="composer-menu-group-label">任务模板</div>
                  {Object.entries(TASK_TEMPLATE_LABELS).map(([id, label]) => (
                    <button key={id} type="button" role="menuitem" className={`composer-menu-item${routingSelection?.taskTemplateId === id ? ' composer-menu-item--active' : ''}`}
                      onClick={() => { onRoutingSelectionChange({ ...routingSelection!, taskTemplateId: id as RoutingSelection['taskTemplateId'] }); setOpen(false) }}>
                      <span className="composer-menu-item-label">{label}</span>
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="composer-menu-item composer-menu-item--footer" onClick={() => {
                onRoutingSelectionChange({ mode: 'fixed', strategyId: 'single', taskTemplateId: 'auto', model: { providerId, modelId } }); setOpen(false)
              }}>使用固定模型</button>
            </>
          )}
          {providers.filter((p) => p.models.length > 0).map((provider) => (
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
                  onClick={() => { handleSelect(provider, preset); onRoutingSelectionChange?.({ mode: 'fixed', strategyId: 'single', taskTemplateId: 'auto', model: { providerId: provider.id, modelId: preset.id } }) }}
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
