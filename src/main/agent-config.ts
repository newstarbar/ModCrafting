import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
}

export interface KnowledgeSourceOverride {
  id: string
  title?: string
  url?: string
  useFor?: string
  enabled?: boolean
}

export const DEFAULT_OPENCODE_MODEL = 'opencode/deepseek-v4-flash-free'

export interface AgentConfig {
  knowledgeSourceOverrides: KnowledgeSourceOverride[]
  disabledTools: string[]
  mcpServers: McpServerConfig[]
  /**
   * User preference for OpenCode write delegation.
   * Default true: enable when CLI is detected. Explicit false disables.
   */
  useOpenCodeDelegate?: boolean
  /** OpenCode Zen / provider model id */
  openCodeModel?: string
}

const DEFAULT_CONFIG: AgentConfig = {
  knowledgeSourceOverrides: [],
  disabledTools: [],
  mcpServers: [],
  useOpenCodeDelegate: true,
  openCodeModel: DEFAULT_OPENCODE_MODEL
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'agent-config.json')
}

export function loadAgentConfig(): AgentConfig {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<AgentConfig>
    const model = typeof parsed.openCodeModel === 'string' && parsed.openCodeModel.trim()
      ? parsed.openCodeModel.trim()
      : DEFAULT_OPENCODE_MODEL
    return {
      knowledgeSourceOverrides: Array.isArray(parsed.knowledgeSourceOverrides) ? parsed.knowledgeSourceOverrides : [],
      disabledTools: Array.isArray(parsed.disabledTools) ? parsed.disabledTools : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      // Missing key → prefer on; only explicit false disables
      useOpenCodeDelegate: parsed.useOpenCodeDelegate !== false,
      openCodeModel: model
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveAgentConfig(config: AgentConfig): { success: boolean; error?: string } {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    const model = typeof config.openCodeModel === 'string' && config.openCodeModel.trim()
      ? config.openCodeModel.trim()
      : DEFAULT_OPENCODE_MODEL
    fs.writeFileSync(configPath(), JSON.stringify({
      knowledgeSourceOverrides: config.knowledgeSourceOverrides || [],
      disabledTools: config.disabledTools || [],
      mcpServers: config.mcpServers || [],
      useOpenCodeDelegate: config.useOpenCodeDelegate !== false,
      openCodeModel: model
    }, null, 2), 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
