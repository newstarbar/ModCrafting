import React from 'react'

interface State { error: Error | null }

/** Keeps a renderer exception visible and recoverable instead of leaving a blank window. */
export class AppErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Renderer crash', error, info.componentStack)
  }

  private openLogs = (): void => { void window.api?.openEnvironmentLogs?.() }
  private exportDiagnostics = (): void => { void window.api?.exportEnvironmentDiagnostics?.() }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return <main style={{ padding: 32, maxWidth: 720, fontFamily: 'system-ui, sans-serif' }} role="alert">
      <h1>ModCrafting 遇到页面错误</h1>
      <p>应用没有完成加载。你可以重新加载页面；诊断日志会保留，不会影响已下载的开发环境。</p>
      <pre style={{ whiteSpace: 'pre-wrap', color: '#b42318' }}>{this.state.error.message}</pre>
      <p><button type="button" onClick={() => window.location.reload()}>重新加载</button>{' '}<button type="button" onClick={this.openLogs}>打开日志</button>{' '}<button type="button" onClick={this.exportDiagnostics}>导出诊断包</button></p>
    </main>
  }
}
