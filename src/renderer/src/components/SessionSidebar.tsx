import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import FileTree from './FileTree'
import FileViewer from './FileViewer'
import ToolsPanel from './ToolsPanel'
import SettingsSelect from './SettingsSelect'
import { IconFile, IconMessage, IconPanelLeftClose, IconPlus, IconSettings, IconTrash, IconWrench } from './Icon'

import type { ChatSession } from '../types/chat'
import { sortSessionsByUpdatedAt } from '../utils/session-sort'
import {
  CUSTOM_PROVIDER_ID,
  getAllProviders,
  getProvider,
  resolveSelection,
} from '../../../shared/llm-providers.ts'
import type { ApiConfigState, ApiSettingsPayload } from '../types/api-config'

interface FileChange {
  time: string
  entry: string
}

interface SessionSidebarProps {
  projectPath: string | null
  projectName: string
  sessions: ChatSession[]
  currentSessionId: string | null
  onOpenSession: (id: string) => void
  onNewSession: () => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  fileChanges: FileChange[]
  apiConfig: ApiConfigState
  hasSavedApiKey?: boolean
  savedProviderIds?: string[]
  encryptionAvailable?: boolean
  onApiSettingsChange: (config: ApiSettingsPayload) => void
  onApiKeySave: (key: string) => void | Promise<void>
  onOpenProject: () => void
  onCreateProject: () => void
  fileTreeRefreshKey?: number
  selectedFilePath?: string | null
  selectedFile?: { path: string; name: string } | null
  fileContent?: string | null
  onSelectFile?: (path: string, name: string) => void
  panelCollapsed?: boolean
  panelDragging?: boolean
  onTogglePanelCollapse?: () => void
}

type SidebarTab = 'sessions' | 'files' | 'tools' | 'settings'

function pickApiSettings(config: ApiConfigState, patch: Partial<ApiSettingsPayload>): ApiSettingsPayload {
  return {
    endpoint: patch.endpoint ?? config.endpoint,
    model: patch.model ?? config.model,
    providerId: patch.providerId ?? config.providerId,
  }
}

function providerUsesManualModel(providerId: string): boolean {
  if (providerId === CUSTOM_PROVIDER_ID) return true
  const provider = getProvider(providerId)
  return (provider?.models.length ?? 0) === 0
}

function modelIdForProviderSwitch(targetProviderId: string, currentModel: string): string {
  const provider = getProvider(targetProviderId)
  const preset = provider?.models[0]?.id
  if (preset) return preset
  if (targetProviderId === 'doubao' && /^ep-[a-z0-9-]+$/i.test(currentModel) && currentModel !== 'ep-xxxxxxxx') {
    return currentModel
  }
  return ''
}

const SessionSidebar: React.FC<SessionSidebarProps> = ({
  projectPath, projectName, sessions, currentSessionId,
  onOpenSession, onNewSession, onDeleteSession, onRenameSession,
  fileChanges, apiConfig, hasSavedApiKey = false, savedProviderIds = [], encryptionAvailable = true,
  onApiSettingsChange, onApiKeySave,
  onOpenProject, onCreateProject,
  fileTreeRefreshKey = 0, selectedFilePath, selectedFile, fileContent, onSelectFile,
  panelCollapsed = false, panelDragging = false, onTogglePanelCollapse
}) => {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [expandedChanges, setExpandedChanges] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [keySaveHint, setKeySaveHint] = useState('')
  const [deepseekBalance, setDeepseekBalance] = useState<{
    loading: boolean
    text: string
    detail?: string
    error?: string
  } | null>(null)
  const activeSessionItemRef = useRef<HTMLDivElement | null>(null)

  const sortedSessions = sortSessionsByUpdatedAt(sessions)

  useEffect(() => {
    activeSessionItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentSessionId])

  useEffect(() => {
    if (selectedFilePath) setActiveTab('files')
  }, [selectedFilePath])

  useEffect(() => {
    const openSettings = () => setActiveTab('settings')
    window.addEventListener('modcrafting:open-settings', openSettings)
    return () => window.removeEventListener('modcrafting:open-settings', openSettings)
  }, [])

  useEffect(() => {
    setApiKeyDraft('')
    setKeySaveHint('')
    setDeepseekBalance(null)
  }, [apiConfig.providerId])

  const refreshDeepSeekBalance = useCallback(async (opts?: { useDraftKey?: boolean }) => {
    if (apiConfig.providerId !== 'deepseek') return
    setDeepseekBalance({ loading: true, text: '查询中…' })
    try {
      const draft = opts?.useDraftKey ? apiKeyDraft.trim() : ''
      const result = await window.api.fetchDeepSeekBalance(draft || undefined)
      if (!result.success) {
        setDeepseekBalance({ loading: false, text: '—', error: result.error || '查询失败' })
        return
      }
      const preferred = result.balances?.find((b) => b.currency === result.displayCurrency)
        ?? result.balances?.[0]
      const symbol = result.displayCurrency === 'USD' ? '$' : '￥'
      const total = result.displayTotal ?? preferred?.totalBalance ?? '0'
      const detail = preferred
        ? `赠送 ${symbol}${preferred.grantedBalance} · 充值 ${symbol}${preferred.toppedUpBalance}`
          + (result.isAvailable === false ? ' · 余额暂不可用于 API' : '')
        : undefined
      setDeepseekBalance({
        loading: false,
        text: `${symbol}${total}`,
        detail
      })
    } catch (err) {
      setDeepseekBalance({
        loading: false,
        text: '—',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }, [apiConfig.providerId, apiKeyDraft])

  useEffect(() => {
    if (activeTab !== 'settings' || apiConfig.providerId !== 'deepseek') return
    if (!hasSavedApiKey) {
      setDeepseekBalance({ loading: false, text: '—', error: '请先保存 API Key' })
      return
    }
    void refreshDeepSeekBalance()
  }, [activeTab, apiConfig.providerId, hasSavedApiKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id)
    setRenameValue(currentName)
  }, [])

  const handleFinishRename = useCallback((id: string) => {
    if (renameValue.trim()) {
      onRenameSession(id, renameValue.trim())
    }
    setRenamingId(null)
  }, [renameValue, onRenameSession])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const handleSaveApiKey = useCallback(async () => {
    const trimmed = apiKeyDraft.trim()
    if (!trimmed) return
    if (trimmed.length < 8) {
      alert('API Key 长度过短，请检查是否完整复制')
      return
    }

    await onApiKeySave(trimmed)
    setApiKeyDraft('')
    setKeySaveHint('密钥已保存')
    window.setTimeout(() => setKeySaveHint(''), 2000)
    if (apiConfig.providerId === 'deepseek') {
      window.setTimeout(() => { void refreshDeepSeekBalance() }, 100)
    }
  }, [apiKeyDraft, onApiKeySave, apiConfig.providerId, refreshDeepSeekBalance])

  const handleOpenDocsUrl = useCallback(async (url: string) => {
    const result = await window.api.openExternalUrl(url)
    if (!result.success) {
      alert(result.error || '无法打开链接')
    }
  }, [])

  const tabLabels: Record<SidebarTab, string> = {
    sessions: '对话',
    files: '项目',
    tools: '工具',
    settings: '设置'
  }

  const providerOptions = useMemo(() => [
    ...getAllProviders().map((provider) => ({
      value: provider.id,
      label: provider.label,
      saved: savedProviderIds.includes(provider.id),
    })),
    {
      value: CUSTOM_PROVIDER_ID,
      label: '自定义',
      saved: savedProviderIds.includes(CUSTOM_PROVIDER_ID),
    },
  ], [savedProviderIds])

  const modelOptions = useMemo(() => {
    const models = getProvider(apiConfig.providerId)?.models ?? []
    const options = models.map((model) => ({
      value: model.id,
      label: model.label,
    }))
    if (apiConfig.model && !models.some((m) => m.id === apiConfig.model)) {
      options.push({ value: apiConfig.model, label: apiConfig.model })
    }
    return options
  }, [apiConfig.providerId, apiConfig.model])

  return (
    <div className={`sidebar${panelCollapsed ? ' sidebar--collapsed' : ''}${panelDragging ? ' sidebar--dragging' : ''}`}>
      <nav className="activity-bar">
        <button
          type="button"
          className={`activity-item ${activeTab === 'sessions' ? 'active' : ''}`}
          title="对话"
          onClick={() => setActiveTab('sessions')}
        >
          <IconMessage size="lg" />
        </button>
        <button
          type="button"
          className={`activity-item ${activeTab === 'files' ? 'active' : ''}`}
          title="项目"
          onClick={() => setActiveTab('files')}
        >
          <IconFile size="lg" />
        </button>
        <button
          type="button"
          className={`activity-item ${activeTab === 'tools' ? 'active' : ''}`}
          title="工具"
          onClick={() => setActiveTab('tools')}
        >
          <IconWrench size="lg" />
        </button>
        <div className="activity-spacer" />
        <button
          type="button"
          className={`activity-item ${activeTab === 'settings' ? 'active' : ''}`}
          title="设置"
          onClick={() => setActiveTab('settings')}
        >
          <IconSettings size="lg" />
        </button>
      </nav>

      <div className="sidebar-panel">
        <div className="sidebar-panel-header">
          <div className="sidebar-panel-header-main">
            <span className="sidebar-panel-title mc-label-sm">{tabLabels[activeTab]}</span>
            {projectPath && (
              <span className="project-name" title={projectPath}>{projectName}</span>
            )}
          </div>
          {activeTab === 'sessions' && (
            <button type="button" className="mc-btn" onClick={onNewSession} title="新建对话" style={{ padding: '4px 8px' }}>
              <IconPlus size="sm" />
            </button>
          )}
          {onTogglePanelCollapse && (
            <button
              type="button"
              className="sidebar-panel-collapse-btn"
              onClick={onTogglePanelCollapse}
              title="收起左侧面板"
              aria-label="收起左侧面板"
            >
              <IconPanelLeftClose size="sm" />
            </button>
          )}
        </div>

        <div className="sidebar-panel-body">
        {activeTab === 'sessions' && (
          <>
            <div className="session-list">
              {sortedSessions.length === 0 ? (
                <div style={{ padding: '24px 12px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '12px' }}>
                  暂无对话记录
                </div>
              ) : (
                sortedSessions.map((s) => (
                  <div
                    key={s.id}
                    ref={s.id === currentSessionId ? activeSessionItemRef : undefined}
                    className={`session-item mc-inset ${s.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => onOpenSession(s.id)}
                  >
                    {renamingId === s.id ? (
                      <input
                        className="chat-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleFinishRename(s.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleFinishRename(s.id) }}
                        autoFocus
                        style={{ fontSize: '12px', minHeight: '24px', padding: '2px 6px' }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div
                        className="session-name"
                        onDoubleClick={() => handleStartRename(s.id, s.name)}
                      >
                        {s.name}
                      </div>
                    )}
                    <div className="session-time">
                      {formatTime(s.updatedAt)}
                      <button
                        type="button"
                        className="session-delete-btn"
                        onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }}
                        title="删除"
                      >
                        <IconTrash size="sm" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* File changes */}
            {fileChanges.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-color)' }}>
                <div
                  style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}
                  onClick={() => setExpandedChanges(!expandedChanges)}
                >
                  <span>文件改动 ({fileChanges.length})</span>
                  <span>{expandedChanges ? '▲' : '▼'}</span>
                </div>
                {expandedChanges && (
                  <div style={{ maxHeight: '200px', overflow: 'auto' }}>
                    {fileChanges.map((fc, i) => (
                      <div key={i} className="file-change-entry">{fc.time} {fc.entry}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {activeTab === 'files' && (
          <div className="sidebar-files-layout">
            <div className="sidebar-file-tree">
              {projectPath ? (
                <FileTree
                  key={fileTreeRefreshKey}
                  rootPath={projectPath}
                  selectedFile={selectedFilePath || null}
                  onSelectFile={onSelectFile || (() => {})}
                />
              ) : (
                <div style={{ padding: '24px 12px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '12px' }}>
                  请先打开或新建项目
                </div>
              )}
            </div>
            <div className="sidebar-file-preview">
              {selectedFile ? (
                <>
                  <div className="sidebar-file-preview-header">
                    <span className="filename"><IconFile size="sm" /> {selectedFile.name}</span>
                  </div>
                  <div className="sidebar-file-preview-body">
                    <FileViewer fileName={selectedFile.name} content={fileContent || ''} />
                  </div>
                </>
              ) : (
                <div className="sidebar-file-preview-empty">选择文件以预览</div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'tools' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '8px' }}>
            <ToolsPanel onConfigSaved={() => window.dispatchEvent(new CustomEvent('agent-config-saved'))} />
          </div>
        )}

        {activeTab === 'settings' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 600 }}>
              API 配置
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>厂商</label>
              <SettingsSelect
                value={apiConfig.providerId}
                options={providerOptions}
                onChange={(providerId) => {
                  if (providerId === CUSTOM_PROVIDER_ID) {
                    onApiSettingsChange(pickApiSettings(apiConfig, { providerId: CUSTOM_PROVIDER_ID }))
                    return
                  }
                  const provider = getProvider(providerId)
                  const nextModel = modelIdForProviderSwitch(providerId, apiConfig.model)
                  const resolved = resolveSelection(providerId, nextModel)
                  onApiSettingsChange(pickApiSettings(apiConfig, {
                    providerId: resolved.providerId,
                    endpoint: resolved.endpoint,
                    model: resolved.modelId,
                  }))
                }}
              />
              {savedProviderIds.length > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  ✓ 表示该厂商已保存 API Key
                </div>
              )}

              {apiConfig.providerId === CUSTOM_PROVIDER_ID ? (
                <>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>API 地址</label>
                  <input
                    className="mc-input"
                    placeholder="https://api.example.com/v1"
                    value={apiConfig.endpoint}
                    onChange={(e) => onApiSettingsChange(pickApiSettings(apiConfig, { endpoint: e.target.value }))}
                    style={{ fontSize: '12px', minHeight: '32px' }}
                  />
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>模型名称</label>
                  <input
                    className="mc-input"
                    placeholder="model-id"
                    value={apiConfig.model}
                    onChange={(e) => onApiSettingsChange(pickApiSettings(apiConfig, { model: e.target.value }))}
                    style={{ fontSize: '12px', minHeight: '32px' }}
                  />
                </>
              ) : providerUsesManualModel(apiConfig.providerId) ? (
                <>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>推理接入点 ID</label>
                  <input
                    className="mc-input"
                    placeholder="ep-2024xxxxxxxx-xxxxx"
                    value={apiConfig.model === 'ep-xxxxxxxx' ? '' : apiConfig.model}
                    onChange={(e) => onApiSettingsChange(pickApiSettings(apiConfig, { model: e.target.value.trim() }))}
                    style={{ fontSize: '12px', minHeight: '32px' }}
                  />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    API 地址：{apiConfig.endpoint}
                  </div>
                </>
              ) : (
                <>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>模型</label>
                  <SettingsSelect
                    value={apiConfig.model}
                    options={modelOptions}
                    onChange={(modelId) => {
                      const resolved = resolveSelection(apiConfig.providerId, modelId)
                      onApiSettingsChange(pickApiSettings(apiConfig, {
                        providerId: resolved.providerId,
                        endpoint: resolved.endpoint,
                        model: resolved.modelId,
                      }))
                    }}
                  />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    API 地址：{apiConfig.endpoint}
                  </div>
                </>
              )}

              <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                API 密钥
                {hasSavedApiKey && (
                  <span style={{ fontSize: '10px', color: 'var(--success)', fontWeight: 600 }}>已保存</span>
                )}
              </label>
              <input className="mc-input" type="password"
                placeholder={hasSavedApiKey ? '已保存密钥（输入新值可覆盖）' : 'API 密钥'}
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && apiKeyDraft.trim()) void handleSaveApiKey() }}
                style={{ fontSize: '12px', minHeight: '32px' }} />
              <button
                type="button"
                className="mc-btn mc-btn--primary"
                style={{ padding: '4px 10px', fontSize: '11px', alignSelf: 'flex-start' }}
                disabled={!apiKeyDraft.trim() || !encryptionAvailable}
                onClick={() => void handleSaveApiKey()}
              >
                保存密钥
              </button>
              {keySaveHint && (
                <div style={{ fontSize: '11px', color: 'var(--success)' }}>{keySaveHint}</div>
              )}
              {apiConfig.providerId === 'deepseek' && (
                <div style={{
                  marginTop: '4px',
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: 'var(--bg-elevated, rgba(255,255,255,0.04))',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.08))'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>账户余额</div>
                    <button
                      type="button"
                      className="mc-btn"
                      style={{ padding: '2px 8px', fontSize: '10px' }}
                      disabled={deepseekBalance?.loading}
                      onClick={() => void refreshDeepSeekBalance({ useDraftKey: true })}
                    >
                      {deepseekBalance?.loading ? '查询中…' : '刷新'}
                    </button>
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 600, marginTop: '4px', color: 'var(--text-primary)' }}>
                    {deepseekBalance?.text ?? '—'}
                  </div>
                  {deepseekBalance?.detail && (
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>
                      {deepseekBalance.detail}
                    </div>
                  )}
                  {deepseekBalance?.error && (
                    <div style={{ fontSize: '10px', color: 'var(--error)', marginTop: '2px', lineHeight: 1.4 }}>
                      {deepseekBalance.error}
                    </div>
                  )}
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.4 }}>
                    费用按 API 返回的 token × 官网单价估算（Flash/Pro 分价，USD→CNY≈7.25）。与账单一致依据是官方 usage，不是本地 tokenizer。
                  </div>
                </div>
              )}
              {!encryptionAvailable && (
                <div style={{ fontSize: '11px', color: 'var(--error)', lineHeight: 1.5 }}>
                  当前系统不支持加密存储，无法安全保存 API Key。请配置系统密钥环（Windows/macOS 通常可用）。
                </div>
              )}
              {(() => {
                const provider = getProvider(apiConfig.providerId)
                if (!provider?.keyHint) return null
                return (
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: '4px' }}>
                    {provider.keyHint}
                    {provider.docsUrl && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="settings-docs-link"
                          onClick={() => void handleOpenDocsUrl(provider.docsUrl)}
                        >
                          获取 API Key
                        </button>
                      </>
                    )}
                  </div>
                )
              })()}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '16px', marginBottom: '8px', fontWeight: 600 }}>
              项目
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }}>
              <button type="button" className="mc-btn" style={{ flex: 1, fontSize: '11px' }} onClick={onOpenProject}>打开项目</button>
              <button type="button" className="mc-btn mc-btn--primary" style={{ flex: 1, fontSize: '11px' }} onClick={onCreateProject}>新建项目</button>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px', fontWeight: 600 }}>
              关于 ModCrafting
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              AI 驱动的我的世界 Fabric 模组开发环境
              <br />
              核心功能：AI 智能体对话 / 代码生成 / 编译终端 / MC 运行管理
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

export default SessionSidebar
