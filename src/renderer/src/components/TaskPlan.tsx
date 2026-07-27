import React, { useMemo, useState } from 'react'
import MarkdownContent from './MarkdownContent'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
  kind?: 'inspect' | 'write' | 'recipe' | 'mixin'
  targetPath?: string
  targetPaths?: string[]
  evidence?: string
}

interface TaskPlanProps {
  steps: PlanStep[]
  maxVisible?: number
  variant?: 'pinned' | 'anchored'
  defaultCollapsed?: boolean
  onToggleStep?: (id: string) => void
}

const STATUS_LABEL: Record<PlanStep['status'], string> = {
  pending: '待办',
  running: '进行中',
  completed: '已完成',
  error: '失败'
}

const MAX_VISIBLE_DEFAULT = 5

function partitionSteps(steps: PlanStep[]): { active: PlanStep[]; done: PlanStep[] } {
  const active: PlanStep[] = []
  const done: PlanStep[] = []
  for (const step of steps) {
    if (step.status === 'completed') done.push(step)
    else active.push(step)
  }
  return { active, done }
}

function sliceWithExpand<T>(items: T[], expanded: boolean, max: number): { visible: T[]; hidden: number } {
  if (expanded || items.length <= max) {
    return { visible: items, hidden: 0 }
  }
  return { visible: items.slice(0, max), hidden: items.length - max }
}

function progressLabel(steps: PlanStep[]): string {
  const total = steps.length
  const completedCount = steps.filter((s) => s.status === 'completed').length
  const hasError = steps.some((s) => s.status === 'error')
  const running = steps.find((s) => s.status === 'running')
  const allDone = total > 0 && completedCount === total

  if (hasError) return '部分失败'
  if (allDone) return '全部完成'
  if (running) return `进行中 · #${running.id} · 已完成 ${completedCount}/${total}`
  return `已完成 ${completedCount}/${total}`
}

function collapsedStatusText(steps: PlanStep[]): { text: string; tone: 'pending' | 'running' | 'completed' | 'error' } {
  const total = steps.length
  const completedCount = steps.filter((s) => s.status === 'completed').length
  const hasError = steps.some((s) => s.status === 'error')
  const running = steps.find((s) => s.status === 'running')
  const allDone = total > 0 && completedCount === total

  if (hasError) return { text: '部分失败', tone: 'error' }
  if (allDone) return { text: '全部完成', tone: 'completed' }
  if (running) {
    const desc = running.description.replace(/\n/g, ' ').slice(0, 40)
    return { text: `当前 #${running.id} ${desc}${running.description.length > 40 ? '…' : ''}`, tone: 'running' }
  }
  const next = steps.find((s) => s.status === 'pending')
  if (next) {
    const desc = next.description.replace(/\n/g, ' ').slice(0, 40)
    return { text: `待启动 #${next.id} ${desc}${next.description.length > 40 ? '…' : ''}`, tone: 'pending' }
  }
  return { text: '等待开始', tone: 'pending' }
}

const TaskPlan: React.FC<TaskPlanProps> = ({
  steps,
  maxVisible = MAX_VISIBLE_DEFAULT,
  variant = 'pinned',
  defaultCollapsed = false,
  onToggleStep
}) => {
  const [activeExpanded, setActiveExpanded] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  const { active, done } = useMemo(() => partitionSteps(steps), [steps])
  const summarySuffix = useMemo(() => progressLabel(steps), [steps])

  if (steps.length === 0) return null

  const { visible: visibleActive, hidden: activeHidden } = sliceWithExpand(active, activeExpanded, maxVisible)
  const { visible: visibleDone, hidden: doneHidden } = sliceWithExpand(done, doneExpanded, maxVisible)

  const renderStep = (step: PlanStep) => (
    <div
      key={step.id}
      className={`task-plan-step task-plan-step-${step.status}`}
      onClick={() => onToggleStep?.(step.id)}
    >
      <span className="task-plan-step-num">#{step.id}</span>
      <span className={`task-plan-step-icon task-plan-step-icon-${step.status}`}>
        {step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : step.status === 'error' ? '✕' : '○'}
      </span>
      <span className={`task-plan-step-tag task-plan-step-tag-${step.status}`}>
        {STATUS_LABEL[step.status]}
      </span>
      <div
        className={`task-plan-step-text ${step.status === 'completed' ? 'task-plan-step-done-text' : ''}`}
      >
        <MarkdownContent content={step.description} className="task-plan-step-markdown" />
      </div>
    </div>
  )

  if (collapsed) {
    const completedCount = steps.filter((s) => s.status === 'completed').length
    const total = steps.length
    const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0
    const status = collapsedStatusText(steps)

    return (
      <div className={`task-plan task-plan--${variant} task-plan--collapsed`}>
        <button
          type="button"
          className="task-plan-collapsed-toggle"
          onClick={() => setCollapsed(false)}
          aria-label={`实施计划 ${completedCount}/${total}，${status.text}`}
        >
          <span className="task-plan-collapsed-icon">▸</span>
          <span className="task-plan-collapsed-title">实施计划</span>
          <span className={`task-plan-collapsed-current task-plan-collapsed-current--${status.tone}`} title={status.text}>
            {status.text}
          </span>
          <span className="task-plan-collapsed-progress-text">{completedCount}/{total}</span>
          <span className="task-plan-collapsed-ring">
            <svg viewBox="0 0 36 36" className="task-plan-progress-ring">
              <path className="task-plan-progress-ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              <path
                className={`task-plan-progress-ring-fg task-plan-progress-ring-fg--${status.tone}`}
                strokeDasharray={`${progress}, 100`}
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className={`task-plan task-plan--${variant}`}>
      <div className="task-plan-header">
        <button
          type="button"
          className="task-plan-header-toggle"
          onClick={() => setCollapsed(true)}
        >
          <span className="task-plan-collapsed-icon">▾</span>
          <span>实施计划</span>
        </button>
        <span className="task-plan-progress">{summarySuffix}</span>
      </div>

      {active.length > 0 && (
        <div className="task-plan-section">
          <div className="task-plan-section-label">待执行</div>
          <div className="task-plan-steps">
            {visibleActive.map(renderStep)}
          </div>
          {activeHidden > 0 && (
            <button type="button" className="task-plan-toggle" onClick={() => setActiveExpanded((v) => !v)}>
              {activeExpanded ? '收起' : `展开其余 ${activeHidden} 项`}
            </button>
          )}
        </div>
      )}

      {done.length > 0 && (
        <div className="task-plan-section task-plan-section-done">
          <button
            type="button"
            className="task-plan-section-toggle"
            onClick={() => setShowDone((v) => !v)}
          >
            <span>已完成 {done.length} 项</span>
            <span>{showDone ? '▾' : '▸'}</span>
          </button>
          {showDone && (
            <>
              <div className="task-plan-steps">
                {visibleDone.map(renderStep)}
              </div>
              {doneHidden > 0 && (
                <button type="button" className="task-plan-toggle" onClick={() => setDoneExpanded((v) => !v)}>
                  {doneExpanded ? '收起' : `展开其余 ${doneHidden} 项`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default TaskPlan
