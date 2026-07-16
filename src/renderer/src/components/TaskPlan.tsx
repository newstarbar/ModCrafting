import React, { useMemo } from 'react'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
  kind?: 'inspect' | 'write' | 'recipe'
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

const TaskPlan: React.FC<TaskPlanProps> = ({
  steps,
  variant = 'pinned',
}) => {
  const { completedCount, total, allDone, hasError, hasRunning } = useMemo(() => {
    let completed = 0
    let error = false
    let running = false
    for (const step of steps) {
      if (step.status === 'completed') completed++
      if (step.status === 'error') error = true
      if (step.status === 'running') running = true
    }
    return {
      completedCount: completed,
      total: steps.length,
      allDone: steps.length > 0 && completed === steps.length,
      hasError: error,
      hasRunning: running,
    }
  }, [steps])

  if (steps.length === 0) return null

  const summarySuffix = hasError
    ? '部分失败'
    : allDone
      ? '全部完成'
      : hasRunning
        ? `进行中 · ${completedCount}/${total}`
        : `${completedCount}/${total}`

  return (
    <div
      className={`task-plan task-plan--summary${variant === 'anchored' ? ' task-plan--anchored' : ''}`}
    >
      <div className="task-plan-header task-plan-header--summary">
        <span>实施计划</span>
        <span className="task-plan-progress">{summarySuffix}</span>
      </div>
    </div>
  )
}

export default TaskPlan
