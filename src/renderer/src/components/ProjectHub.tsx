import React from 'react'

interface RecentProject {
  path: string
  name: string
  openedAt: string
}

interface ProjectHubProps {
  recentProjects: RecentProject[]
  lastProjectPath: string | null
  onNewProject: () => void
  onOpenProject: () => void
  onContinueLast: () => void
  onOpenRecent: (path: string) => void
}

function formatOpenedAt(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const ProjectHub: React.FC<ProjectHubProps> = ({
  recentProjects,
  lastProjectPath,
  onNewProject,
  onOpenProject,
  onContinueLast,
  onOpenRecent
}) => {
  const lastEntry = lastProjectPath
    ? recentProjects.find((p) => p.path === lastProjectPath) ?? {
        path: lastProjectPath,
        name: lastProjectPath.split(/[/\\]/).pop() || lastProjectPath,
        openedAt: ''
      }
    : null

  return (
    <div className="project-hub">
      <div className="project-hub-inner">
        <h1 className="project-hub-title">ModCrafting</h1>
        <p className="project-hub-subtitle">AI 驱动的 Minecraft Fabric 模组开发环境</p>

        <div className="project-hub-actions">
          <button type="button" className="project-hub-btn primary" onClick={onNewProject}>
            ✨ 新建 Fabric 模组
          </button>
          <button type="button" className="project-hub-btn" onClick={onOpenProject}>
            📂 打开已有项目
          </button>
        </div>

        {lastEntry && (
          <div className="project-hub-continue">
            <div className="project-hub-continue-info">
              <div className="project-hub-continue-label">继续上次</div>
              <div className="project-hub-continue-name">{lastEntry.name}</div>
              <div className="project-hub-continue-path" title={lastEntry.path}>{lastEntry.path}</div>
            </div>
            <button type="button" className="btn btn-primary" onClick={onContinueLast}>
              打开
            </button>
          </div>
        )}

        <div className="project-hub-section-title">最近项目</div>
        {recentProjects.length === 0 ? (
          <div className="project-hub-empty">
            暂无最近项目。新建或打开一个 Fabric 模组项目开始吧。
          </div>
        ) : (
          <div className="project-hub-recent-list">
            {recentProjects.map((p) => (
              <div
                key={p.path}
                className="project-hub-recent-card"
                onClick={() => onOpenRecent(p.path)}
                title={p.path}
              >
                <span className="name">{p.name}</span>
                <div className="project-hub-badges">
                  <span className="project-hub-badge ok">Fabric</span>
                  <span className="project-hub-badge">Gradle</span>
                </div>
                {p.openedAt && (
                  <span className="meta">{formatOpenedAt(p.openedAt)}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectHub
