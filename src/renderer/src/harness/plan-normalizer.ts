import type { PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'
import { isCombinedBuildRunDescription } from '../utils/plan-steps.ts'
import type { StepKind, WorkflowStep, WorkflowStatus } from './workflow-types.ts'
import { resolveCompiledStepKind } from './plan-compiler.ts'
import { recommendedToolNames } from './tool-policy.ts'

const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;）)]+)(?:`)?/i

const BUILD_STEP_TITLE = '构建项目（gradlew build / trigger_build build）'
const RUN_STEP_TITLE = '启动游戏进行真实测试（runClient）'
export const GAME_TEST_STEP_TITLE = '执行确定性游戏测试（mc_test_scenario → mc_run_test；PASS 才完成）'

const EXPLICIT_KIND_RE = /^\[(write|recipe|mixin|inspect)\]\s*/i

const WRITE_SIGNAL_RE =
  /创建|写入|生成|修改|移除|删除|迁移|物品|方块|blockentity|mixin|datagen|资源|模型|战利品|标签|工具类|快捷键|配置文件|\.json|\.java|\.gradle|\.properties|\.toml/i

const INSPECT_SIGNAL_RE =
  /查询|搜索|校验|验证|文档|javadoc|wiki|mappings|fabric_docs_search|fabric_meta_version_check|fabric_mod_json_validate/i

function parseExplicitKind(description: string): {
  kind?: 'inspect' | 'write' | 'recipe' | 'mixin'
  body: string
} {
  const match = description.match(EXPLICIT_KIND_RE)
  if (!match) return { body: description }
  const kind = match[1].toLowerCase() as 'inspect' | 'write' | 'recipe' | 'mixin'
  return { kind, body: description.slice(match[0].length).trim() }
}

function inferKind(
  description: string,
  explicitKind?: StepKind
): StepKind {
  const d = description.toLowerCase()
  // Legacy V2 plans mislabeled this terminal as inspect. Semantic test markers win.
  if (/mc_run_test|确定性游戏测试|执行功能测试|验证功能效果|mc_test_scenario/.test(d)) return 'game_test'
  if (explicitKind === 'write' || explicitKind === 'recipe' || explicitKind === 'mixin' || explicitKind === 'inspect' || explicitKind === 'game_test') {
    return explicitKind
  }

  const parsed = parseExplicitKind(description)
  if (parsed.kind) return parsed.kind

  const body = parsed.body.toLowerCase()
  if (/runclient|启动游戏|运行游戏|进入测试世界|进入世界|mc_ensure_test_world|mc_ensure_cheats/.test(body)) return 'run'
  if (/gradlew|gradle\s|trigger_build|编译|构建|build/.test(body)) return 'build'
  if (/配方|合成|recipe|recipes/.test(body)) return 'recipe'
  if (/mixin|@mixin|mixins?\.json/.test(body)) return 'mixin'
  if (
    INSPECT_SIGNAL_RE.test(parsed.body) ||
    /查询知识库|知识库|mixins?\.json|mixin\s*配置|fabric\.mod\.json/.test(body)
  ) {
    return 'inspect'
  }
  if (WRITE_SIGNAL_RE.test(parsed.body)) return 'write'
  if (/读取|查看|检查|获取|确认|read|list/.test(body)) return 'inspect'
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

/** GUI 语义关键词：用于检测步骤是否涉及 GUI 布局变更（收紧：移除"渲染""标题""overlay"等过宽词） */
const GUI_KEYWORD_RE = /ConfigScreen|GuiScreen|TitleScreen|OptionListWidget|HudRenderCallback|addRenderableWidget|drawWidget|布局预览|GUI 布局|界面布局/i

/** 检测文件路径是否为 GUI 文件（仅匹配承载 GUI 组件的类，排除 ScreenshotHandler 等逻辑类） */
export function isGuiFilePath(path: string): boolean {
  return /(?:^|[\\/])(?:Screen|HudOverlay|HudRender|GuiScreen|ConfigScreen)\.java$/i.test(path)
        || /(?:Screen|Hud)\w*(?:Renderer|Widget|Overlay)\.java$/i.test(path)
}

/** 检测步骤是否需要 GUI 布局预览 */
export function stepRequiresGuiPreview(description: string, targetPath?: string): boolean {
  if (GUI_KEYWORD_RE.test(description)) return true
  if (targetPath && isGuiFilePath(targetPath)) return true
  return false
}

function defaultAllowedTools(kind: StepKind): string[] {
	return recommendedToolNames(kind)
}

function defaultMaxAttempts(kind: StepKind): number {
  if (kind === 'recipe') return 4
  if (kind === 'mixin') return 6
  if (kind === 'build') return 6
  if (kind === 'run') return 20
  if (kind === 'game_test') return 8
  // write often needs a few docs lookups before the first write_file
  if (kind === 'write') return 6
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
  const inferred = inferKind(step.description, step.kind)
  // Persisted/resume plans may still carry kind=mixin from the old compiler.
  // Re-resolve so hybrid Screen/Client + mixins.json steps get write_file back.
  const resolved = resolveCompiledStepKind({
    kind: inferred === 'write' || inferred === 'recipe' || inferred === 'mixin' || inferred === 'inspect'
      ? inferred
      : step.kind,
    description: step.description,
    targetPath: step.targetPath,
    targetPaths: step.targetPaths
  })
  const kind: StepKind =
    resolved === 'write' || resolved === 'recipe' || resolved === 'mixin' || resolved === 'inspect'
      ? resolved
      : inferred
  const explicitPath = step.targetPath || targetPathFromDescription(step.description)
  const targetPath = explicitPath || (kind === 'recipe' ? recipePath('<modid>', 'generated_recipe') : undefined)
  const targetPaths = step.targetPaths?.length ? [...step.targetPaths] : (targetPath ? [targetPath] : undefined)
  const requiresGuiPreview = stepRequiresGuiPreview(step.description, targetPath)
  return {
    id: step.id,
    title: step.description,
    kind,
    status: normalizeStatus(step.status),
    targetPath,
    targetPaths,
    ...(step.evidence ? { evidence: step.evidence } : {}),
    ...(step.gameTest ? { gameTest: step.gameTest } : {}),
    allowedTools: defaultAllowedTools(kind),
    maxAttempts: defaultMaxAttempts(kind),
    ...(requiresGuiPreview ? { requiresGuiPreview } : {}),
    validation: kind === 'recipe'
      ? { type: 'recipe_validated', path: targetPath }
      : kind === 'mixin'
        ? { type: 'mixin_validated', path: targetPath }
      : kind === 'write'
        ? { type: 'file_exists', path: targetPath }
        : kind === 'build'
          ? { type: 'build_success' }
          : kind === 'run'
            ? { type: 'run_started' }
            : kind === 'game_test'
              ? { type: 'game_test_passed' }
            : { type: 'tool_success' }
  }
}

export function normalizeWorkflowSteps(steps: PlanStepState[]): WorkflowStep[] {
  return canonicalizePlanSteps(steps).map(normalizeStep)
}

/**
 * Repairs persisted V2 plans whose deterministic test was saved as inspect or
 * placed before build/run. It is intentionally idempotent for new plans.
 */
export function canonicalizePlanSteps(steps: PlanStepState[]): PlanStepState[] {
  const expanded = expandCombinedTerminalSteps(steps)
  const classified = expanded.map((step) => {
    const kind = inferKind(step.description, step.kind)
    return {
      ...step,
      ...(kind === 'inspect' || kind === 'write' || kind === 'recipe' || kind === 'mixin' || kind === 'build' || kind === 'run' || kind === 'game_test' ? { kind } : {}),
      ...(kind === 'game_test' && step.status === 'error' ? { status: 'pending' as const } : {})
    }
  })
  const implementation = classified.filter((step) => !['build', 'run', 'game_test'].includes(inferKind(step.description, step.kind)))
  const build = classified.find((step) => inferKind(step.description, step.kind) === 'build')
  const run = classified.find((step) => inferKind(step.description, step.kind) === 'run')
  const gameTest = classified.find((step) => inferKind(step.description, step.kind) === 'game_test')
  const terminals: PlanStepState[] = []
  if (build) terminals.push(build)
  if (run) terminals.push(run)
  if (gameTest) terminals.push(gameTest)
  return [...implementation, ...terminals].map((step, index) => ({ ...step, id: String(index + 1) }))
}
