import React, { useState, useCallback, useEffect, useRef } from 'react'
import FileTree from './FileTree'
import FileViewer from './FileViewer'
import BridgeGuidePanel from './BridgeGuidePanel'
import { IconFile, IconGamepad, IconMessage, IconPanelLeftClose, IconPlus, IconSettings, IconTrash } from './Icon'
import type { ChatSession } from '../types/chat'
import { sortSessionsByUpdatedAt } from '../utils/session-sort'
import { SessionRuntimeManager } from '../harness/session-runtime'

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
  fileTreeRefreshKey?: number
  selectedFilePath?: string | null
  selectedFile?: { path: string; name: string } | null
  fileContent?: string | null
  onSelectFile?: (path: string, name: string) => void
  panelCollapsed?: boolean
  panelDragging?: boolean
  onTogglePanelCollapse?: () => void
  onOpenSettingsCenter?: () => void
}

type SidebarTab = 'sessions' | 'files' | 'bridge'

const SessionSidebar: React.FC<SessionSidebarProps> = ({
  projectPath, projectName, sessions, currentSessionId,
  onOpenSession, onNewSession, onDeleteSession, onRenameSession,
  fileChanges,
  fileTreeRefreshKey = 0, selectedFilePath, selectedFile, fileContent, onSelectFile,
  panelCollapsed = false, panelDragging = false, onTogglePanelCollapse, onOpenSettingsCenter
}) => {
  const [activeTab, setActiveTab] = useState<SidebarTab>('sessions')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [expandedChanges, setExpandedChanges] = useState(false)
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() =>
    SessionRuntimeManager.getInstance().getRunningSessionIds()
  )
  const [clarificationSessionIds, setClarificationSessionIds] = useState<Set<string>>(() =>
    SessionRuntimeManager.getInstance().getClarificationPendingSessionIds()
  )
  const activeSessionItemRef = useRef<HTMLDivElement | null>(null)
  const sortedSessions = sortSessionsByUpdatedAt(sessions)

  useEffect(() => {
    return SessionRuntimeManager.getInstance().subscribeGlobal(() => {
      setRunningSessionIds(new Set(SessionRuntimeManager.getInstance().getRunningSessionIds()))
      setClarificationSessionIds(new Set(SessionRuntimeManager.getInstance().getClarificationPendingSessionIds()))
    })
  }, [])

  useEffect(() => {
    activeSessionItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentSessionId])

  useEffect(() => {
    if (selectedFilePath) setActiveTab('files')
  }, [selectedFilePath])

  useEffect(() => {
    const openSettings = () => onOpenSettingsCenter?.()
    window.addEventListener('modcrafting:open-settings', openSettings)
    return () => window.removeEventListener('modcrafting:open-settings', openSettings)
  }, [onOpenSettingsCenter])

  const handleStartRename = useCallback((id: string, currentName: string) => {
    setRenamingId(id)
    setRenameValue(currentName)
  }, [])

  const handleFinishRename = useCallback((id: string) => {
    if (renameValue.trim()) onRenameSession(id, renameValue.trim())
    setRenamingId(null)
  }, [renameValue, onRenameSession])

  const formatTime = (ts: number): string => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }

  const tabLabels: Record<SidebarTab, string> = {
    sessions: '对话',
    files: '项目',
    bridge: '测试桥接'
  }

  return (
    <div className={`sidebar${panelCollapsed ? ' sidebar--collapsed' : ''}${panelDragging ? ' sidebar--dragging' : ''}`}>
      <nav className="activity-bar">
        <button type="button" className={`activity-item ${activeTab === 'sessions' ? 'active' : ''}`} title="对话" onClick={() => setActiveTab('sessions')}>
          <IconMessage size="lg" />
        </button>
        <button type="button" className={`activity-item ${activeTab === 'files' ? 'active' : ''}`} title="项目" onClick={() => setActiveTab('files')}>
          <IconFile size="lg" />
        </button>
        <button type="button" className={`activity-item ${activeTab === 'bridge' ? 'active' : ''}`} title="测试桥接" onClick={() => setActiveTab('bridge')}>
          <IconGamepad size="lg" />
        </button>
        <div className="activity-spacer" />
        <button type="button" className="activity-item" title="设置" onClick={() => onOpenSettingsCenter?.()}>
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
            <button type="button" className="sidebar-panel-collapse-btn" onClick={onTogglePanelCollapse} title="收起左侧面板" aria-label="收起左侧面板">
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
                        <div style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}>
                          <div className="session-name" onDoubleClick={() => handleStartRename(s.id, s.name)}>
                            {s.name}
                          </div>
                          {runningSessionIds.has(s.id) && (
                            <span className="session-status-badge session-status-badge--running" title="Agent 正在执行中">运行中</span>
                          )}
                          {clarificationSessionIds.has(s.id) && (
                            <span className="session-status-badge session-status-badge--clarify" title="等待用户回复">待确认</span>
                          )}
                        </div>
                      )}
                      <div className="session-time">
                        {formatTime(s.updatedAt)}
                        <button type="button" className="session-delete-btn" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }} title="删除">
                          <IconTrash size="sm" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

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

          {activeTab === 'bridge' && (
            <div className="sidebar-bridge-layout">
              <BridgeGuidePanel />
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

export default SessionSidebar
