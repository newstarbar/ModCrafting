import React from 'react'
import appIcon from '../../../../build/appIcon.png'
import { IconFolder, IconHistory, IconPlus } from './Icon'

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
      <div className="project-hub-scene" aria-hidden="true" />
      <div className="project-hub-inner mc-frame">
        <div className="project-hub-brand">
          <img className="project-hub-logo" src={appIcon} alt="ModCrafting" />
          <h1 className="project-hub-title">ModCrafting</h1>
        </div>
        <p className="project-hub-subtitle">AI 驱动的 Minecraft Fabric 模组开发环境</p>

        <div className="project-hub-actions">
          <button type="button" className="mc-btn mc-btn--primary" onClick={onNewProject}>
            <span className="hub-action-icon">
              <IconPlus size="lg" />
            </span>
            <span>
              新建 Fabric 模组
              <span className="hub-action-sub">向导式创建，自动配置 Gradle</span>
            </span>
          </button>
          <button type="button" className="mc-btn" onClick={onOpenProject}>
            <span className="hub-action-icon">
              <IconFolder size="lg" />
            </span>
            <span>
              打开已有项目
              <span className="hub-action-sub">从本地目录或最近列表选择</span>
            </span>
          </button>
        </div>

        {lastEntry && (
          <div className="project-hub-continue mc-inset">
            <div className="project-hub-continue-icon">
              <IconHistory size="lg" />
            </div>
            <div className="project-hub-continue-info">
              <div className="project-hub-continue-label mc-label-sm">继续上次</div>
              <div className="project-hub-continue-name">{lastEntry.name}</div>
              <div className="project-hub-continue-path" title={lastEntry.path}>{lastEntry.path}</div>
            </div>
            <button type="button" className="mc-btn mc-btn--primary" onClick={onContinueLast}>
              打开
            </button>
          </div>
        )}

        <div className="project-hub-section-title mc-label-sm">最近项目</div>
        {recentProjects.length === 0 ? (
          <div className="project-hub-empty mc-inset">
            暂无最近项目。新建或打开一个 Fabric 模组项目开始吧。
          </div>
        ) : (
          <div className="project-hub-recent-list mc-inset">
            {recentProjects.map((p) => (
              <div
                key={p.path}
                className="project-hub-recent-card"
                onClick={() => onOpenRecent(p.path)}
                title={p.path}
              >
                <IconFolder className="folder-icon" />
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
