import type { StepKind } from './workflow-types.ts'

/** A small, declarative vocabulary shared by offering, gating, scheduling and telemetry. */
export type ToolCapability =
  | 'project.read'
  | 'project.write'
  | 'knowledge.read'
  | 'process.build'
  | 'process.shell'
  | 'game.observe'
  | 'game.control'
  | 'user.interaction'
  | 'workflow.control'

export type ToolExecutionClass = 'fast' | 'knowledge' | 'game' | 'world' | 'process' | 'interactive'

export interface ToolPolicy {
  capabilities: ToolCapability[]
  executionClass: ToolExecutionClass
  /** Undefined means an explicit user interaction which must be cancelled by the host. */
  timeoutMs?: number
  idleTimeoutMs?: number
  cancellable: boolean
}

const FAST: ToolPolicy = { capabilities: ['project.read'], executionClass: 'fast', timeoutMs: 15_000, cancellable: true }
const KNOWLEDGE: ToolPolicy = { capabilities: ['knowledge.read'], executionClass: 'knowledge', timeoutMs: 60_000, cancellable: true }
const GAME: ToolPolicy = { capabilities: ['game.observe'], executionClass: 'game', timeoutMs: 30_000, cancellable: true }
const WORLD: ToolPolicy = { capabilities: ['game.control'], executionClass: 'world', timeoutMs: 150_000, cancellable: true }
const PROCESS: ToolPolicy = { capabilities: ['process.shell'], executionClass: 'process', timeoutMs: 5 * 60_000, idleTimeoutMs: 90_000, cancellable: true }
const BUILD: ToolPolicy = { capabilities: ['process.build'], executionClass: 'process', timeoutMs: 10 * 60_000, idleTimeoutMs: 3 * 60_000, cancellable: true }
const INTERACTIVE: ToolPolicy = { capabilities: ['user.interaction'], executionClass: 'interactive', cancellable: true }
const CONTROL: ToolPolicy = { capabilities: ['workflow.control'], executionClass: 'fast', timeoutMs: 15_000, cancellable: true }

function withCapabilities(base: ToolPolicy, capabilities: ToolCapability[]): ToolPolicy {
  return { ...base, capabilities }
}

function assign(names: string[], policy: ToolPolicy, out: Record<string, ToolPolicy>): void {
  for (const name of names) out[name] = policy
}

/**
 * The only catalogue of built-in tool behaviour. New built-ins must be added here;
 * Registry.validatePolicies makes omissions fail during app startup/tests.
 */
export const BUILTIN_TOOL_POLICIES: Record<string, ToolPolicy> = (() => {
  const out: Record<string, ToolPolicy> = {}
  assign(['read_file', 'list_directory', 'grep', 'read_error_log', 'explain_code', 'list_templates'], FAST, out)
  assign(['fabric_docs_search', 'fabric_javadoc_lookup', 'vanilla_mc_wiki_query', 'minecraft_data_lookup', 'mc_wiki_search', 'fabric_meta_version_check', 'fabric_mod_json_validate', 'fabric_log_debugger', 'fabric_mixin_target_lookup', 'fabric_recipe_validate', 'fabric_mixin_validate', 'mc_test_scenario'], KNOWLEDGE, out)
  assign(['write_file', 'edit_file', 'delete_file', 'create_recipe', 'fabric_recipe_generate', 'fabric_content_register', 'fabric_data_assets_generate', 'fabric_mixin_scaffold', 'fabric_mixin_register', 'fabric_template_generate'], withCapabilities(FAST, ['project.write']), out)
  assign(['run_command'], PROCESS, out)
  assign(['trigger_build'], BUILD, out)
  assign(['mc_screenshot', 'mc_inspect', 'mc_inventory', 'mc_world', 'mc_observe_entity'], GAME, out)
  assign(['mc_chat', 'mc_command', 'mc_input'], withCapabilities(GAME, ['game.control']), out)
  assign(['mc_ensure_test_world', 'mc_ensure_cheats', 'mc_run_test'], WORLD, out)
  assign(['gui_layout_preview'], INTERACTIVE, out)
  assign(['submit_plan', 'complete_step', 'ask_clarification'], CONTROL, out)
  return out
})()

export function getBuiltinToolPolicy(name: string): ToolPolicy | undefined {
  return BUILTIN_TOOL_POLICIES[name]
}

export function isKnowledgeTool(name: string, policy?: ToolPolicy): boolean {
  return (policy ?? getBuiltinToolPolicy(name))?.capabilities.includes('knowledge.read') ?? false
}

export function isExploreTool(name: string, policy?: ToolPolicy): boolean {
  const capabilities = (policy ?? getBuiltinToolPolicy(name))?.capabilities ?? []
  return capabilities.includes('project.read')
}

export function isControlTool(name: string, policy?: ToolPolicy): boolean {
  const capabilities = (policy ?? getBuiltinToolPolicy(name))?.capabilities ?? []
  return capabilities.includes('workflow.control') || capabilities.includes('user.interaction')
}

export function isWriteTool(name: string, policy?: ToolPolicy): boolean {
  const capabilities = (policy ?? getBuiltinToolPolicy(name))?.capabilities ?? []
  return capabilities.some((capability) => ['project.write', 'process.build', 'process.shell', 'game.control', 'user.interaction'].includes(capability))
}

export function isProjectWriteTool(name: string, policy?: ToolPolicy): boolean {
  return (policy ?? getBuiltinToolPolicy(name))?.capabilities.includes('project.write') ?? false
}

const PLAN_CAPABILITIES = new Set<ToolCapability>(['project.read', 'knowledge.read', 'workflow.control'])

/** Recommended tools are a prompt-shaping aid, not a second hard whitelist. */
export function recommendedToolNames(kind: StepKind, repairMode = false): string[] {
  const base = Object.entries(BUILTIN_TOOL_POLICIES).filter(([name, policy]) => {
    const caps = policy.capabilities
    if (kind === 'inspect') return caps.some((cap) => ['project.read', 'knowledge.read', 'workflow.control'].includes(cap))
    if (kind === 'write' || kind === 'recipe' || kind === 'mixin') {
      return caps.some((cap) => ['project.read', 'project.write', 'knowledge.read', 'process.shell', 'user.interaction', 'workflow.control'].includes(cap))
    }
    if (kind === 'build') {
      if (repairMode && caps.includes('project.write')) return true
      return caps.some((cap) => ['project.read', 'knowledge.read', 'process.build', 'process.shell', 'workflow.control'].includes(cap))
    }
    if (kind === 'run' || kind === 'game_test') {
      if (repairMode && caps.includes('project.write')) return true
      return caps.some((cap) => ['project.read', 'knowledge.read', 'process.build', 'process.shell', 'game.observe', 'game.control', 'workflow.control'].includes(cap))
    }
    return caps.some((cap) => ['project.read', 'workflow.control'].includes(cap))
  })
  return base.map(([name]) => name)
}

export function planToolNames(): string[] {
  return Object.entries(BUILTIN_TOOL_POLICIES)
    .filter(([name, policy]) => {
      if (name === 'complete_step') return false
      return policy.capabilities.some((capability) => PLAN_CAPABILITIES.has(capability))
    })
    .map(([name]) => name)
}
