import type { PlanStepState } from './plan-tracker.ts'

export type StepKind = 'inspect' | 'write' | 'recipe' | 'build' | 'run' | 'answer'
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface StepValidation {
  type: 'file_exists' | 'recipe_written' | 'build_success' | 'run_started' | 'tool_success'
  path?: string
}

export interface WorkflowStep {
  id: string
  title: string
  kind: StepKind
  status: WorkflowStatus
  targetPath?: string
  evidence?: string
  allowedTools: string[]
  maxAttempts: number
  validation?: StepValidation
}

export interface WorkflowRunResult {
  finalContent: string
  allDone: boolean
  partial: boolean
  steps: WorkflowStep[]
  needsClarification?: boolean
  clarificationQuestion?: string
  clarificationOptions?: string[]
}

export function workflowStepToPlanStep(step: WorkflowStep): PlanStepState {
  return {
    id: step.id,
    description: step.title,
    status: step.status === 'failed' ? 'pending' : step.status
  }
}
