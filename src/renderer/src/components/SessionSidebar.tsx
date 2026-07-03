import React, { useState, useCallback, useEffect } from 'react'
import FileTree from './FileTree'
import FileViewer from './FileViewer'
import ToolsPanel from './ToolsPanel'
import { IconFile, IconMessage, IconPlus, IconSettings, IconTrash, IconWrench } from './Icon'

import type { ChatSession } from '../types/chat'

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
  apiConfig: { endpoint: string; apiKey: string; model: string }
  hasSavedApiKey?: boolean
  encryptionAvailable?: boolean
  onApiSettingsChange: (endpoint: string, model: string) => void
  onApiKeySave: (key: string) => void | Promise<void>
  onOpenProject: () => void
  onCreateProject: () => void
  fileTreeRefreshKey?: number
  selectedFilePath?: string | null
  selectedFile?: { path: string; name: string } | null
  fileContent?: string | null
  onSelectFile?: (path: string, name: string) => void
}

type SidebarTab = 'sessions' | 'files' | 'tools' | 'settings'

const SessionSidebar: React.FC<SessionSidebarProps> = ({
  projectPath, projectName, sessions, currentSessionId,
  onOpenSession, onNewSession, onDeleteSession, onRenameSession,
  fileChanges, apiConfig, hasSavedApiKey = false, encryptionAvailable = true,
  onApiSettingsChange, onApiKeySave,
  onOpenProject, onCreateProject,
  fileTreeRefreshKey = 0, selectedFilePath, selectedFile, fileContent, onSelectFile
}) => {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [expandedChanges, setExpandedChanges] = useState(false)
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [keySaveHint, setKeySaveHint] = useState('')

  useEffect(() => {
    if (selectedFilePath) setActiveTab('files')
  }, [selectedFilePath])

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
  }, [apiKeyDraft, onApiKeySave])

  const tabLabels: Record<SidebarTab, string> = {
    sessions: '对话',
    files: '项目',
    tools: '工具',
    settings: '设置'
  }

  return (
    <div className="sidebar">
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
        </div>

        <div className="sidebar-panel-body">
        {activeTab === 'sessions' && (
          <>
            <div className="session-list">
              {sessions.length === 0 ? (
                <div style={{ padding: '24px 12px', color: 'var(--text-muted)', textAlign: 'center', fontSize: '12px' }}>
                  暂无对话记录
                </div>
              ) : (
                [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => (
                  <div
                    key={s.id}
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
              <input className="mc-input" placeholder="API 地址" value={apiConfig.endpoint}
                onChange={(e) => onApiSettingsChange(e.target.value, apiConfig.model)}
                style={{ fontSize: '12px', minHeight: '32px' }} />
              <input className="mc-input" placeholder="模型名称" value={apiConfig.model}
                onChange={(e) => onApiSettingsChange(apiConfig.endpoint, e.target.value)}
                style={{ fontSize: '12px', minHeight: '32px' }} />
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
              {!encryptionAvailable && (
                <div style={{ fontSize: '11px', color: 'var(--error)', lineHeight: 1.5 }}>
                  当前系统不支持加密存储，无法安全保存 API Key。请配置系统密钥环（Windows/macOS 通常可用）。
                </div>
              )}
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
