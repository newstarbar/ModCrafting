import type { CompiledPlanStep } from './plan-compiler.ts'

export interface PlanValidationIssue {
  stepId: string
  field: 'kind' | 'targetPath' | 'description' | 'evidence'
  message: string
}

const PATH_HINT_RE = /(?:src\/|data\/|gradle\/)/i

/** Machine-check plan steps after compilation. */
export function validateCompiledSteps(steps: CompiledPlanStep[]): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = []

  for (const step of steps) {
    if (step.hostManaged) continue

    if (!step.description?.trim()) {
      issues.push({ stepId: step.id, field: 'description', message: '步骤描述为空' })
    }

    if ((step.kind === 'write' || step.kind === 'mixin') && !step.targetPath && !step.targetPaths?.length && !PATH_HINT_RE.test(step.description)) {
      issues.push({
        stepId: step.id,
        field: 'targetPath',
        message: `${step.kind} 步骤应包含目标路径（标签或 src/data/gradle 路径）`
      })
    }

    if (step.kind === 'recipe' && !step.targetPath && !step.targetPaths?.length && !/配方|recipe/i.test(step.description)) {
      issues.push({
        stepId: step.id,
        field: 'targetPath',
        message: 'recipe 步骤应指明配方路径或配方名称'
      })
    }

    if (
      !step.hostManaged &&
      step.kind &&
      step.kind !== 'inspect' &&
      !step.evidence?.trim()
    ) {
      issues.push({
        stepId: step.id,
        field: 'evidence',
        message: '建议为步骤提供验收 evidence（如「mixins.json 含 FooMixin」）'
      })
    }

    // inspect may omit evidence but still benefit from a check phrase
    if (!step.hostManaged && step.kind === 'inspect' && !step.evidence?.trim()) {
      issues.push({
        stepId: step.id,
        field: 'evidence',
        message: '建议为 inspect 步骤写明验收（如「已确认 Yarn 方法签名」）'
      })
    }

    if (!step.kind && !PATH_HINT_RE.test(step.description) && !step.hostManaged) {
      issues.push({
        stepId: step.id,
        field: 'kind',
        message: '建议使用 [write|recipe|mixin|inspect] 标签标注步骤类型'
      })
    }
  }

  return issues
}

export function formatPlanValidationIssues(issues: PlanValidationIssue[]): string {
  if (issues.length === 0) return ''
  return issues
    .map((i) => `步骤 #${i.stepId}（${i.field}）：${i.message}`)
    .join('\n')
}
