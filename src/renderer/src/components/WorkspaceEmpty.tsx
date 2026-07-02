import React from 'react'
import { IconFolder, IconPlus } from './Icon'

interface WorkspaceEmptyProps {
  onGoHub: () => void
  onOpenProject: () => void
  onNewProject: () => void
}

const WorkspaceEmpty: React.FC<WorkspaceEmptyProps> = ({
  onGoHub,
  onOpenProject,
  onNewProject
}) => (
  <div className="workspace-empty">
    <div className="workspace-empty-inner mc-inset">
      <h2 className="workspace-empty-title mc-y">工作室</h2>
      <p className="workspace-empty-desc mc-dim">
        尚未打开 Fabric 项目。可从首页继续上次项目，或在此新建/打开。
      </p>
      <div className="workspace-empty-actions">
        <button type="button" className="mc-btn mc-btn--primary" onClick={onNewProject}>
          <IconPlus size="sm" /> 新建项目
        </button>
        <button type="button" className="mc-btn" onClick={onOpenProject}>
          <IconFolder size="sm" /> 打开项目
        </button>
        <button type="button" className="mc-btn" onClick={onGoHub}>
          返回首页
        </button>
      </div>
    </div>
  </div>
)

export default WorkspaceEmpty
