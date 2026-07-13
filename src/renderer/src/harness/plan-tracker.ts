import { compilePlanFromText, compiledStepsToParsed, type CompiledPlanStep } from './plan-compiler.ts'
import { validateCompiledSteps, formatPlanValidationIssues } from './plan-validator.ts'
import { isOpsOnlyPlan, type ParsedPlanStep } from '../utils/plan-steps.ts'

export type PlanStepStatus = 'pending' | 'running' | 'completed'

export interface PlanStepState {
  id: string
  description: string
  status: PlanStepStatus
  /** Preserved from structured plan compile; used by workflow normalizer when set. */
  kind?: 'inspect' | 'write' | 'recipe'
  targetPath?: string
  evidence?: string
}

export class PlanTracker {
  steps: PlanStepState[]
  currentIndex: number

  private constructor(steps: PlanStepState[]) {
    this.steps = steps
    this.currentIndex = 0
  }

  static fromPlanText(text: string): PlanTracker {
    const parsed = compiledStepsToParsed(compilePlanFromText(text))
    const steps: PlanStepState[] = parsed.map((s) => ({
      id: s.id,
      description: s.description,
      status: 'pending' as const,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.targetPath ? { targetPath: s.targetPath } : {}),
      ...(s.evidence ? { evidence: s.evidence } : {})
    }))
    return new PlanTracker(steps)
  }

  static validationIssuesFromText(text: string) {
    const compiled = compilePlanFromText(text)
    return validateCompiledSteps(compiled)
  }

  static formatValidationIssues(text: string): string {
    return formatPlanValidationIssues(PlanTracker.validationIssuesFromText(text))
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

  private completeCurrent(): { ok: boolean; message: string } {
    const cur = this.currentStep
    if (!cur) {
      return { ok: false, message: '所有计划步骤已完成，无需再推进。' }
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

  advance(stepId: string): { ok: boolean; message: string } {
    const normalized = stepId.trim()
    const cur = this.currentStep
    if (!cur) {
      return { ok: false, message: '所有计划步骤已完成，无需再调用 complete_step。' }
    }
    if (cur.id !== normalized) {
      return {
        ok: false,
        message: `步骤 #${normalized || '空'} 已经完成了。当前步骤是 #${cur.id}：${cur.description}。请直接执行当前步骤，不要再重试 complete_step。`
      }
    }
    return this.completeCurrent()
  }

  advanceCurrent(_reason: string): { ok: boolean; message: string } {
    return this.completeCurrent()
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
