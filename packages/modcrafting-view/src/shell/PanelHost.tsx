import React from 'react'

interface BoundaryState { error: Error | null }

/**
 * Keeps one broken panel from taking the whole workbench down.
 *
 * The shell stays usable: the sidebar still navigates, and switching away and
 * back remounts the panel. `key` is passed by the host so the boundary resets on
 * a session or panel change, not only on a reload.
 */
export class PanelBoundary extends React.Component<React.PropsWithChildren<{ title: string }>, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return <section className="panel panel-crashed" role="alert">
      <h2>「{this.props.title}」出错了</h2>
      <p>其他面板仍可使用。切到别的面板再回来会重新加载。</p>
      <pre>{this.state.error.stack || String(this.state.error)}</pre>
    </section>
  }
}

export function PanelHost({ panelKey, title, children }: { panelKey: string; title: string; children: React.ReactNode }) {
  return <PanelBoundary key={panelKey} title={title}>{children}</PanelBoundary>
}
