import type { ReactNode } from 'react'

/**
 * Page-level empty and error states.
 *
 * Panels used to each invent their own "no workspace" paragraph and their own
 * error block, which made the workbench feel like a collection of tools rather
 * than one surface. The two states below are the only page-level ones: a panel
 * that cannot render yet says what is missing and what to do, and a panel that
 * failed says what happened and offers the one retry that makes sense.
 *
 * Inline form validation stays inside the form; these components are for the
 * whole panel, not for a single field.
 */

export function PanelEmptyState({ title, description, hint, action, icon }: {
  title: string
  description: ReactNode
  hint?: string
  action?: ReactNode
  icon?: string
}) {
  return <section className="panel panel-state">
    {icon && <span className="panel-state-icon" aria-hidden>{icon}</span>}
    <h2>{title}</h2>
    <p className="muted">{description}</p>
    {hint && <p className="panel-state-hint">{hint}</p>}
    {action && <div className="row panel-state-action">{action}</div>}
  </section>
}

export function PanelErrorState({ title, message, hint, retry, retryLabel = '重新读取' }: {
  title: string
  message: string
  hint?: string
  retry?: () => void
  retryLabel?: string
}) {
  return <section className="panel panel-state panel-state-error" role="alert">
    <span className="panel-state-icon" aria-hidden>!</span>
    <h2>{title}</h2>
    <p className="error">{message}</p>
    {hint && <p className="panel-state-hint">{hint}</p>}
    {retry && <div className="row panel-state-action"><button onClick={retry}>{retryLabel}</button></div>}
  </section>
}
