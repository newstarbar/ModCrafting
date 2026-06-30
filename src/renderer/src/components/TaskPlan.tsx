import React, { useMemo, useState } from 'react'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
}

interface TaskPlanProps {
  steps: PlanStep[]
  maxVisible?: number
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

const TaskPlan: React.FC<TaskPlanProps> = ({ steps, maxVisible = MAX_VISIBLE_DEFAULT, onToggleStep }) => {
  const [activeExpanded, setActiveExpanded] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [doneExpanded, setDoneExpanded] = useState(false)

  const { active, done } = useMemo(() => partitionSteps(steps), [steps])

  if (steps.length === 0) return null

  const completedCount = done.length
  const total = steps.length
  const allDone = completedCount === total

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
      <span className={`task-plan-step-text ${step.status === 'completed' ? 'task-plan-step-done-text' : ''}`}>
        {step.description}
      </span>
    </div>
  )

  return (
    <div className="task-plan">
      <div className="task-plan-header">
        <span>实施计划</span>
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
