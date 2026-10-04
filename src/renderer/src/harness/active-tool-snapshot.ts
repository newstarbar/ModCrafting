import type { ActiveToolSnapshot } from '../../../shared/harness-runtime.ts'
import type { Registry } from './tools.ts'
import { isControlTool, isKnowledgeTool, isProjectWriteTool } from './tool-policy.ts'
import type { StepKind } from './workflow-types.ts'

export interface ActiveToolSnapshotOptions {
  registry: Registry
  phase: 'plan' | 'execute' | 'chat'
  turnId: string
  stepId?: number
  /** Existing deterministic gates may narrow candidates before this resolver.
   * The resulting snapshot is still the single source used for request and
   * response validation. */
  candidateTools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  chatToolNames?: Set<string>
  stepKind?: StepKind
  repairMode?: boolean
  exploreExhausted?: boolean
  stripKnowledge?: boolean
}

function phaseAllowed(name: string, phase: ActiveToolSnapshotOptions['phase']): boolean {
  if (phase === 'plan') {
    return isControlTool(name) || isKnowledgeTool(name) || name === 'read_file' || name === 'list_directory' || name === 'grep' || name === 'explain_code'
  }
  if (phase === 'chat') {
    return isControlTool(name) || isKnowledgeTool(name) || name === 'read_file' || name === 'explain_code'
  }
  return true
}

function stepCapabilityAllowed(name: string, options: ActiveToolSnapshotOptions): boolean {
  if (options.phase !== 'execute' || !options.stepKind) return true
  const kind = options.stepKind
  if (kind === 'answer') {
    if (isProjectWriteTool(name) || name === 'trigger_build' || name === 'run_command' || /^mc_/.test(name)) return false
  }
  if (kind === 'build') {
    if (/^mc_/.test(name)) return false
    if (!options.repairMode && isProjectWriteTool(name)) return false
  }
  if (kind === 'run') {
    if (!options.repairMode && isProjectWriteTool(name)) return false
  }
  if (kind === 'game_test') {
    if (!options.repairMode && (isProjectWriteTool(name) || name === 'trigger_build' || name === 'run_command')) return false
  }
  if (kind === 'test_design') {
    if (isProjectWriteTool(name) || name === 'trigger_build' || name === 'run_command') return false
    if (
      name === 'mc_run_test' ||
      name === 'mc_ensure_test_world' ||
      name === 'mc_ensure_cheats' ||
      name === 'mc_command' ||
      name === 'mc_input' ||
      name === 'mc_chat' ||
      name === 'mc_screenshot'
    ) {
      return false
    }
  }
  if (kind === 'inspect' || kind === 'write' || kind === 'recipe' || kind === 'mixin') {
    if (/^mc_/.test(name) || name === 'trigger_build') return false
    if (name === 'run_command' && kind !== 'recipe') return false
    if (kind === 'inspect' && isProjectWriteTool(name)) return false
  }
  if (options.exploreExhausted && (name === 'list_directory' || name === 'grep')) return false
  if (options.stripKnowledge && isKnowledgeTool(name)) return false
  return true
}

/** Build one immutable capability snapshot per model turn. */
export function createActiveToolSnapshot(options: ActiveToolSnapshotOptions): ActiveToolSnapshot {
  const all = options.registry.schemas()
  const candidates = options.candidateTools || all
  const candidateNames = new Set(candidates.map((tool) => tool.name))
  const tools = candidates.filter((tool) => {
    if (!phaseAllowed(tool.name, options.phase)) return false
    if (!stepCapabilityAllowed(tool.name, options)) return false
    if (options.chatToolNames && !options.chatToolNames.has(tool.name)) return false
    // A plan/chat phase must never accidentally expose a write/build/game
    // capability even if an old checkpoint supplied a stale tool list.
    if (options.phase !== 'execute' && isProjectWriteTool(tool.name)) return false
    return true
  })
  const inactiveReasons: Record<string, string> = {}
  for (const tool of all) {
    if (!candidateNames.has(tool.name)) inactiveReasons[tool.name] = 'not selected by current phase/step gate'
    else if (!phaseAllowed(tool.name, options.phase)) inactiveReasons[tool.name] = `capability inactive in ${options.phase} phase`
    else if (!stepCapabilityAllowed(tool.name, options)) inactiveReasons[tool.name] = `capability inactive in ${options.stepKind || options.phase} step`
    else if (options.chatToolNames && !options.chatToolNames.has(tool.name)) inactiveReasons[tool.name] = 'chat capability set excludes this tool'
  }
  return {
    version: 1,
    turnId: options.turnId,
    phase: options.phase,
    ...(options.stepId == null ? {} : { stepId: options.stepId }),
    tools,
    inactiveReasons,
    createdAt: Date.now()
  }
}

export function snapshotToolNames(snapshot: ActiveToolSnapshot): string[] {
  return snapshot.tools.map((tool) => tool.name)
}
