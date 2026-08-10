import type { PlanStepState } from './plan-tracker.ts'
import type { GameTestSpec } from './game-test-protocol.ts'

export type StepKind = 'inspect' | 'write' | 'recipe' | 'mixin' | 'build' | 'run' | 'game_test' | 'answer'
export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface StepValidation {
  type: 'file_exists' | 'recipe_validated' | 'mixin_validated' | 'build_success' | 'run_started' | 'game_test_passed' | 'tool_success'
  path?: string
}

export interface WorkflowStep {
  id: string
  title: string
  kind: StepKind
  status: WorkflowStatus
  targetPath?: string
  targetPaths?: string[]
  evidence?: string
  gameTest?: GameTestSpec
  allowedTools: string[]
  maxAttempts: number
  validation?: StepValidation
  /** 步骤是否涉及GUI布局变更，需要先调用 gui_layout_preview 预览 */
  requiresGuiPreview?: boolean
}

export interface WorkflowRunResult {
  finalContent: string
  allDone: boolean
  partial: boolean
  steps: WorkflowStep[]
  needsClarification?: boolean
  clarificationQuestion?: string
  clarificationOptions?: string[]
  /** 本次运行收集的 mc_screenshot 截图（供任务总结展示） */
  collectedScreenshots?: Array<{ base64: string; mimeType: string; toolId: string; timestamp: number }>
}

export function workflowStepToPlanStep(step: WorkflowStep): PlanStepState {
  return {
    id: step.id,
    description: step.title,
    status: step.status === 'failed' ? 'pending' : step.status,
    kind: step.kind === 'inspect' || step.kind === 'write' || step.kind === 'recipe' || step.kind === 'mixin' || step.kind === 'game_test' ? step.kind : undefined,
    targetPath: step.targetPath,
    targetPaths: step.targetPaths,
    evidence: step.evidence,
    gameTest: step.gameTest
  }
}
