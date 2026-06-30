import React, { useState, useEffect, useCallback } from 'react'

interface RecentProject {
  path: string
  name: string
  openedAt: string
}

interface OpenProjectDialogProps {
  open: boolean
  initialPath?: string | null
  onClose: () => void
  onOpen: (path: string) => void
  onRecentChange?: () => void
}

function formatOpenedAt(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const OpenProjectDialog: React.FC<OpenProjectDialogProps> = ({
  open,
  initialPath,
  onClose,
  onOpen,
  onRecentChange
}) => {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [detectInfo, setDetectInfo] = useState<ProjectInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const refreshRecent = useCallback(async () => {
    const list = await window.api.listRecentProjects()
    setRecent(list)
    return list
  }, [])

  const runDetect = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const info = await window.api.detectProject(path)
      setDetectInfo(info)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshRecent().then((list) => {
      const pick = initialPath && list.some((p) => p.path === initialPath)
        ? initialPath
        : list[0]?.path ?? initialPath ?? null
      setSelectedPath(pick)
      if (pick) void runDetect(pick)
      else setDetectInfo(null)
    })
  }, [open, initialPath, refreshRecent, runDetect])

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path)
    void runDetect(path)
  }, [runDetect])

  const handleBrowse = useCallback(async () => {
    const dir = await window.api.selectDirectory()
    if (!dir) return
    setSelectedPath(dir)
    void runDetect(dir)
  }, [runDetect])

  const handleRemove = useCallback(async (path: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const result = await window.api.removeRecentProject(path)
    if (result.success && result.data) {
      setRecent(result.data)
      onRecentChange?.()
      if (selectedPath === path) {
        const next = result.data[0]?.path ?? null
        setSelectedPath(next)
        if (next) void runDetect(next)
        else setDetectInfo(null)
      }
    }
  }, [selectedPath, runDetect, onRecentChange])

  const handleClearAll = useCallback(async () => {
    if (!window.confirm('确定清空全部最近项目记录？')) return
    await window.api.clearRecentProjects()
    setRecent([])
    setSelectedPath(null)
    setDetectInfo(null)
    onRecentChange?.()
  }, [onRecentChange])

  const canOpen = detectInfo?.hasBuildGradle === true

  const handleOpen = useCallback(() => {
    if (!selectedPath || !canOpen) return
    onOpen(selectedPath)
    onClose()
  }, [selectedPath, canOpen, onOpen, onClose])

  if (!open) return null

  const selectedName = selectedPath
    ? recent.find((p) => p.path === selectedPath)?.name ?? selectedPath.split(/[/\\]/).pop() ?? selectedPath
    : ''

  return (
    <div className="project-modal-overlay" onClick={onClose}>
      <div className="project-modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="project-modal-header">
          <h2>打开项目</h2>
          <button type="button" className="project-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="project-modal-body open-dialog-modal-body">
          <div className="open-dialog-body">
            <div className="open-dialog-list">
              <div className="open-dialog-list-header">
                <span>最近项目</span>
                {recent.length > 0 && (
                  <button type="button" className="open-dialog-remove-btn" onClick={() => void handleClearAll()}>
                    清空
                  </button>
                )}
              </div>
              <div className="open-dialog-list-items">
                {recent.length === 0 ? (
                  <div className="project-hub-empty" style={{ margin: 12, border: 'none' }}>暂无最近项目</div>
                ) : (
                  recent.map((p) => (
                    <div
                      key={p.path}
                      className={`open-dialog-list-item ${selectedPath === p.path ? 'selected' : ''}`}
                      onClick={() => handleSelect(p.path)}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="name">{p.name}</div>
                          <div className="path">{p.path}</div>
                        </div>
                        <button
                          type="button"
                          className="open-dialog-remove-btn"
                          title="从列表移除"
                          onClick={(e) => void handleRemove(p.path, e)}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="open-dialog-detail">
              {selectedPath ? (
                <>
                  <h3>{selectedName}</h3>
                  <div className="path-full">{selectedPath}</div>
                  {loading ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>检测中…</div>
                  ) : detectInfo ? (
                    <>
                      <div className="detect-checklist">
                        <div className={`detect-check ${detectInfo.hasBuildGradle ? 'ok' : 'fail'}`}>
                          <span className="icon">{detectInfo.hasBuildGradle ? '✓' : '✗'}</span>
                          <span>build.gradle</span>
                        </div>
                        <div className={`detect-check ${detectInfo.hasFabricModJson ? 'ok' : 'fail'}`}>
                          <span className="icon">{detectInfo.hasFabricModJson ? '✓' : '✗'}</span>
                          <span>fabric.mod.json</span>
                        </div>
                        <div className={`detect-check ${detectInfo.hasGradleWrapper ? 'ok' : 'fail'}`}>
                          <span className="icon">{detectInfo.hasGradleWrapper ? '✓' : '✗'}</span>
                          <span>gradlew</span>
                        </div>
                      </div>
                      {!detectInfo.hasBuildGradle && (
                        <div className="open-dialog-error">
                          所选目录不是有效的 Gradle 项目，无法打开。
                        </div>
                      )}
                      {detectInfo.hasBuildGradle && (!detectInfo.hasGradleWrapper || !detectInfo.isFabric) && (
                        <div className="open-dialog-hint">
                          打开后将尝试自动修复工具链（Gradle Wrapper、Fabric 配置等）。
                        </div>
                      )}
                    </>
                  ) : null}
                </>
              ) : (
                <div className="open-dialog-empty-detail">
                  选择最近项目或浏览文件夹
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="project-modal-footer">
          <button type="button" className="btn" onClick={() => void handleBrowse()}>
            浏览其他文件夹…
          </button>
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canOpen}
            onClick={handleOpen}
          >
            打开项目
          </button>
        </div>
      </div>
    </div>
  )
}

export default OpenProjectDialog
