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

export interface AgentConfig {
  knowledgeSourceOverrides: KnowledgeSourceOverride[]
  disabledTools: string[]
  mcpServers: McpServerConfig[]
}

const DEFAULT_CONFIG: AgentConfig = {
  knowledgeSourceOverrides: [],
  disabledTools: [],
  mcpServers: []
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'agent-config.json')
}

export function loadAgentConfig(): AgentConfig {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<AgentConfig>
    return {
      knowledgeSourceOverrides: Array.isArray(parsed.knowledgeSourceOverrides) ? parsed.knowledgeSourceOverrides : [],
      disabledTools: Array.isArray(parsed.disabledTools) ? parsed.disabledTools : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : []
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveAgentConfig(config: AgentConfig): { success: boolean; error?: string } {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify({
      knowledgeSourceOverrides: config.knowledgeSourceOverrides || [],
      disabledTools: config.disabledTools || [],
      mcpServers: config.mcpServers || []
    }, null, 2), 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
