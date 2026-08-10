import React, { useMemo, useState } from 'react'
import MarkdownContent from './MarkdownContent'
import type { GameTestSpec } from '../harness/game-test-protocol'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'error'
  kind?: 'inspect' | 'write' | 'recipe' | 'mixin' | 'build' | 'run' | 'game_test'
  targetPath?: string
  targetPaths?: string[]
  evidence?: string
  gameTest?: GameTestSpec
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

function progressCounts(steps: PlanStep[]): { completedCount: number; total: number } {
  return {
    completedCount: steps.filter((s) => s.status === 'completed').length,
    total: steps.length
  }
}

function progressLabel(steps: PlanStep[]): string {
  const { completedCount, total } = progressCounts(steps)
  const hasError = steps.some((s) => s.status === 'error')
  const running = steps.find((s) => s.status === 'running')
  const allDone = total > 0 && completedCount === total

  if (hasError) return '部分失败'
  if (allDone) return '全部完成'
  if (running) return `进行中 · #${running.id} · 已完成 ${completedCount}/${total}`
  return `已完成 ${completedCount}/${total}`
}

/** 折叠态展示的当前步骤：running 优先，否则下一条 pending，再否则最近 error */
function currentFocusStep(steps: PlanStep[]): PlanStep | null {
  return (
    steps.find((s) => s.status === 'running')
    || steps.find((s) => s.status === 'pending')
    || steps.find((s) => s.status === 'error')
    || null
  )
}

function focusTone(step: PlanStep | null, steps: PlanStep[]): 'pending' | 'running' | 'completed' | 'error' {
  if (steps.some((s) => s.status === 'error') && (!step || step.status !== 'running')) return 'error'
  if (!step) {
    const allDone = steps.length > 0 && steps.every((s) => s.status === 'completed')
    return allDone ? 'completed' : 'pending'
  }
  return step.status
}

function plainDescription(text: string): string {
  return text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
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
  const focus = useMemo(() => currentFocusStep(steps), [steps])
  const tone = useMemo(() => focusTone(focus, steps), [focus, steps])
  const { completedCount, total } = useMemo(() => progressCounts(steps), [steps])

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

  const focusDesc = focus ? plainDescription(focus.description) : ''

  return (
    <div className={`task-plan task-plan--${variant}${collapsed ? ' task-plan--collapsed' : ''}`}>
      <div className={`task-plan-header${collapsed ? ' task-plan-header--collapsed' : ''}`}>
        <button
          type="button"
          className="task-plan-header-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开实施计划' : '收起实施计划'}
        >
          <span className="task-plan-collapsed-icon">{collapsed ? '▸' : '▾'}</span>
          <span className="task-plan-title">实施计划</span>
        </button>

        {collapsed ? (
          <>
            {focusDesc ? (
              <span className="task-plan-focus-desc" title={focusDesc}>
                {focus ? `#${focus.id} ` : ''}{focusDesc}
              </span>
            ) : (
              <span className="task-plan-focus-desc task-plan-focus-desc--empty">等待开始</span>
            )}
            <span className={`task-plan-status-pill task-plan-status-pill--${tone}`}>
              {tone === 'error' ? '失败' : tone === 'running' ? '进行中' : tone === 'completed' ? '完成' : '待办'}
            </span>
            <span className="task-plan-count">{completedCount}/{total}</span>
          </>
        ) : (
          <span className="task-plan-progress">{summarySuffix}</span>
        )}
      </div>

      {!collapsed && active.length > 0 && (
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

      {!collapsed && done.length > 0 && (
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
