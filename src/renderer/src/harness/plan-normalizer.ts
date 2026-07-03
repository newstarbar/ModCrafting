import type { PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'
import { isCombinedBuildRunDescription } from '../utils/plan-steps.ts'
import type { StepKind, WorkflowStep, WorkflowStatus } from './workflow-types.ts'

const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;）)]+)(?:`)?/i

const BUILD_STEP_TITLE = '构建项目（gradlew build / trigger_build build）'
const RUN_STEP_TITLE = '启动游戏进行真实测试（runClient）'

function inferKind(description: string): StepKind {
  const d = description.toLowerCase()
  if (/runclient|启动游戏|运行游戏/.test(d)) return 'run'
  if (/gradlew|gradle\s|trigger_build|编译|构建|build/.test(d)) return 'build'
  if (/读取|查看|检查|获取|确认|查询|搜索|校验|验证|文档|javadoc|wiki|mappings|read|list|fabric\.mod\.json/.test(d)) return 'inspect'
  if (/配方|合成|recipe|recipes/.test(d)) return 'recipe'
  if (/创建|写入|生成|修改|物品|方块|blockentity|mixin|datagen|资源|模型|战利品|标签|\.json|\.java|\.gradle|\.properties|\.toml/.test(d)) return 'write'
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
      return [
        'read_file',
        'list_directory',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate',
        'fabric_log_debugger',
        'read_error_log'
      ]
    case 'recipe':
      return [
        'fabric_recipe_generate',
        'create_recipe',
        'read_file',
        'list_directory',
        'run_command',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate'
      ]
    case 'write':
      return [
        'write_file',
        'fabric_content_register',
        'fabric_data_assets_generate',
        'fabric_mixin_scaffold',
        'fabric_recipe_generate',
        'create_recipe',
        'read_file',
        'list_directory',
        'run_command',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate'
      ]
    case 'build':
      return [
        'trigger_build',
        'run_command',
        'fabric_log_debugger',
        'fabric_docs_search',
        'read_error_log',
        'list_directory',
        'read_file'
      ]
    case 'run':
      return [
        'trigger_build',
        'run_command',
        'fabric_log_debugger',
        'fabric_docs_search',
        'read_error_log',
        'list_directory',
        'read_file'
      ]
    case 'answer':
      return []
  }
}

function defaultMaxAttempts(kind: StepKind): number {
  if (kind === 'recipe') return 4
  if (kind === 'build') return 6
  if (kind === 'run') return 4
  if (kind === 'write') return 2
  if (kind === 'inspect') return 2
  return 2
}

function splitStatusForCombinedStep(status: PlanStepState['status']): {
  buildStatus: PlanStepState['status']
  runStatus: PlanStepState['status']
} {
  if (status === 'completed') {
    return { buildStatus: 'completed', runStatus: 'completed' }
  }
  if (status === 'running') {
    return { buildStatus: 'running', runStatus: 'pending' }
  }
  return { buildStatus: 'pending', runStatus: 'pending' }
}

/** Expand a combined build+run plan line into two workflow steps. */
export function expandCombinedTerminalSteps(steps: PlanStepState[]): PlanStepState[] {
  const expanded: PlanStepState[] = []
  for (const step of steps) {
    if (!isCombinedBuildRunDescription(step.description)) {
      expanded.push(step)
      continue
    }
    const { buildStatus, runStatus } = splitStatusForCombinedStep(step.status)
    expanded.push({ ...step, description: BUILD_STEP_TITLE, status: buildStatus })
    expanded.push({ ...step, description: RUN_STEP_TITLE, status: runStatus })
  }
  return expanded.map((step, index) => ({ ...step, id: String(index + 1) }))
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
  return expandCombinedTerminalSteps(steps).map(normalizeStep)
}
