import type { PlanStepState } from './plan-tracker.ts'
import { recipePath } from './recipe-utils.ts'
import { isCombinedBuildRunDescription } from '../utils/plan-steps.ts'
import type { StepKind, WorkflowStep, WorkflowStatus } from './workflow-types.ts'
import { resolveCompiledStepKind } from './plan-compiler.ts'

const PATH_RE = /(?:`)?((?:src\/|data\/|gradle\/)[^\s`，,。；;）)]+)(?:`)?/i

const BUILD_STEP_TITLE = '构建项目（gradlew build / trigger_build build）'
const RUN_STEP_TITLE = '启动游戏进行真实测试（runClient）'

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
  explicitKind?: 'inspect' | 'write' | 'recipe' | 'mixin'
): StepKind {
  if (explicitKind === 'write' || explicitKind === 'recipe' || explicitKind === 'mixin' || explicitKind === 'inspect') {
    return explicitKind
  }

  const parsed = parseExplicitKind(description)
  if (parsed.kind) return parsed.kind

  const d = parsed.body.toLowerCase()
  if (/runclient|启动游戏|运行游戏|进入测试世界|进入世界|执行功能测试|验证功能效果|mc_ensure_test_world|mc_ensure_cheats/.test(d)) return 'run'
  if (/gradlew|gradle\s|trigger_build|编译|构建|build/.test(d)) return 'build'
  if (/配方|合成|recipe|recipes/.test(d)) return 'recipe'
  if (/mixin|@mixin|mixins?\.json/.test(d)) return 'mixin'
  if (
    INSPECT_SIGNAL_RE.test(parsed.body) ||
    /查询知识库|知识库|mixins?\.json|mixin\s*配置|fabric\.mod\.json/.test(d)
  ) {
    return 'inspect'
  }
  if (WRITE_SIGNAL_RE.test(parsed.body)) return 'write'
  if (/读取|查看|检查|获取|确认|read|list/.test(d)) return 'inspect'
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
  switch (kind) {
    case 'inspect':
      return [
        'read_file',
        'list_directory',
        'grep',
        'complete_step',
        'explain_code',
        'ask_clarification',
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
        'fabric_recipe_validate',
        'complete_step',
        'read_file',
        'list_directory',
        'grep',
        'ask_clarification',
        'run_command',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate'
      ]
    case 'mixin':
      return [
        'fabric_mixin_target_lookup',
        'fabric_mixin_scaffold',
        'fabric_mixin_register',
        'fabric_mixin_validate',
        'edit_file',
        'write_file',
        'delete_file',
        'read_file',
        'list_directory',
        'grep',
        'complete_step',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'fabric_log_debugger',
        // GUI 布局预览：Mixin 修改GUI渲染逻辑时需要
        'gui_layout_preview',
        'read_error_log'
      ]
    case 'write':
      return [
        'edit_file',
        'write_file',
        'delete_file',
        'complete_step',
        'fabric_template_generate',
        'fabric_content_register',
        'fabric_data_assets_generate',
        'fabric_recipe_generate',
        'create_recipe',
        // Hybrid write steps often also register mixins.json / update fabric.mod.json
        'fabric_mixin_register',
        'fabric_mixin_validate',
        'fabric_mixin_scaffold',
        'read_file',
        'list_directory',
        'grep',
        'ask_clarification',
        'run_command',
        'fabric_docs_search',
        'fabric_javadoc_lookup',
        'vanilla_mc_wiki_query',
        'fabric_meta_version_check',
        'fabric_mod_json_validate',
        // GUI 布局预览：编写 Screen/HUD 代码前必须先调用此工具让用户确认布局
        'gui_layout_preview'
      ]
    case 'build':
      return [
        'trigger_build',
        'run_command',
        // edit/write only after build fails (repair mode). Offering them here caused
        // schema/policy mismatch loops: model keeps calling edit_file → tool_not_allowed.
        'read_file',
        'list_directory',
        'grep',
        'ask_clarification',
        'fabric_log_debugger',
        'fabric_docs_search',
        'read_error_log',
        // GUI 布局预览：修复场景需要编辑GUI文件时可用
        'gui_layout_preview'
      ]
    case 'run':
      return [
        'trigger_build',
        'run_command',
        'read_file',
        'list_directory',
        'grep',
        'ask_clarification',
        'fabric_log_debugger',
        'fabric_docs_search',
        'read_error_log',
        'mc_screenshot',
        'mc_inspect',
        'mc_inventory',
        'mc_world',
        'mc_chat',
        'mc_command',
        'mc_input',
        'mc_ensure_test_world',
        'mc_ensure_cheats',
        // GUI 布局预览：测试失败修复GUI时可用
        'gui_layout_preview'
      ]
    case 'answer':
      return ['complete_step', 'explain_code', 'read_file', 'ask_clarification']
  }
}

function defaultMaxAttempts(kind: StepKind): number {
  if (kind === 'recipe') return 4
  if (kind === 'mixin') return 6
  if (kind === 'build') return 6
  if (kind === 'run') return 8
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
            : { type: 'tool_success' }
  }
}

export function normalizeWorkflowSteps(steps: PlanStepState[]): WorkflowStep[] {
  return expandCombinedTerminalSteps(steps).map(normalizeStep)
}
