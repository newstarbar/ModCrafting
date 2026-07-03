import React, { useMemo, useState } from 'react'
import MarkdownContent from './MarkdownContent'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
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

  if (steps.length === 0) return null

  const completedCount = done.length
  const total = steps.length
  const allDone = completedCount === total
  const hasError = steps.some((s) => s.status === 'error')

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
        {step.status === 'completed' ? '✓' : step.status === 'running' ? '◐' : step.status === 'error' ? '✕' : '○'}
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

  const summarySuffix = hasError
    ? '部分失败'
    : allDone
      ? '全部完成'
      : `${completedCount}/${total}`

  if (variant === 'anchored' && collapsed) {
    return (
      <div className="task-plan task-plan--anchored task-plan--collapsed">
        <button
          type="button"
          className="task-plan-collapsed-toggle"
          onClick={() => setCollapsed(false)}
        >
          <span className="task-plan-collapsed-icon">▸</span>
          <span>实施计划</span>
          <span className="task-plan-collapsed-meta">· {summarySuffix}</span>
        </button>
      </div>
    )
  }

  return (
    <div className={`task-plan${variant === 'anchored' ? ' task-plan--anchored' : ''}`}>
      <div className="task-plan-header">
        {variant === 'anchored' ? (
          <button
            type="button"
            className="task-plan-header-toggle"
            onClick={() => setCollapsed(true)}
          >
            <span className="task-plan-collapsed-icon">▾</span>
            <span>实施计划</span>
          </button>
        ) : (
          <span>实施计划</span>
        )}
        <span className="task-plan-progress">
          {completedCount}/{total}
          {allDone && <span className="task-plan-done"> · 全部完成</span>}
        </span>
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
            <span>{showDone ? '▲' : '▼'}</span>
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
