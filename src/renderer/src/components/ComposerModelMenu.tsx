import React, { useState, useRef, useEffect, useMemo } from 'react'
import {
  getAllProviders,
  getProvider,
  modelDisplayLabel,
  isKnownModel,
  type LlmProviderDef,
} from '../../../shared/llm-providers.ts'
import { allRoutingPresets, type ModelRoutingConfig, type RoutingSelection } from '../../../shared/model-routing.ts'

export interface ProviderModelSelection {
  providerId: string
  modelId: string
  endpoint: string
}

const PRIMARY_STRATEGY_IDS = new Set(['fast', 'balanced', 'deep'])

interface ComposerModelMenuProps {
  providerId: string
  modelId: string
  onChange: (selection: ProviderModelSelection) => void
  onOpenApiSettings?: () => void
  onOpenAdvancedRouting?: () => void
  disabled?: boolean
  savedProviderIds?: string[]
  routingConfig?: ModelRoutingConfig
  routingSelection?: RoutingSelection
  onRoutingSelectionChange?: (selection: RoutingSelection) => void
}

const ComposerModelMenu: React.FC<ComposerModelMenuProps> = ({
  providerId,
  modelId,
  onChange,
  onOpenApiSettings,
  onOpenAdvancedRouting,
  disabled,
  savedProviderIds = [],
  routingConfig,
  routingSelection,
  onRoutingSelectionChange,
}) => {
  const [open, setOpen] = useState(false)
  const [showMoreStrategies, setShowMoreStrategies] = useState(false)
  const [showOtherProviders, setShowOtherProviders] = useState(false)
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
  const presets = allRoutingPresets(routingConfig)
  const selectedPreset = routed
    ? presets.find((preset) => preset.id === (routingSelection.customPresetId || routingSelection.strategyId))
    : null
  const homeProviderId = routingConfig?.homeProviderId || providerId || 'deepseek'
  const homeProviderLabel = getProvider(homeProviderId)?.label || homeProviderId
  const companionEnabled = Boolean(routingConfig?.companionProviderId)
  const displayLabel = routed
    ? (selectedPreset?.label || '路由策略')
    : modelDisplayLabel(modelId, providerId)

  const primaryPresets = presets.filter((preset) => PRIMARY_STRATEGY_IDS.has(preset.id) || !preset.builtIn)
  const morePresets = presets.filter((preset) => preset.builtIn && !PRIMARY_STRATEGY_IDS.has(preset.id))
  const visibleStrategies = showMoreStrategies ? [...primaryPresets, ...morePresets] : primaryPresets

  const { homeProviders, otherProviders } = useMemo(() => {
    const saved = new Set(savedProviderIds)
    const connected = getAllProviders().filter((provider) => saved.has(provider.id) && provider.models.length > 0)
    return {
      homeProviders: connected.filter((provider) => provider.id === homeProviderId),
      otherProviders: connected.filter((provider) => provider.id !== homeProviderId)
    }
  }, [savedProviderIds, homeProviderId])

  const selectStrategy = (presetId: string, builtIn: boolean) => {
    onRoutingSelectionChange?.({
      mode: 'routed',
      strategyId: presetId,
      customPresetId: builtIn ? undefined : presetId,
      taskTemplateId: 'auto'
    })
    setOpen(false)
  }

  const handleSelect = (provider: LlmProviderDef, model: { id: string }) => {
    onChange({
      providerId: provider.id,
      modelId: model.id,
      endpoint: provider.baseUrl,
    })
    onRoutingSelectionChange?.({
      mode: 'fixed',
      strategyId: 'single',
      taskTemplateId: 'auto',
      model: { providerId: provider.id, modelId: model.id }
    })
    setOpen(false)
  }

  const renderProviderGroup = (provider: LlmProviderDef) => (
    <div key={provider.id} className="composer-menu-subgroup" role="presentation">
      <div className="composer-menu-subgroup-label">{provider.label}</div>
      {provider.models.map((preset) => (
        <button
          key={`${provider.id}:${preset.id}`}
          type="button"
          role="menuitem"
          className={`composer-menu-item${
            !routed && providerId === provider.id && modelId === preset.id ? ' composer-menu-item--active' : ''
          }`}
          onClick={() => handleSelect(provider, preset)}
        >
          <span className="composer-menu-item-label">{preset.label}</span>
          {!routed && providerId === provider.id && modelId === preset.id && (
            <span className="composer-menu-check" aria-hidden>✓</span>
          )}
        </button>
      ))}
    </div>
  )

  return (
    <div className="composer-menu composer-menu--model" ref={rootRef}>
      <button
        type="button"
        className="composer-menu-trigger composer-menu-trigger--model"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={routed ? `路由 · ${selectedPreset?.label || '策略'}` : modelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="composer-menu-trigger-text">{displayLabel}</span>
        <span className="composer-menu-chevron" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="composer-menu-popover composer-menu-popover--grouped" role="menu">
          {onRoutingSelectionChange && (
            <div className="composer-menu-group" role="presentation">
              <div className="composer-menu-group-label">路由策略</div>
              {visibleStrategies.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitem"
                  className={`composer-menu-item${routed && (routingSelection?.customPresetId || routingSelection?.strategyId) === preset.id ? ' composer-menu-item--active' : ''}`}
                  onClick={() => selectStrategy(preset.id, Boolean(preset.builtIn))}
                >
                  <span className="composer-menu-item-label">{preset.label}</span>
                  <span className="composer-menu-item-meta">
                    {homeProviderLabel} · {preset.budget.maxDelegations} 次委派
                    {companionEnabled ? ' · +专家检测' : ''}
                  </span>
                </button>
              ))}
              {!showMoreStrategies && morePresets.length > 0 && (
                <button
                  type="button"
                  className="composer-menu-item composer-menu-item--footer"
                  onClick={() => setShowMoreStrategies(true)}
                >
                  更多策略…
                </button>
              )}
            </div>
          )}

          <div className="composer-menu-group" role="presentation">
            <div className="composer-menu-group-label">固定模型 · 主厂商</div>
            {homeProviders.length === 0 && otherProviders.length === 0 ? (
              <div className="composer-menu-custom" role="presentation">
                尚未保存任何厂商 API Key。请先「管理模型连接…」。
              </div>
            ) : homeProviders.length === 0 ? (
              <div className="composer-menu-custom" role="presentation">
                主厂商尚未保存 Key；可先在下方展开其他已连接厂商，或去设置保存主厂密钥。
              </div>
            ) : (
              homeProviders.map(renderProviderGroup)
            )}
            {otherProviders.length > 0 && (
              <>
                {!showOtherProviders ? (
                  <button
                    type="button"
                    className="composer-menu-item composer-menu-item--footer"
                    onClick={() => setShowOtherProviders(true)}
                  >
                    其他已连接厂商（{otherProviders.length}）…
                  </button>
                ) : (
                  <>
                    <div className="composer-menu-group-label">其他已连接厂商</div>
                    {otherProviders.map(renderProviderGroup)}
                  </>
                )}
              </>
            )}
            {!routed && !inPresets && modelId && (
              <div className="composer-menu-custom" role="presentation">
                当前：{displayLabel}
              </div>
            )}
          </div>

          {onOpenApiSettings && (
            <button
              type="button"
              className="composer-menu-item composer-menu-item--footer"
              onClick={() => {
                setOpen(false)
                onOpenApiSettings()
              }}
            >
              管理模型连接…
            </button>
          )}
          {onOpenAdvancedRouting && (
            <button
              type="button"
              className="composer-menu-item composer-menu-item--footer"
              onClick={() => {
                setOpen(false)
                onOpenAdvancedRouting()
              }}
            >
              高级路由…
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ComposerModelMenu
