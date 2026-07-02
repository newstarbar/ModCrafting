import type { PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'
import type { StepKind, WorkflowStep, WorkflowStatus } from './workflow-types.ts'

const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;）)]+)(?:`)?/i

function inferKind(description: string): StepKind {
  const d = description.toLowerCase()
  if (/runclient|启动游戏|运行游戏/.test(d)) return 'run'
  if (/gradlew|gradle\s|trigger_build|编译|构建|build/.test(d)) return 'build'
  if (/读取|查看|检查|获取|确认|read|list|fabric\.mod\.json/.test(d)) return 'inspect'
  if (/配方|合成|recipe|recipes/.test(d)) return 'recipe'
  if (/创建|写入|生成|修改|\.json|\.java|\.gradle|\.properties|\.toml/.test(d)) return 'write'
  return 'answer'
}

function normalizeStatus(status: PlanStepState['status']): WorkflowStatus {
  if (status === 'completed') return 'completed'
  if (status === 'running') return 'running'
  return 'pending'
}

function targetPathFromDescription(description: string): string | undefined {
  const match = description.match(PATH_RE)
  if (!match) return undefined
  const path = match[1].replace(/\\/g, '/').replace(/^src\/main\/resources\//, 'src/main/resources/')
  return path.startsWith('src/') ? path : `src/main/resources/${path}`
}

function defaultAllowedTools(kind: StepKind): string[] {
  switch (kind) {
    case 'inspect':
      return ['read_file', 'list_directory']
    case 'recipe':
      return ['create_recipe', 'read_file']
    case 'write':
      return ['write_file', 'create_recipe']
    case 'build':
      return ['trigger_build', 'run_command']
    case 'run':
      return ['trigger_build', 'run_command']
    case 'answer':
      return []
  }
}

function defaultMaxAttempts(kind: StepKind): number {
  if (kind === 'recipe') return 4
  if (kind === 'write') return 2
  if (kind === 'inspect') return 2
  return 2
}

function normalizeStep(step: PlanStepState): WorkflowStep {
  const kind = inferKind(step.description)
  const explicitPath = targetPathFromDescription(step.description)
  const targetPath = explicitPath || (kind === 'recipe' ? recipePath('<modid>', 'generated_recipe') : undefined)
  return {
    id: step.id,
    title: step.description,
    kind,
    status: normalizeStatus(step.status),
    targetPath,
    allowedTools: defaultAllowedTools(kind),
    maxAttempts: defaultMaxAttempts(kind),
    validation: kind === 'recipe'
      ? { type: 'recipe_written', path: targetPath }
      : kind === 'write'
        ? { type: 'file_exists', path: targetPath }
        : kind === 'build'
          ? { type: 'build_success' }
          : kind === 'run'
            ? { type: 'run_started' }
            : { type: 'tool_success' }
  }
}

export function normalizeWorkflowSteps(steps: PlanStepState[]): WorkflowStep[] {
  return steps.map(normalizeStep)
}
