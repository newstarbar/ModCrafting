import React from 'react'

export type ToolchainPhase = 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'

export interface ToolchainInitState {
  phase: ToolchainPhase
  percent: number
  message: string
  error: string | null
  ready: boolean
}

interface ToolchainInitOverlayProps {
  state: ToolchainInitState
  projectPreparing: boolean
  edition?: 'dev' | 'full' | 'portable'
  onRetry: () => void
}

const STEPS: { id: ToolchainPhase; label: string }[] = [
  { id: 'checking', label: '检查环境' },
  { id: 'jdk', label: 'JDK 21' },
  { id: 'gradle', label: 'Gradle' },
  { id: 'deps', label: '离线依赖' },
  { id: 'project', label: '项目环境' }
]

const PHASE_ORDER: ToolchainPhase[] = ['checking', 'jdk', 'gradle', 'deps', 'project', 'ready']

function stepStatus(
  stepId: ToolchainPhase,
  current: ToolchainPhase,
  globalReady: boolean,
  projectPreparing: boolean,
  isError: boolean
): 'done' | 'active' | 'pending' | 'error' {
  if (isError && stepId === current) return 'error'
  if (stepId === 'project') {
    if (projectPreparing) return 'active'
    if (globalReady && !projectPreparing && current === 'ready') return 'done'
    return globalReady ? 'pending' : 'pending'
  }
  const stepIdx = PHASE_ORDER.indexOf(stepId)
  const currentIdx = PHASE_ORDER.indexOf(current)
  if (globalReady && stepId !== 'project') return 'done'
  if (stepIdx < currentIdx) return 'done'
  if (stepIdx === currentIdx) return 'active'
  return 'pending'
}

const ToolchainInitOverlay: React.FC<ToolchainInitOverlayProps> = ({ state, projectPreparing, edition = 'full', onRetry }) => {
  const showOverlay = !state.ready || projectPreparing || state.phase === 'error'
  if (!showOverlay) return null

  const isError = state.phase === 'error'
  const displayPercent = Math.min(100, Math.max(0, state.percent))
  const isPortable = edition === 'portable'
  const depsLabel = isPortable ? 'Fabric 依赖' : '离线依赖'

  const steps = STEPS.map((s) => (s.id === 'deps' ? { ...s, label: depsLabel } : s))

  const subtitle = projectPreparing && state.ready
    ? '正在准备当前项目环境'
    : isPortable
      ? '正在联网下载构建环境（首次约 1GB，需稳定网络）'
      : '正在准备离线构建环境'

  return (
    <div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="toolchain-init-title">
      <div className="toolchain-init-card">
        <div className="toolchain-init-brand">
          <span className="toolchain-init-logo">⛏</span>
          <div>
            <h1 id="toolchain-init-title">ModCrafting</h1>
            <p className="toolchain-init-subtitle">{subtitle}</p>
          </div>
        </div>

        <div className="toolchain-init-steps toolchain-init-steps--5">
          {steps.map((step) => {
            const status = stepStatus(step.id, state.phase, state.ready, projectPreparing, isError)
            return (
              <div key={step.id} className={`toolchain-init-step toolchain-init-step--${status}`}>
                <span className="toolchain-init-step-icon">
                  {status === 'done' ? '✓' : status === 'error' ? '!' : status === 'active' ? '●' : '○'}
                </span>
                <span>{step.label}</span>
              </div>
            )
          })}
        </div>

        <div className="toolchain-init-progress-wrap">
          <div className="toolchain-init-progress-track">
            <div
              className={`toolchain-init-progress-fill ${isError ? 'toolchain-init-progress-fill--error' : ''}`}
              style={{ width: `${displayPercent}%` }}
            />
          </div>
          <div className="toolchain-init-progress-meta">
            <span className="toolchain-init-progress-message">{state.message}</span>
            <span className="toolchain-init-progress-percent">{displayPercent}%</span>
          </div>
        </div>

        {!isError && state.phase === 'deps' && displayPercent < 90 && (
          <p className="toolchain-init-hint">
            {isPortable
              ? '便携版首次启动需联网下载 JDK、Gradle 与 Fabric 依赖，完成后可离线构建。'
              : '首次启动需复制约 1GB 离线依赖到本地缓存，请耐心等待，完成后即可完全离线构建。'}
          </p>
        )}

        {isError && (
          <div className="toolchain-init-error">
            <p>{state.error || state.message}</p>
            <ul>
              <li>请勿将应用安装到 Program Files 等受保护目录</li>
              <li>便携版请放在可写文件夹（如桌面、D 盘）</li>
              {isPortable ? (
                <li>便携版需要稳定网络连接，请检查网络后重试</li>
              ) : (
                <li>若安装包不完整，请重新下载完整版（Setup）安装包</li>
              )}
            </ul>
            <button type="button" className="toolchain-init-retry-btn" onClick={onRetry}>
              重新初始化
            </button>
          </div>
        )}

        {!isError && (
          <p className="toolchain-init-lock-notice">
            环境准备完成前，构建、运行与 AI 开发功能将暂时锁定。
          </p>
        )}
      </div>
    </div>
  )
}

export default ToolchainInitOverlay
