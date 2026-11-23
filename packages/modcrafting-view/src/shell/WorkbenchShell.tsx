import type { ReactNode } from 'react'
import { isPanelId, type PanelId } from '../../../modcrafting-core/src/panels.ts'
import { PANEL_META, panelGroups, panelLabel } from './registry.ts'

export interface WorkbenchContext {
  kind: 'mod' | 'modpack' | undefined
  targetId: string
  workspacePath: string
  phase: string
  jobCount: number
  runningJobs: number
  failedJobs: number
  readOnly: boolean
  recommended: readonly string[]
}

const KIND_LABELS: Record<'mod' | 'modpack' | 'unknown', string> = {
  mod: '单模组工作区',
  modpack: '整合包工作区',
  unknown: '未识别工作区'
}

/**
 * The workbench's one layout owner: navigation, context and content.
 *
 * Three columns are not cosmetic. Navigation answers "where can I go", the
 * context column answers "what am I inside right now" (workspace kind, target,
 * current phase, Agent recommendations), and the main column is the panel. A
 * panel therefore never has to reproduce session or workspace status, and App
 * only decides what to render in the middle.
 *
 * Mobile keeps the same information architecture: the two side columns collapse
 * and the grouped `<select>` becomes the navigation, still built from the same
 * registry rather than a second list.
 */
export function WorkbenchShell({ active, context, header, banners, onNavigate, children }: {
  active: PanelId
  context: WorkbenchContext
  header: ReactNode
  banners?: ReactNode
  onNavigate: (id: PanelId) => void
  children: ReactNode
}) {
  const navigation = panelGroups(context.kind)
  const meta = PANEL_META[active]
  const recommendations = context.recommended.filter(isPanelId)
  return <>
    {header}
    {banners}
    <div className="workbench-shell">
      <aside className="workbench-sidebar" aria-label="工作区导航">
        {navigation.map((group) => <section className="nav-group" key={group.scope}>
          <p className="eyebrow">{group.label}</p>
          {group.entries.map(({ id, meta: entryMeta }) => <button
            key={id}
            aria-current={active === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
          >
            <span aria-hidden>{entryMeta.icon}</span>{entryMeta.label}
            {context.recommended.includes(id) && <i title="Agent 当前推荐" />}
          </button>)}
        </section>)}
        <details><summary>更多工具</summary><p className="muted">知识库和 Fabric 工具由聊天 Agent 按任务调用。作业日志收在主栏底部的诊断区。</p></details>
      </aside>

      <aside className="workbench-context" aria-label="工作区上下文">
        <section className="context-card">
          <p className="eyebrow">当前工作区</p>
          <strong>{KIND_LABELS[context.kind ?? 'unknown']}</strong>
          <span className="context-target">{context.targetId || '未选择目标版本'}</span>
          <code className="context-path" title={context.workspacePath}>{context.workspacePath || '尚未关联目录'}</code>
        </section>

        <section className="context-card">
          <p className="eyebrow">当前面板</p>
          <strong>{meta.icon} {meta.label}</strong>
          <p className="muted">{meta.hint ?? '这个面板直接读写当前会话的工作区。'}</p>
        </section>

        <section className="context-card">
          <p className="eyebrow">任务状态</p>
          <div className="context-stats">
            <div><span>阶段</span><strong>{context.phase || '等待更新'}</strong></div>
            <div><span>任务</span><strong>{context.jobCount}</strong></div>
            <div><span>运行中</span><strong>{context.runningJobs}</strong></div>
            <div><span>失败</span><strong>{context.failedJobs}</strong></div>
          </div>
          {context.readOnly && <p className="context-readonly">已结束会话 · 只读</p>}
        </section>

        {recommendations.length > 0 && <section className="context-card">
          <p className="eyebrow">Agent 推荐</p>
          <div className="context-recommended">
            {recommendations.map((id) => <button key={id} onClick={() => onNavigate(id)}>
              <span aria-hidden>{PANEL_META[id].icon}</span>{panelLabel(id)}
            </button>)}
          </div>
        </section>}
      </aside>

      <main className="workbench-main">{children}</main>
    </div>

    <nav className="mobile-nav" aria-label="移动端工作区导航">
      <label>当前模块<select value={active} onChange={(event) => { const next = event.target.value; if (isPanelId(next)) onNavigate(next) }}>
        {navigation.map((group) => <optgroup key={group.scope} label={group.label}>
          {group.entries.map(({ id, meta: entryMeta }) => <option key={id} value={id}>{entryMeta.label}</option>)}
        </optgroup>)}
      </select></label>
    </nav>
    <footer>ModCrafting Core · 关闭页面不会停止本会话作业 · 报告按会话隔离</footer>
  </>
}
