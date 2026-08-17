import React, { useEffect, useMemo, useState } from 'react'
import ToolsPanel from './ToolsPanel'
import SettingsSelect from './SettingsSelect'
import {
  CUSTOM_PROVIDER_ID, getAllProviders, getProvider, resolveSelection,
  type LlmProviderDef
} from '../../../shared/llm-providers.ts'
import {
  AGENT_ROLE_IDS, ROLE_LABELS, TASK_TEMPLATE_LABELS, allRoutingPresets,
  findRoutingPreset, type AgentRoleId, type ModelRef, type ModelRoutingConfig,
  type RoutingPreset, type RoutingSelection
} from '../../../shared/model-routing.ts'
import type { ApiConfigState, ApiSettingsPayload } from '../types/api-config'

type SettingsSection = 'general' | 'providers' | 'routing' | 'presets' | 'tools' | 'knowledge' | 'runtime' | 'updates' | 'about'

const SECTION_LABELS: Array<[SettingsSection, string, string]> = [
  ['general', '常规', '应用与工作区偏好'], ['providers', '模型服务', 'Provider 与密钥'],
  ['routing', '模型路由', '职责、回退与预算'], ['presets', '预设', '策略与任务模板'],
  ['tools', '工具与 MCP', '能力与外部工具'], ['knowledge', '知识库', 'Minecraft 与 Fabric 文档'],
  ['runtime', '运行环境与存储', 'JDK、Gradle 与数据目录'], ['updates', '更新', '版本检查'], ['about', '关于', 'ModCrafting']
]

interface SettingsCenterProps {
  apiConfig: ApiConfigState
  savedProviderIds: string[]
  encryptionAvailable: boolean
  onApiSettingsChange: (config: ApiSettingsPayload) => Promise<void> | void
  onApiKeySave: (key: string, providerId?: string) => Promise<void> | void
  routingConfig: ModelRoutingConfig
  onRoutingConfigChange: (config: ModelRoutingConfig) => Promise<void> | void
  onClose: () => void
}

function modelLabel(ref: ModelRef): string { return `${getProvider(ref.providerId)?.label || ref.providerId} · ${ref.modelId}` }

function modelOptions(): Array<{ value: string; label: string }> {
  return getAllProviders().flatMap((provider) => provider.models.map((model) => ({ value: `${provider.id}:${model.id}`, label: `${provider.label} · ${model.label}` })))
}

function modelRefFromValue(value: string): ModelRef {
  const [providerId, ...tail] = value.split(':')
  return { providerId, modelId: tail.join(':') }
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiConfig, savedProviderIds, encryptionAvailable, onApiSettingsChange, onApiKeySave,
  routingConfig, onRoutingConfigChange, onClose
}) => {
  const [section, setSection] = useState<SettingsSection>('general')
  const [providerId, setProviderId] = useState(apiConfig.providerId)
  const [providerConfig, setProviderConfig] = useState({ endpoint: apiConfig.endpoint, model: apiConfig.model })
  const [keyDraft, setKeyDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [presetDraftId, setPresetDraftId] = useState(routingConfig.defaultSelection.strategyId)
  const [importText, setImportText] = useState('')

  const provider = getProvider(providerId)
  const availableModels = useMemo(() => modelOptions(), [])
  const selectedPreset = findRoutingPreset(routingConfig, presetDraftId)

  useEffect(() => {
    let cancelled = false
    void window.api.loadApiConfigForProvider(providerId).then((next) => {
      if (!cancelled) setProviderConfig({ endpoint: next.endpoint, model: next.model })
    })
    return () => { cancelled = true }
  }, [providerId])

  const saveProvider = async () => {
    await onApiSettingsChange({ providerId, endpoint: providerConfig.endpoint, model: providerConfig.model })
    setNotice('模型服务已保存')
  }
  const saveKey = async () => {
    if (!keyDraft.trim()) return
    await onApiKeySave(keyDraft, providerId)
    setKeyDraft(''); setNotice('API Key 已加密保存')
  }
  const updateConfig = async (next: ModelRoutingConfig) => {
    await onRoutingConfigChange(next)
    setNotice('路由配置已保存')
  }
  const selectOnboardingPreset = async (id: string) => {
    const next = { ...routingConfig, onboardingCompleted: true, defaultSelection: { mode: 'routed' as const, strategyId: id, taskTemplateId: 'auto' as const } }
    setPresetDraftId(id); await updateConfig(next)
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
    const next: RoutingPreset = { ...source, id, label: `${source.label} 副本`, builtIn: false, roles: Object.fromEntries(AGENT_ROLE_IDS.map((role) => [role, { ...source.roles[role], fallbacks: [...source.roles[role].fallbacks] }])) as RoutingPreset['roles'] }
    setPresetDraftId(id)
    await updateConfig({ ...routingConfig, presets: [...routingConfig.presets, next] })
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
      setPresetDraftId(id); setImportText('')
      await updateConfig({ ...routingConfig, presets: [...routingConfig.presets, next] })
    } catch (error) { setNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`) }
  }

  const renderProvider = () => (
    <div className="settings-page-content">
      <h2>模型服务</h2><p className="mc-dim">每个厂商保存一套接入地址、默认模型和加密 API Key。</p>
      <div className="settings-card">
        <label>厂商</label>
        <SettingsSelect value={providerId} options={[...getAllProviders(), { id: CUSTOM_PROVIDER_ID, label: '自定义 OpenAI 兼容服务', baseUrl: '', docsUrl: '', keyHint: '', models: [] }].map((item) => ({ value: item.id, label: item.label, saved: savedProviderIds.includes(item.id) }))} onChange={setProviderId} />
        <label>API 地址</label><input className="mc-input" value={providerConfig.endpoint} onChange={(event) => setProviderConfig((prev) => ({ ...prev, endpoint: event.target.value }))} placeholder="https://api.example.com/v1" />
        <label>默认模型</label>
        {provider?.models.length ? <SettingsSelect value={providerConfig.model} options={provider.models.map((model) => ({ value: model.id, label: model.label }))} onChange={(model) => setProviderConfig((prev) => ({ ...prev, model }))} /> : <input className="mc-input" value={providerConfig.model} onChange={(event) => setProviderConfig((prev) => ({ ...prev, model: event.target.value }))} placeholder="model-id" />}
        <div className="settings-actions"><button className="mc-btn mc-btn--primary" onClick={() => void saveProvider()}>保存模型服务</button>{provider?.docsUrl && <button className="mc-btn" onClick={() => void window.api.openExternalUrl(provider.docsUrl)}>获取 API Key</button>}</div>
      </div>
      <div className="settings-card">
        <label>API Key {savedProviderIds.includes(providerId) && <span className="settings-saved">已保存</span>}</label>
        <input className="mc-input" type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder={encryptionAvailable ? '输入新值以保存或覆盖' : '当前系统不可安全保存密钥'} disabled={!encryptionAvailable} />
        <button className="mc-btn mc-btn--primary" disabled={!keyDraft.trim() || !encryptionAvailable} onClick={() => void saveKey()}>保存加密密钥</button>
      </div>
    </div>
  )

  const renderRouting = () => (
    <div className="settings-page-content"><h2>模型路由</h2><p className="mc-dim">职责模型由预设控制；只有“实现”职责能够获得写入工具。</p>
      <div className="settings-card"><div className="settings-inline"><label>默认策略</label><SettingsSelect value={routingConfig.defaultSelection.strategyId} options={allRoutingPresets(routingConfig).map((preset) => ({ value: preset.id, label: preset.label }))} onChange={(strategyId) => void updateConfig({ ...routingConfig, onboardingCompleted: true, defaultSelection: { mode: 'routed', strategyId, taskTemplateId: routingConfig.defaultSelection.taskTemplateId } })} /></div>
      <div className="settings-budget"><span>只读并发 ≤ {routingConfig.hardLimits.maxReadonlyConcurrency}</span><span>单轮委派 ≤ {routingConfig.hardLimits.maxDelegations}</span><span>修复交接 ≤ {routingConfig.hardLimits.maxExpertRepairHandoffs}</span></div></div>
      <div className="settings-card"><h3>任务模板</h3><div className="settings-pill-row">{Object.entries(TASK_TEMPLATE_LABELS).map(([id, label]) => <span className="settings-pill" key={id}>{label}</span>)}</div></div>
      <div className="settings-card"><h3>能力约束</h3><p className="mc-dim">UI / GUI 模板会强制要求视觉审查模型；无可用视觉模型时任务暂停并提示配置。</p></div>
    </div>
  )

  const renderPresets = () => (
    <div className="settings-page-content"><h2>预设</h2><p className="mc-dim">策略和任务模板可在输入区组合；自定义预设不含任何密钥。</p>
      <div className="settings-card"><div className="settings-inline"><label>编辑预设</label><SettingsSelect value={presetDraftId} options={allRoutingPresets(routingConfig).map((preset) => ({ value: preset.id, label: `${preset.builtIn ? '内置 · ' : ''}${preset.label}` }))} onChange={setPresetDraftId} /></div>
      <p>{selectedPreset.description}</p><div className="settings-actions"><button className="mc-btn" onClick={() => void duplicatePreset()}>复制为自定义预设</button><button className="mc-btn" onClick={() => void exportPreset()}>导出 JSON</button></div></div>
      <div className="settings-role-list">{AGENT_ROLE_IDS.map((roleId) => { const binding = selectedPreset.roles[roleId]; return <div className="settings-role-row" key={roleId}><div><strong>{ROLE_LABELS[roleId]}</strong><span>{roleId === 'implementer' ? '唯一写入者' : roleId === 'visualReviewer' ? '视觉能力必需' : '只读或协调职责'}</span></div><SettingsSelect value={`${binding.primary.providerId}:${binding.primary.modelId}`} options={availableModels} onChange={(value) => void updateBinding(roleId, 'primary', modelRefFromValue(value))} /><span className="mc-dim">备用 {binding.fallbacks.length}</span></div> })}</div>
      <div className="settings-card"><h3>导入无密钥预设</h3><textarea className="mc-input settings-json" value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴导出的预设 JSON" /><button className="mc-btn" onClick={() => void importPreset()}>导入</button></div>
    </div>
  )

  const renderGeneral = () => <div className="settings-page-content"><h2>欢迎使用模型路由</h2><p className="mc-dim">选择一个起步策略；“更多”可在之后随时切换或复制为自己的预设。</p><div className="settings-strategy-cards">{allRoutingPresets(routingConfig).filter((preset) => showMore || ['fast', 'balanced', 'deep'].includes(preset.id)).map((preset) => <button className={`settings-strategy-card${routingConfig.defaultSelection.strategyId === preset.id ? ' active' : ''}`} key={preset.id} onClick={() => void selectOnboardingPreset(preset.id)}><strong>{preset.label}</strong><span>{preset.description}</span><small>{preset.budget.maxDelegations} 次委派 · {preset.budget.maxReadonlyConcurrency} 路只读并发</small></button>)}</div><button className="mc-btn" onClick={() => setShowMore((value) => !value)}>{showMore ? '收起更多' : '展开更多策略'}</button></div>

  let content: React.ReactNode = renderGeneral()
  if (section === 'providers') content = renderProvider()
  else if (section === 'routing') content = renderRouting()
  else if (section === 'presets') content = renderPresets()
  else if (section === 'tools') content = <div className="settings-page-content"><h2>工具与 MCP</h2><ToolsPanel onConfigSaved={() => setNotice('工具配置已保存')} /></div>
  else if (section !== 'general') content = <div className="settings-page-content"><h2>{SECTION_LABELS.find(([id]) => id === section)?.[1]}</h2><div className="settings-card"><p className="mc-dim">该分类的现有功能会在独立设置中心继续演进。当前可从工作区访问项目、运行环境、知识库和更新功能。</p></div></div>

  return <main className="settings-center"><aside className="settings-nav"><div className="settings-nav-title">设置</div>{SECTION_LABELS.map(([id, label, hint]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}><span>{label}</span><small>{hint}</small></button>)}<button className="settings-back" onClick={onClose}>← 返回工作区</button></aside><section className="settings-main"><header><div><span className="mc-label-sm">MODCRAFTING</span><h1>{SECTION_LABELS.find(([id]) => id === section)?.[1]}</h1></div>{notice && <span className="settings-notice">{notice}</span>}</header>{content}</section></main>
}

export default SettingsCenter
