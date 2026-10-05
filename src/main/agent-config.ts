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
  disabledSkills: string[]
  mcpServers: McpServerConfig[]
}

const DEFAULT_CONFIG: AgentConfig = {
  knowledgeSourceOverrides: [],
  disabledTools: [],
  disabledSkills: [],
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
      // 旧配置文件没有这个字段，缺失即视为全部启用
      disabledSkills: Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills.filter((id): id is string => typeof id === 'string') : [],
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : []
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveAgentConfig(config: AgentConfig): { success: boolean; error?: string } {
  try {
    // 设置面板按分区保存，缺字段时保留磁盘上的原值，避免关掉某一区就抹掉其他区
    const existing = loadAgentConfig()
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify({
      knowledgeSourceOverrides: Array.isArray(config?.knowledgeSourceOverrides) ? config.knowledgeSourceOverrides : existing.knowledgeSourceOverrides,
      disabledTools: Array.isArray(config?.disabledTools) ? config.disabledTools : existing.disabledTools,
      disabledSkills: Array.isArray(config?.disabledSkills) ? config.disabledSkills : existing.disabledSkills,
      mcpServers: Array.isArray(config?.mcpServers) ? config.mcpServers : existing.mcpServers
    }, null, 2), 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
