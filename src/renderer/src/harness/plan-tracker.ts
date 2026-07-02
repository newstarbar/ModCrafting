import { isOpsOnlyPlan, parsePlanSteps, type ParsedPlanStep } from '../utils/plan-steps'

export type PlanStepStatus = 'pending' | 'running' | 'completed'

export interface PlanStepState {
  id: string
  description: string
  status: PlanStepStatus
}

export class PlanTracker {
  steps: PlanStepState[]
  currentIndex: number

  private constructor(steps: PlanStepState[]) {
    this.steps = steps
    this.currentIndex = 0
  }

  static fromPlanText(text: string): PlanTracker {
    const parsed = parsePlanSteps(text)
    const steps: PlanStepState[] = parsed.map((s) => ({
      id: s.id,
      description: s.description,
      status: 'pending' as const
    }))
    return new PlanTracker(steps)
  }

  static fromSteps(steps: PlanStepState[]): PlanTracker {
    const tracker = new PlanTracker(steps.map((s) => ({ ...s })))
    const runningIdx = steps.findIndex((s) => s.status === 'running')
    if (runningIdx >= 0) tracker.currentIndex = runningIdx
    else {
      const firstPending = steps.findIndex((s) => s.status !== 'completed')
      tracker.currentIndex = firstPending >= 0 ? firstPending : steps.length
    }
    return tracker
  }

  get currentStep(): PlanStepState | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.steps.length) return null
    return this.steps[this.currentIndex]
  }

  allDone(): boolean {
    return this.steps.length > 0 && this.steps.every((s) => s.status === 'completed')
  }

  isOpsOnly(): boolean {
    return isOpsOnlyPlan(this.steps as ParsedPlanStep[])
  }

  markRunning(): void {
    const cur = this.currentStep
    if (cur) cur.status = 'running'
  }

  advance(stepId: string): { ok: boolean; message: string } {
    const normalized = stepId.trim()
    const cur = this.currentStep
    if (!cur) {
      return { ok: false, message: '所有计划步骤已完成，无需再调用 complete_step。' }
    }
    // 弱模型常常传错编号（例如反复传已完成步骤的 id）。串行工作流下
    // 只能完成"当前步骤"，因此对错误编号采取宽容策略：只有当目标明确指向
    // 一个尚未开始的未来步骤（真正的跳步）时才拒绝，其余情况一律完成当前步骤，
    // 避免模型陷入反复调用 complete_step 的死循环导致上下文爆满。
    if (cur.id !== normalized) {
      const targetIdx = this.steps.findIndex((s) => s.id === normalized)
      const target = targetIdx >= 0 ? this.steps[targetIdx] : null
      if (target && targetIdx > this.currentIndex && target.status !== 'completed') {
        return {
          ok: false,
          message: `请先完成当前步骤 #${cur.id}（${cur.description}），不能跳到 #${normalized}。`
        }
      }
      // 编号错误 / 指向已完成步骤 / 未知编号 → 宽容完成当前步骤
    }
    cur.status = 'completed'
    this.currentIndex++
    if (this.currentIndex < this.steps.length) {
      this.steps[this.currentIndex].status = 'running'
      const next = this.steps[this.currentIndex]
      return {
        ok: true,
        message: `[STEP_DONE:${cur.id}] 步骤 #${cur.id} 已完成。下一步 #${next.id}：${next.description}`
      }
    }
    return {
      ok: true,
      message: `[STEP_DONE:${cur.id}] 步骤 #${cur.id} 已完成。全部计划步骤已完成，请输出总结。`
    }
  }

  toContextBlock(): string {
    if (this.steps.length === 0) return '（无计划步骤）'
    const lines = this.steps.map((s) => {
      const mark = s.status === 'completed' ? '✓' : s.status === 'running' ? '→' : '○'
      return `${mark} #${s.id} ${s.description} [${s.status}]`
    })
    const cur = this.currentStep
    const header = cur
      ? `当前步骤 #${cur.id}：${cur.description}`
      : '全部步骤已完成'
    return `${header}\n${lines.join('\n')}`
  }

  snapshot(): PlanStepState[] {
    return this.steps.map((s) => ({ ...s }))
  }
}
