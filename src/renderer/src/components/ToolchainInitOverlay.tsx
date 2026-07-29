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
  downloadConfirmRequired?: boolean
  onConfirmDownload?: () => void
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

const ToolchainInitOverlay: React.FC<ToolchainInitOverlayProps> = ({ state, projectPreparing, edition = 'full', onRetry, downloadConfirmRequired, onConfirmDownload }) => {
  const showOverlay = !state.ready || projectPreparing || state.phase === 'error' || downloadConfirmRequired
  if (!showOverlay) return null

  if (downloadConfirmRequired && onConfirmDownload) {
    return (
      <div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="toolchain-dl-title">
        <div className="toolchain-init-card toolchain-init-card--download">
          <div className="toolchain-init-brand">
            <span className="toolchain-init-logo">M</span>
            <div>
              <h1 id="toolchain-dl-title">ModCrafting</h1>
              <p className="toolchain-init-subtitle">首次启动需要下载构建环境</p>
            </div>
          </div>

          <div className="toolchain-init-download-estimate">
            <p className="toolchain-init-download-intro">
              安装包已精简至约 100MB，首次使用需联网下载以下资源后即可完全离线开发：
            </p>
            <ul className="toolchain-init-download-list">
              <li>
                <span className="toolchain-init-download-name">JRE 21（精简版）</span>
                <span className="toolchain-init-download-size">约 65MB（Gitee 镜像）</span>
              </li>
              <li>
                <span className="toolchain-init-download-name">Gradle 9.5</span>
                <span className="toolchain-init-download-size">约 120MB（腾讯云镜像）</span>
              </li>
              <li>
                <span className="toolchain-init-download-name">Fabric 依赖种子（分片）</span>
                <span className="toolchain-init-download-size">约 500MB（Gitee 镜像）</span>
              </li>
              <li>
                <span className="toolchain-init-download-name">知识库与辅助资源</span>
                <span className="toolchain-init-download-size">约 34MB（百科/数据/符号索引/调试模组）</span>
              </li>
              <li>
                <span className="toolchain-init-download-name">opencode AI 引擎</span>
                <span className="toolchain-init-download-size">约 70MB（压缩后）</span>
              </li>
            </ul>
            <div className="toolchain-init-download-total">
              <span>总计下载量</span>
              <span className="toolchain-init-download-total-size">约 790MB</span>
            </div>
            <p className="toolchain-init-download-hint">
              国内网络环境下约需 5-10 分钟，下载完成后可完全离线使用。知识库与 opencode 引擎下载失败不阻塞启动，AI 会降级运行。
            </p>
          </div>

          <button type="button" className="toolchain-init-confirm-btn" onClick={onConfirmDownload}>
            立即下载
          </button>
          <p className="toolchain-init-lock-notice">
            环境准备完成前，构建、运行与 AI 开发功能将暂时锁定。
          </p>
        </div>
      </div>
    )
  }

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
              : '正在从 Gitee 镜像下载 Fabric 依赖种子（约 500MB），请耐心等待。'}
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
                <li>若网络不稳定，请检查后点击重新初始化</li>
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
