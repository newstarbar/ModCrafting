import React from 'react'

export type AppView = 'hub' | 'workspace'

interface AppChromeProps {
  appView: AppView
  onViewChange: (view: AppView) => void
  projectName: string
  projectPath: string | null
}

const AppChrome: React.FC<AppChromeProps> = ({
  appView,
  onViewChange,
  projectName,
  projectPath
}) => {
  const hint =
    appView === 'workspace' && projectPath
      ? projectName
      : appView === 'workspace'
        ? '尚未打开项目 — 请从首页选择或打开项目'
        : 'AI 驱动的 Minecraft Fabric 模组开发环境'

  return (
    <header className="app-chrome">
      <div className="app-chrome-brand">
        <span className="app-chrome-tag mc-y">ModCrafting</span>
      </div>
      <div className="app-chrome-hint mc-dim" title={projectPath ?? undefined}>
        {hint}
      </div>
      <div className="app-chrome-tabs">
        <button
          type="button"
          className={`mc-tab ${appView === 'hub' ? 'active' : ''}`}
          onClick={() => onViewChange('hub')}
        >
          项目首页
        </button>
        <button
          type="button"
          className={`mc-tab ${appView === 'workspace' ? 'active' : ''}`}
          onClick={() => onViewChange('workspace')}
        >
          工作室
        </button>
      </div>
    </header>
  )
}

export default AppChrome
