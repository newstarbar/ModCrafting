import React from 'react'

export type ToolchainPhase = 'checking' | 'jdk' | 'gradle' | 'fabric' | 'minecraft' | 'assets' | 'verify' | 'optional' | 'project' | 'ready' | 'degraded' | 'error' | 'deps'

export interface ToolchainInitState {
  phase: ToolchainPhase
  percent: number
  message: string
  error: string | null
  ready: boolean
  errorId?: string
  currentItem?: string
  source?: string
  metrics?: { completedBytes?: number; totalBytes?: number; completedItems?: number; totalItems?: number; speedBytesPerSecond?: number; etaSeconds?: number }
  probe: { candidates: Array<{ url: string; label: string; speedKBps: number | null }>; done: boolean; chosen?: string } | null
}

interface Props {
  state: ToolchainInitState
  projectPreparing: boolean
  edition?: 'dev' | 'full' | 'portable'
  onRetry: () => void
  onCancel?: () => void
  onOpenLogs?: () => void
  onExportDiagnostics?: () => void
  downloadConfirmRequired?: boolean
  onConfirmDownload?: () => void
  onOpenImportDialog?: () => void
  /** 当前数据目录路径 */
  runtimePath?: string
  /** 选择数据目录 */
  onSelectRuntimePath?: () => void
}

const STEPS: Array<{ id: ToolchainPhase; label: string }> = [
  { id: 'jdk', label: 'Complete JDK 21' },
  { id: 'gradle', label: 'Gradle 9.5' },
  { id: 'fabric', label: 'Fabric / Loom' },
  { id: 'minecraft', label: 'Minecraft' },
  { id: 'assets', label: 'Game assets' },
  { id: 'verify', label: 'Offline verification' }
]
const ORDER = STEPS.map((step) => step.id)

function fmtBytes(value?: number): string | null {
  if (value === undefined) return null
  return `${(value / 1024 / 1024).toFixed(value > 100 * 1024 * 1024 ? 0 : 1)} MB`
}

function statusFor(step: ToolchainPhase, current: ToolchainPhase, ready: boolean, failed: boolean): 'done' | 'active' | 'pending' | 'error' {
  if (ready) return 'done'
  if (failed && step === current) return 'error'
  const currentIndex = ORDER.indexOf(current)
  const stepIndex = ORDER.indexOf(step)
  if (currentIndex < 0) return 'pending'
  if (stepIndex < currentIndex) return 'done'
  return stepIndex === currentIndex ? 'active' : 'pending'
}

const ToolchainInitOverlay: React.FC<Props> = ({ state, projectPreparing, edition = 'full', onRetry, onCancel, onOpenLogs, onExportDiagnostics, downloadConfirmRequired, onConfirmDownload, onOpenImportDialog, runtimePath, onSelectRuntimePath }) => {
  const failed = state.phase === 'error'
  const percent = Math.max(0, Math.min(100, state.percent))
  const metrics = state.metrics
  const bytes = metrics?.completedBytes !== undefined ? `${fmtBytes(metrics.completedBytes)}${metrics.totalBytes ? ` / ${fmtBytes(metrics.totalBytes)}` : ''}` : null
  const detail = [
    bytes,
    metrics?.completedItems !== undefined ? `${metrics.completedItems}${metrics.totalItems ? ` / ${metrics.totalItems}` : ''} files` : null,
    metrics?.speedBytesPerSecond ? `${fmtBytes(metrics.speedBytesPerSecond)}/s` : null,
    metrics?.etaSeconds ? `ETA ${Math.ceil(metrics.etaSeconds / 60)} min` : null
  ].filter(Boolean).join(' · ')

  if (downloadConfirmRequired && onConfirmDownload) {
    return <div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="toolchain-dl-title">
      <div className="toolchain-init-card toolchain-init-card--download">
        <div className="toolchain-init-brand">
          <div>
            <h1 id="toolchain-dl-title">ModCrafting</h1>
            <p className="toolchain-init-subtitle">首次启动需要准备开发环境</p>
          </div>
        </div>
        <div className="toolchain-init-download-estimate">
          <p className="toolchain-init-download-intro">将下载完整 JDK、Gradle、Fabric/Minecraft 依赖和游戏资源；完成后会验证离线构建。</p>
          <ul className="toolchain-init-download-list">
            <li><span className="toolchain-init-download-name">完整 JDK 21</span><span className="toolchain-init-download-size">国内镜像优先，官方源回退</span></li>
            <li><span className="toolchain-init-download-name">Gradle 9.5</span><span className="toolchain-init-download-size">国内镜像测速选优</span></li>
            <li><span className="toolchain-init-download-name">Fabric 与游戏资源</span><span className="toolchain-init-download-size">BMCLAPI 优先，Mojang 官方源回退</span></li>
          </ul>
          {runtimePath !== undefined && (
            <div className="toolchain-init-path-section">
              <div className="toolchain-init-path-label">数据存放位置</div>
              <div className="toolchain-init-path-row">
                <span className="toolchain-init-path-value">{runtimePath || '加载中…'}</span>
                {onSelectRuntimePath && (
                  <button type="button" className="toolchain-init-secondary-btn toolchain-init-path-btn" onClick={onSelectRuntimePath}>浏览…</button>
                )}
              </div>
              <p className="toolchain-init-path-hint">
                {onSelectRuntimePath
                  ? 'JDK、Gradle、依赖缓存与游戏资源（约 1-2 GB）将存放于此目录。建议选择非 C 盘位置。'
                  : 'JDK、Gradle、依赖缓存与游戏资源将存放于便携版所在目录的 runtime 文件夹中。'}
              </p>
            </div>
          )}
          <p className="toolchain-init-download-hint">下载量按实际版本清单计算；界面会显示当前步骤、来源、文件和速度。</p>
        </div>
        <button type="button" className="toolchain-init-confirm-btn" onClick={onConfirmDownload}>立即下载并验证</button>
        {onOpenImportDialog && (
          <button type="button" className="toolchain-init-secondary-btn" onClick={onOpenImportDialog}>
            网络慢？手动导入环境包
          </button>
        )}
      </div>
    </div>
  }

  if (state.ready && !projectPreparing && !failed) return null
  return <div className="toolchain-init-overlay" role="dialog" aria-modal="true" aria-labelledby="toolchain-init-title">
    <div className="toolchain-init-card">
      <div className="toolchain-init-brand">
        <div>
          <h1 id="toolchain-init-title">ModCrafting</h1>
          <p className="toolchain-init-subtitle">{projectPreparing ? '正在准备当前项目环境' : `${edition === 'portable' ? '便携版' : '安装版'}开发环境初始化`}</p>
        </div>
      </div>
      <div className="toolchain-init-steps toolchain-init-steps--6">
        {STEPS.map((step) => { const status = statusFor(step.id, state.phase, state.ready, failed); return <div key={step.id} className={`toolchain-init-step toolchain-init-step--${status}`}><span className="toolchain-init-step-icon">{status === 'done' ? '✓' : status === 'error' ? '!' : status === 'active' ? '◉' : '○'}</span><span>{step.label}</span></div> })}
      </div>
      <div className="toolchain-init-progress-wrap">
        <div className="toolchain-init-progress-track"><div className={`toolchain-init-progress-fill ${failed ? 'toolchain-init-progress-fill--error' : ''}`} style={{ width: `${percent}%` }} /></div>
        <div className="toolchain-init-progress-meta"><span className="toolchain-init-progress-message">{state.message}</span><span className="toolchain-init-progress-percent">{percent}%</span></div>
        {(state.source || state.currentItem || detail) && <p className="toolchain-init-hint">{[state.source, state.currentItem, detail].filter(Boolean).join(' · ')}</p>}
      </div>
      {state.probe?.candidates.length ? <div className="toolchain-init-probe-panel"><div className="toolchain-init-probe-title">下载源测速{state.probe.done ? '完成' : '中…'}</div>{state.probe.candidates.map((candidate) => <div key={candidate.label} className={`toolchain-init-probe-row ${state.probe.done && state.probe.chosen === candidate.label ? 'toolchain-init-probe-row--chosen' : ''}`}><span className="toolchain-init-probe-name">{candidate.label}</span><span className="toolchain-init-probe-speed">{candidate.speedKBps === null ? '失败' : candidate.speedKBps >= 1024 ? `${(candidate.speedKBps / 1024).toFixed(1)}MB/s` : `${candidate.speedKBps}KB/s`}</span></div>)}</div> : null}
      {state.phase === 'degraded' && <div className="toolchain-init-error"><p>{state.message}</p><p>核心构建环境已通过验证；可选知识库或 AI 引擎未就绪，可稍后重试。</p><button type="button" className="toolchain-init-confirm-btn" style={{ width: 'auto', margin: 0 }} onClick={onRetry}>重试可选下载</button></div>}
      {failed && <div className="toolchain-init-error"><p>{state.error || state.message}</p>{state.errorId && <p>错误 ID：{state.errorId}</p>}<p>下载可恢复；请检查网络或磁盘空间后重试。可打开日志或导出诊断包以便定位问题。</p><div className="toolchain-init-actions"><button type="button" className="toolchain-init-confirm-btn" style={{ width: 'auto', margin: 0 }} onClick={onRetry}>重试初始化</button>{onOpenLogs && <button type="button" className="toolchain-init-secondary-btn" onClick={onOpenLogs}>打开日志</button>}{onExportDiagnostics && <button type="button" className="toolchain-init-secondary-btn" onClick={onExportDiagnostics}>导出诊断包</button>}</div></div>}
      {!failed && !state.ready && !downloadConfirmRequired && onCancel && <button type="button" className="toolchain-init-cancel-btn" onClick={onCancel}>取消并保留已下载内容</button>}
      {!failed && state.phase !== 'degraded' && <p className="toolchain-init-lock-notice">只有资源和离线构建验证通过后，才会解锁构建、运行和 AI 开发功能。</p>}
    </div>
  </div>
}

export default ToolchainInitOverlay
