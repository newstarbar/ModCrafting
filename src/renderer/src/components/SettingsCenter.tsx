import React, { useEffect, useMemo, useState } from 'react'
import ToolsPanel from './ToolsPanel'
import SettingsSelect from './SettingsSelect'
import {
  CUSTOM_PROVIDER_ID, getAllProviders, getProvider
} from '../../../shared/llm-providers.ts'
import {
  AGENT_ROLE_IDS, COMPANION_EXPERT_ROLE_IDS, ROLE_LABELS, TASK_TEMPLATE_LABELS, allRoutingPresets,
  findRoutingPreset, type AgentRoleId, type CompanionExpertRoleId, type ModelRef, type ModelRoutingConfig,
  type RoutingPreset, type TaskTemplateId
} from '../../../shared/model-routing.ts'
import type { ApiConfigState, ApiSettingsPayload } from '../types/api-config'

type SettingsSection = 'models' | 'tools' | 'knowledge' | 'runtime' | 'updates' | 'about'

const SECTION_LABELS: Array<[SettingsSection, string, string]> = [
  ['models', '模型', '主厂商连接与默认策略'],
  ['tools', '工具与 MCP', '能力与外部工具'],
  ['knowledge', '知识库', 'Minecraft 与 Fabric 文档'],
  ['runtime', '运行环境与存储', 'JDK、Gradle 与数据目录'],
  ['updates', '更新', '版本检查'],
  ['about', '关于', 'ModCrafting']
]

const PRIMARY_STRATEGY_IDS = ['fast', 'balanced', 'deep'] as const

export type SettingsFocus = { section?: SettingsSection; advanced?: boolean }

interface SettingsCenterProps {
  apiConfig: ApiConfigState
  savedProviderIds: string[]
  encryptionAvailable: boolean
  onApiSettingsChange: (config: ApiSettingsPayload) => Promise<void> | void
  onApiKeySave: (key: string, providerId?: string) => Promise<void> | void
  routingConfig: ModelRoutingConfig
  onRoutingConfigChange: (config: ModelRoutingConfig) => Promise<void> | void
  onClose: () => void
  initialFocus?: SettingsFocus
}

function modelOptions(): Array<{ value: string; label: string }> {
  return getAllProviders().flatMap((provider) => provider.models.map((model) => ({ value: `${provider.id}:${model.id}`, label: `${provider.label} · ${model.label}` })))
}

function modelRefFromValue(value: string): ModelRef {
  const [providerId, ...tail] = value.split(':')
  return { providerId, modelId: tail.join(':') }
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiConfig, savedProviderIds, encryptionAvailable, onApiSettingsChange, onApiKeySave,
  routingConfig, onRoutingConfigChange, onClose, initialFocus
}) => {
  const needsOnboarding = !routingConfig.onboardingCompleted
  const [section, setSection] = useState<SettingsSection>(initialFocus?.section || 'models')
  const [providerId, setProviderId] = useState(apiConfig.providerId)
  const [providerConfig, setProviderConfig] = useState({ endpoint: apiConfig.endpoint, model: apiConfig.model, protocol: apiConfig.protocol })
  const [keyDraft, setKeyDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(
    apiConfig.providerId === CUSTOM_PROVIDER_ID
  )
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(initialFocus?.advanced))
  const [expertEditorOpen, setExpertEditorOpen] = useState(false)
  const [presetDraftId, setPresetDraftId] = useState(routingConfig.defaultSelection.strategyId)
  const [importText, setImportText] = useState('')
  const [deepseekBalance, setDeepseekBalance] = useState<{ loading: boolean; text: string; detail?: string; error?: string } | null>(null)
  const [runtimePath, setRuntimePath] = useState('')
  const [runtimePathLoading, setRuntimePathLoading] = useState(false)
  const [runtimeMigrating, setRuntimeMigrating] = useState(false)
  const [runtimeMessage, setRuntimeMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [isPortable, setIsPortable] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<{
    ok: boolean; currentVersion: string; latestVersion?: string; hasUpdate?: boolean; error?: string
  } | null>(null)

  const provider = getProvider(providerId)
  const homeProviderId = routingConfig.homeProviderId || 'deepseek'
  const availableModels = useMemo(() => modelOptions(), [])
  const selectedPreset = findRoutingPreset(routingConfig, presetDraftId)
  const primaryStrategyCards = useMemo(
    () => allRoutingPresets(routingConfig).filter((preset) => (PRIMARY_STRATEGY_IDS as readonly string[]).includes(preset.id)),
    [routingConfig]
  )
  const customPresets = useMemo(
    () => routingConfig.presets.filter((preset) => !preset.builtIn),
    [routingConfig.presets]
  )
  const selectedDefaultId = routingConfig.defaultSelection.customPresetId || routingConfig.defaultSelection.strategyId
  const selectedDefaultPreset = findRoutingPreset(routingConfig, selectedDefaultId)
  const companionExpertRoles = new Set(routingConfig.companionExpertRoles || ['codeReviewer'])
  const companionProviderOptions = useMemo(() => {
    return [
      { value: '', label: '关闭（仅主厂商）' },
      ...getAllProviders()
        .filter((item) => item.id !== homeProviderId)
        .map((item) => ({
          value: item.id,
          label: item.label,
          saved: savedProviderIds.includes(item.id)
        }))
    ]
  }, [homeProviderId, savedProviderIds])
  const isCustomProvider = providerId === CUSTOM_PROVIDER_ID
  const showConnectionDetails = connectionDetailsOpen || isCustomProvider

  useEffect(() => {
    if (!initialFocus) return
    if (initialFocus.section) setSection(initialFocus.section)
    if (initialFocus.advanced) setAdvancedOpen(true)
  }, [initialFocus])

  useEffect(() => {
    setProviderId(apiConfig.providerId || homeProviderId)
  }, [apiConfig.providerId, homeProviderId])

  useEffect(() => {
    let cancelled = false
    void window.api.loadApiConfigForProvider(providerId).then((next: { endpoint: string; model: string; protocol?: ApiConfigState['protocol'] }) => {
      if (!cancelled) setProviderConfig({ endpoint: next.endpoint, model: next.model, protocol: next.protocol })
    })
    return () => { cancelled = true }
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    setRuntimePathLoading(true)
    void Promise.all([
      window.api.appConfigGetEffectiveRuntimePath(),
      window.api.getEdition()
    ]).then(([root, edition]) => {
      if (cancelled) return
      setRuntimePath(root || '')
      setIsPortable(edition === 'portable')
      setRuntimePathLoading(false)
    }).catch((error) => {
      if (!cancelled) {
        setRuntimePathLoading(false)
        setRuntimeMessage({ kind: 'error', text: `读取数据目录失败：${error instanceof Error ? error.message : String(error)}` })
      }
    })
    return () => { cancelled = true }
  }, [])

  const refreshDeepSeekBalance = async (opts?: { useDraftKey?: boolean }) => {
    if (providerId !== 'deepseek') return
    setDeepseekBalance({ loading: true, text: '查询中…' })
    try {
      const draft = opts?.useDraftKey ? keyDraft.trim() : ''
      const result = await window.api.fetchDeepSeekBalance(draft || undefined)
      if (!result.success) {
        setDeepseekBalance({ loading: false, text: '—', error: result.error || '查询失败' })
        return
      }
      const preferred = result.balances?.find((b: { currency?: string; totalBalance?: string; grantedBalance?: string; toppedUpBalance?: string }) => b.currency === result.displayCurrency) ?? result.balances?.[0]
      const symbol = result.displayCurrency === 'USD' ? '$' : '￥'
      const total = result.displayTotal ?? preferred?.totalBalance ?? '0'
      const detail = preferred
        ? `赠送 ${symbol}${preferred.grantedBalance} · 充值 ${symbol}${preferred.toppedUpBalance}` + (result.isAvailable === false ? ' · 余额暂不可用于 API' : '')
        : undefined
      setDeepseekBalance({ loading: false, text: `${symbol}${total}`, detail })
    } catch (error) {
      setDeepseekBalance({ loading: false, text: '—', error: error instanceof Error ? error.message : String(error) })
    }
  }

  useEffect(() => {
    if (section !== 'models' || providerId !== 'deepseek') return
    if (!savedProviderIds.includes('deepseek')) {
      setDeepseekBalance({ loading: false, text: '—', error: '请先保存 API Key' })
      return
    }
    void refreshDeepSeekBalance()
  }, [section, providerId, savedProviderIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveProvider = async () => {
    await onApiSettingsChange({ providerId, endpoint: providerConfig.endpoint, model: providerConfig.model, protocol: providerConfig.protocol })
    const nextHome = {
      ...routingConfig,
      homeProviderId: providerId,
      ...(routingConfig.companionProviderId === providerId
        ? { companionProviderId: undefined }
        : {})
    }
    await onRoutingConfigChange(nextHome)
    setNotice('主厂商连接已保存')
  }
  const saveKey = async () => {
    if (!keyDraft.trim()) return
    await onApiKeySave(keyDraft, providerId)
    setKeyDraft('')
    setNotice('API Key 已加密保存')
    if (providerId === 'deepseek') window.setTimeout(() => { void refreshDeepSeekBalance() }, 100)
  }
  const updateConfig = async (next: ModelRoutingConfig) => {
    await onRoutingConfigChange(next)
    setNotice('路由配置已保存')
  }
  const updateCompanionProvider = async (nextId: string) => {
    const companionProviderId = nextId.trim() || undefined
    await updateConfig({
      ...routingConfig,
      companionProviderId,
      companionExpertRoles: routingConfig.companionExpertRoles?.length
        ? routingConfig.companionExpertRoles
        : ['codeReviewer']
    })
  }
  const toggleCompanionExpertRole = async (roleId: CompanionExpertRoleId) => {
    const current = new Set(routingConfig.companionExpertRoles || ['codeReviewer'])
    if (current.has(roleId)) current.delete(roleId)
    else current.add(roleId)
    const next = [...COMPANION_EXPERT_ROLE_IDS].filter((role) => current.has(role))
    await updateConfig({
      ...routingConfig,
      companionExpertRoles: next.length ? next : ['codeReviewer']
    })
  }
  const selectDefaultStrategy = async (id: string) => {
    const preset = findRoutingPreset(routingConfig, id)
    const next = {
      ...routingConfig,
      onboardingCompleted: true,
      defaultSelection: {
        mode: 'routed' as const,
        strategyId: id,
        taskTemplateId: routingConfig.defaultSelection.taskTemplateId || 'auto' as TaskTemplateId,
        customPresetId: preset.builtIn ? undefined : id
      }
    }
    setPresetDraftId(id)
    await updateConfig(next)
  }
  const updateDefaultTemplate = async (taskTemplateId: TaskTemplateId) => {
    await updateConfig({
      ...routingConfig,
      defaultSelection: { ...routingConfig.defaultSelection, taskTemplateId }
    })
  }
  const updateBinding = async (roleId: AgentRoleId, field: 'primary' | 'fallbacks' | 'enabled' | 'required', value: ModelRef | boolean) => {
    const preset = findRoutingPreset(routingConfig, presetDraftId)
    if (preset.builtIn) { setNotice('内置预设不可编辑，请先复制为自定义预设。'); return }
    const nextPreset: RoutingPreset = { ...preset, roles: { ...preset.roles, [roleId]: { ...preset.roles[roleId], [field]: value } } }
    await updateConfig({ ...routingConfig, presets: routingConfig.presets.map((item) => item.id === nextPreset.id ? nextPreset : item) })
  }
  const duplicatePreset = async () => {
    const source = findRoutingPreset(routingConfig, presetDraftId)
    const id = `custom-${Date.now().toString(36)}`
    const next: RoutingPreset = {
      ...source,
      id,
      label: `${source.label} 副本`,
      builtIn: false,
      roles: Object.fromEntries(AGENT_ROLE_IDS.map((role) => {
        const binding = source.roles[role]
        return [role, {
          ...binding,
          fallbacks: [...binding.fallbacks],
          ...(binding.byDifficulty
            ? {
                byDifficulty: Object.fromEntries(
                  Object.entries(binding.byDifficulty).map(([tier, tierBinding]) => [tier, {
                    primary: { ...tierBinding.primary },
                    ...(tierBinding.fallbacks ? { fallbacks: tierBinding.fallbacks.map((item) => ({ ...item })) } : {})
                  }])
                )
              }
            : {})
        }]
      })) as RoutingPreset['roles']
    }
    setPresetDraftId(id)
    setAdvancedOpen(true)
    setExpertEditorOpen(true)
    await updateConfig({ ...routingConfig, presets: [...routingConfig.presets, next] })
  }
  const deleteCustomPreset = async (id: string) => {
    const target = routingConfig.presets.find((preset) => preset.id === id && !preset.builtIn)
    if (!target) return
    const nextPresets = routingConfig.presets.filter((preset) => preset.id !== id)
    const wasSelected = selectedDefaultId === id
    const nextSelection = wasSelected
      ? {
          mode: 'routed' as const,
          strategyId: 'balanced',
          taskTemplateId: routingConfig.defaultSelection.taskTemplateId || 'auto' as TaskTemplateId
        }
      : routingConfig.defaultSelection
    if (presetDraftId === id) setPresetDraftId(wasSelected ? 'balanced' : routingConfig.defaultSelection.strategyId)
    await updateConfig({
      ...routingConfig,
      presets: nextPresets,
      defaultSelection: nextSelection
    })
  }
  const exportPreset = async () => {
    const source = findRoutingPreset(routingConfig, presetDraftId)
    await navigator.clipboard.writeText(JSON.stringify({ version: 1, preset: { ...source, builtIn: false } }, null, 2))
    setNotice('无密钥预设 JSON 已复制到剪贴板')
  }
  const importPreset = async () => {
    try {
      const parsed = JSON.parse(importText) as { version?: number; preset?: RoutingPreset }
      if (parsed.version !== 1 || !parsed.preset?.id || !parsed.preset.roles) throw new Error('不是有效的预设文件')
      const id = `custom-${Date.now().toString(36)}`
      const next = { ...parsed.preset, id, builtIn: false, label: `${parsed.preset.label} 导入` }
      setPresetDraftId(id)
      setImportText('')
      setAdvancedOpen(true)
      setExpertEditorOpen(true)
      await updateConfig({ ...routingConfig, presets: [...routingConfig.presets, next] })
    } catch (error) { setNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const changeRuntimeDir = async () => {
    if (runtimeMigrating || isPortable) return
    setRuntimeMessage(null)
    try {
      const picked = await window.api.appConfigSelectDirectory()
      if (!picked) {
        setRuntimeMessage({ kind: 'info', text: '已取消' })
        return
      }
      const target = `${picked.replace(/[\\/]+$/, '')}\\ModCrafting-Data\\runtime`
      if (target === runtimePath) {
        setRuntimeMessage({ kind: 'info', text: '选择的目录与当前路径相同' })
        return
      }
      setRuntimeMigrating(true)
      setRuntimeMessage({ kind: 'info', text: '正在停止 Gradle 并迁移数据，请稍候…' })
      const result = await window.api.appConfigMigrateRuntime(target)
      if (!result.success) {
        setRuntimeMessage({ kind: 'error', text: result.error || '迁移失败' })
        return
      }
      setRuntimePath(target)
      setRuntimeMessage({
        kind: 'success',
        text: result.migrated
          ? `数据已迁移到新位置。${result.requireRestart ? '请重启应用以使新路径完全生效。' : ''}`
          : '数据目录已更新。请重启应用以使新路径完全生效。'
      })
    } catch (error) {
      setRuntimeMessage({ kind: 'error', text: `操作失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setRuntimeMigrating(false)
    }
  }

  const checkUpdates = async () => {
    setUpdateChecking(true)
    setUpdateResult(null)
    try {
      const result = await window.api.checkForUpdates()
      setUpdateResult(result)
    } catch (error) {
      setUpdateResult({ ok: false, currentVersion: '', error: error instanceof Error ? error.message : String(error) })
    } finally {
      setUpdateChecking(false)
    }
  }

  const renderModels = () => (
    <div className="settings-page-content">
      <h2>模型</h2>
      <p className="mc-dim">配置主厂商与新会话默认策略；日常在输入区临时切换即可。</p>
      {needsOnboarding && (
        <div className="settings-onboarding-banner">首次使用：保存一把 API Key，再选快速 / 均衡 / 深度之一。</div>
      )}

      <div className="settings-card">
        <h3>主厂商</h3>
        <label>厂商</label>
        <SettingsSelect
          value={providerId}
          options={[...getAllProviders(), { id: CUSTOM_PROVIDER_ID, label: '自定义 OpenAI 兼容服务', baseUrl: '', docsUrl: '', keyHint: '', models: [] }].map((item) => ({
            value: item.id,
            label: `${item.label}${item.id === homeProviderId ? '（当前主厂）' : ''}`,
            saved: savedProviderIds.includes(item.id)
          }))}
          onChange={(nextId) => {
            setProviderId(nextId)
            if (nextId === CUSTOM_PROVIDER_ID) setConnectionDetailsOpen(true)
          }}
        />
        <label>API Key {savedProviderIds.includes(providerId) && <span className="settings-saved">已保存</span>}</label>
        <input className="mc-input" type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder={encryptionAvailable ? '输入新值以保存或覆盖' : '当前系统不可安全保存密钥'} disabled={!encryptionAvailable} />
        <div className="settings-actions">
          <button className="mc-btn mc-btn--primary" disabled={!keyDraft.trim() || !encryptionAvailable} onClick={() => void saveKey()}>保存加密密钥</button>
          {provider?.docsUrl && <button className="mc-btn" onClick={() => void window.api.openExternalUrl(provider.docsUrl)}>获取 API Key</button>}
          <button className="mc-btn mc-btn--primary" onClick={() => void saveProvider()}>设为主厂商</button>
        </div>
        {providerId === 'deepseek' && (
          <div className="settings-inline" style={{ marginTop: 8, justify: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>余额</strong>
            <span style={{ fontWeight: 600 }}>{deepseekBalance?.text ?? '—'}</span>
            <button type="button" className="mc-btn" disabled={deepseekBalance?.loading} onClick={() => void refreshDeepSeekBalance({ useDraftKey: true })}>
              {deepseekBalance?.loading ? '查询中…' : '刷新'}
            </button>
            {deepseekBalance?.detail && <span className="mc-dim">{deepseekBalance.detail}</span>}
            {deepseekBalance?.error && <span className="mc-dim" style={{ color: 'var(--error)' }}>{deepseekBalance.error}</span>}
          </div>
        )}
        {!isCustomProvider && (
          <button
            type="button"
            className="mc-btn"
            style={{ marginTop: 10, alignSelf: 'flex-start' }}
            onClick={() => setConnectionDetailsOpen((value) => !value)}
          >
            {showConnectionDetails ? '收起连接详情' : '连接详情（地址 / 默认模型）'}
          </button>
        )}
        {showConnectionDetails && (
          <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
            <label>API 地址</label>
            <input className="mc-input" value={providerConfig.endpoint} onChange={(event) => setProviderConfig((prev) => ({ ...prev, endpoint: event.target.value }))} placeholder="https://api.example.com/v1" />
            <label>默认模型（固定单模型模式时使用）</label>
            {provider?.models.length
              ? <SettingsSelect value={providerConfig.model} options={provider.models.map((model) => ({ value: model.id, label: model.label }))} onChange={(model) => setProviderConfig((prev) => ({ ...prev, model }))} />
              : <input className="mc-input" value={providerConfig.model} onChange={(event) => setProviderConfig((prev) => ({ ...prev, model: event.target.value }))} placeholder="model-id" />}
            <button className="mc-btn" onClick={() => void saveProvider()}>保存连接详情</button>
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>默认策略</h3>
        <p className="mc-dim">新会话继承此处选择；输入区可临时改。</p>
        <div className="settings-strategy-cards settings-strategy-cards--primary">
          {primaryStrategyCards.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`settings-strategy-card${selectedDefaultId === preset.id ? ' active' : ''}`}
              onClick={() => void selectDefaultStrategy(preset.id)}
            >
              <strong>{preset.label}</strong>
              <span>{preset.description}</span>
            </button>
          ))}
        </div>
        {selectedDefaultPreset && !(PRIMARY_STRATEGY_IDS as readonly string[]).includes(selectedDefaultPreset.id) && (
          <p className="mc-dim" style={{ marginTop: 10 }}>
            当前默认是自定义策略「{selectedDefaultPreset.label}」。可在下方高级区管理，或改选上方三项之一。
          </p>
        )}
      </div>

      <button type="button" className="settings-advanced-toggle" onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen}>
        <span>
          <strong>高级</strong>
          <span className="mc-dim" style={{ display: 'block', marginTop: 4 }}>伴厂商、自定义策略、角色绑定</span>
        </span>
        <span aria-hidden>{advancedOpen ? '▾' : '▸'}</span>
      </button>

      {advancedOpen && (
        <>
          <div className="settings-card" style={{ marginTop: 12 }}>
            <h3>伴厂商（可选）</h3>
            <p className="mc-dim">最多 1 个，用于第三方代码审查等；默认关闭。</p>
            <label>第二厂商</label>
            <SettingsSelect
              value={routingConfig.companionProviderId || ''}
              options={companionProviderOptions}
              onChange={(value) => void updateCompanionProvider(value)}
            />
            <label className="settings-inline" style={{ gap: 8, marginTop: 10 }}>
              <input
                type="checkbox"
                checked={companionExpertRoles.has('codeReviewer')}
                disabled={!routingConfig.companionProviderId}
                onChange={() => void toggleCompanionExpertRole('codeReviewer')}
              />
              <span>代码审查走伴厂商</span>
            </label>
            <label className="settings-inline" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={companionExpertRoles.has('visualReviewer')}
                disabled={!routingConfig.companionProviderId}
                onChange={() => void toggleCompanionExpertRole('visualReviewer')}
              />
              <span>视觉审查走伴厂商（通常不必）</span>
            </label>
          </div>

          <div className="settings-card">
            <h3>自定义策略</h3>
            <p className="mc-dim">从内置策略复制后可改角色模型；不需要的副本可删除。</p>
            <div className="settings-inline">
              <label>基于</label>
              <SettingsSelect
                value={presetDraftId}
                options={allRoutingPresets(routingConfig).map((preset) => ({
                  value: preset.id,
                  label: `${preset.builtIn ? '内置 · ' : '自定义 · '}${preset.label}`
                }))}
                onChange={setPresetDraftId}
              />
            </div>
            <div className="settings-actions">
              <button className="mc-btn" onClick={() => void duplicatePreset()}>复制为自定义</button>
              {!selectedPreset.builtIn && (
                <>
                  <button className="mc-btn mc-btn--primary" onClick={() => void selectDefaultStrategy(selectedPreset.id)}>设为默认</button>
                  <button className="mc-btn" onClick={() => void deleteCustomPreset(selectedPreset.id)}>删除</button>
                </>
              )}
              <button className="mc-btn" onClick={() => void exportPreset()}>导出 JSON</button>
            </div>
            {customPresets.length > 0 && (
              <ul className="settings-custom-preset-list">
                {customPresets.map((preset) => (
                  <li key={preset.id}>
                    <span>{preset.label}{selectedDefaultId === preset.id ? '（当前默认）' : ''}</span>
                    <span className="settings-actions">
                      <button type="button" className="mc-btn" onClick={() => { setPresetDraftId(preset.id); setExpertEditorOpen(true) }}>编辑</button>
                      <button type="button" className="mc-btn" onClick={() => void deleteCustomPreset(preset.id)}>删除</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            className="settings-advanced-toggle"
            onClick={() => setExpertEditorOpen((value) => !value)}
            aria-expanded={expertEditorOpen}
          >
            <span>
              <strong>专家编辑</strong>
              <span className="mc-dim" style={{ display: 'block', marginTop: 4 }}>任务模板、角色绑定、导入预设</span>
            </span>
            <span aria-hidden>{expertEditorOpen ? '▾' : '▸'}</span>
          </button>

          {expertEditorOpen && (
            <>
              <div className="settings-card" style={{ marginTop: 12 }}>
                <div className="settings-inline">
                  <label>默认任务模板</label>
                  <SettingsSelect
                    value={routingConfig.defaultSelection.taskTemplateId}
                    options={Object.entries(TASK_TEMPLATE_LABELS).map(([id, label]) => ({ value: id, label }))}
                    onChange={(value) => void updateDefaultTemplate(value as TaskTemplateId)}
                  />
                </div>
                <p className="mc-dim">一般保持「自动」即可。</p>
              </div>
              <div className="settings-card">
                <p className="mc-dim">正在编辑：{selectedPreset.builtIn ? `内置「${selectedPreset.label}」（只读，请先复制）` : `自定义「${selectedPreset.label}」`}</p>
              </div>
              <div className="settings-role-list">
                {AGENT_ROLE_IDS.map((roleId) => {
                  const binding = selectedPreset.roles[roleId]
                  return (
                    <div className="settings-role-row" key={roleId}>
                      <div>
                        <strong>{ROLE_LABELS[roleId]}</strong>
                        <span>{roleId === 'implementer' ? '唯一写入者' : roleId === 'visualReviewer' ? '视觉能力必需' : roleId === 'codeReviewer' ? '可挂伴厂' : '只读或协调'}</span>
                      </div>
                      <SettingsSelect
                        value={`${binding.primary.providerId}:${binding.primary.modelId}`}
                        options={availableModels}
                        onChange={(value) => void updateBinding(roleId, 'primary', modelRefFromValue(value))}
                      />
                      <span className="mc-dim">备用 {binding.fallbacks.length}</span>
                    </div>
                  )
                })}
              </div>
              <div className="settings-card">
                <h3>导入无密钥预设</h3>
                <textarea className="mc-input settings-json" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴导出的预设 JSON" />
                <button className="mc-btn" onClick={() => void importPreset()}>导入</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )

  const renderRuntime = () => (
    <div className="settings-page-content">
      <h2>运行环境与存储</h2>
      <div className="settings-card">
        <h3>数据目录</h3>
        <p className="mc-dim">{isPortable ? '便携版数据目录（跟随 exe 位置）' : 'JDK / Gradle / 依赖缓存约 1–2 GB'}</p>
        <p style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{runtimePathLoading ? '加载中…' : (runtimePath || '—')}</p>
        {!isPortable && (
          <button className="mc-btn" disabled={runtimeMigrating} onClick={() => void changeRuntimeDir()}>
            {runtimeMigrating ? '迁移中…' : '修改数据目录'}
          </button>
        )}
        {runtimeMessage && <p className="mc-dim" style={{ color: runtimeMessage.kind === 'error' ? 'var(--error)' : runtimeMessage.kind === 'success' ? 'var(--success)' : undefined }}>{runtimeMessage.text}</p>}
        <p className="mc-dim">修改后会自动迁移已下载的数据；迁移前会停止 Gradle daemon。</p>
      </div>
    </div>
  )

  const renderUpdates = () => (
    <div className="settings-page-content">
      <h2>更新</h2>
      <div className="settings-card">
        <button className="mc-btn" disabled={updateChecking} onClick={() => void checkUpdates()}>
          {updateChecking ? '检查中…' : '检查更新'}
        </button>
        {updateResult && (
          <p className="mc-dim" style={{ marginTop: 10, color: updateResult.ok ? (updateResult.hasUpdate ? 'var(--success)' : undefined) : 'var(--error)' }}>
            {updateResult.ok
              ? updateResult.hasUpdate
                ? `发现新版本：v${updateResult.latestVersion}（当前 v${updateResult.currentVersion}）`
                : `已是最新版本（v${updateResult.currentVersion}）`
              : `检查失败：${updateResult.error || '未知错误'}`}
          </p>
        )}
      </div>
    </div>
  )

  let content: React.ReactNode = renderModels()
  if (section === 'tools') content = <div className="settings-page-content"><h2>工具与 MCP</h2><ToolsPanel mode="tools" onConfigSaved={() => setNotice('工具配置已保存')} /></div>
  else if (section === 'runtime') content = renderRuntime()
  else if (section === 'updates') content = renderUpdates()
  else if (section === 'about') content = <div className="settings-page-content"><h2>关于</h2><div className="settings-card"><p>AI 驱动的我的世界 Fabric 模组开发环境。</p><p className="mc-dim">核心功能：AI 智能体对话 / 代码生成 / 编译终端 / MC 运行管理</p></div></div>
  else if (section === 'knowledge') content = <div className="settings-page-content"><h2>知识库</h2><ToolsPanel mode="knowledge" onConfigSaved={() => setNotice('知识库配置已保存')} /></div>
  else if (section === 'models') content = renderModels()

  return (
    <main className="settings-center">
      <aside className="settings-nav">
        <div className="settings-nav-title">设置</div>
        {SECTION_LABELS.map(([id, label, hint]) => (
          <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
            <span>{label}</span>
            <small>{hint}</small>
          </button>
        ))}
        <button className="settings-back" onClick={onClose}>← 返回工作区</button>
      </aside>
      <section className="settings-main">
        <header>
          <div>
            <span className="mc-label-sm">MODCRAFTING</span>
            <h1>{SECTION_LABELS.find(([id]) => id === section)?.[1]}</h1>
          </div>
          {notice && <span className="settings-notice">{notice}</span>}
        </header>
        {content}
      </section>
    </main>
  )
}

export default SettingsCenter
