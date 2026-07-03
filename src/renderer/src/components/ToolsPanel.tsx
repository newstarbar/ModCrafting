import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FABRIC_KNOWLEDGE_SOURCES } from '../harness/fabric-agent-policy'
import { Registry } from '../harness/tools'
import { registerModCraftingTools } from '../harness/tool-definitions'
import {
  clearToolActivity,
  subscribeToolActivity,
  type ToolActivityEntry
} from '../utils/tool-activity'

type PanelSection = 'sources' | 'tools' | 'knowledge' | 'mcp' | 'activity'

interface KnowledgeSourceRow {
  id: string
  title: string
  url: string
  useFor: string
  enabled: boolean
}

interface McpServerRow {
  id: string
  name: string
  command: string
  args: string
  env: string
  enabled: boolean
}

interface AgentConfigState {
  knowledgeSourceOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }>
  disabledTools: string[]
  mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
}

function uid(): string {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const ToolsPanel: React.FC<{ onConfigSaved?: () => void }> = ({ onConfigSaved }) => {
  const [section, setSection] = useState<PanelSection>('sources')
  const [sources, setSources] = useState<KnowledgeSourceRow[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerRow[]>([])
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set())
  const [knowledgeFiles, setKnowledgeFiles] = useState<Array<{ path: string; bundled: boolean; overridden: boolean }>>([])
  const [selectedKnowledgeFile, setSelectedKnowledgeFile] = useState<string | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState('')
  const [activity, setActivity] = useState<ToolActivityEntry[]>([])
  const [saveHint, setSaveHint] = useState('')
  const [loading, setLoading] = useState(true)

  const builtinTools = useMemo(() => {
    const registry = new Registry()
    registerModCraftingTools(registry)
    return registry.schemas()
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [cfg, files] = await Promise.all([
        window.api.loadAgentConfig(),
        window.api.listKnowledgeFiles()
      ])
      setDisabledTools(new Set(cfg.disabledTools || []))
      const overrideMap = new Map((cfg.knowledgeSourceOverrides || []).map((o) => [o.id, o]))
      setSources(FABRIC_KNOWLEDGE_SOURCES.map((source) => {
        const override = overrideMap.get(source.id)
        return {
          id: source.id,
          title: override?.title || source.title,
          url: override?.url || source.url,
          useFor: override?.useFor || source.useFor,
          enabled: override?.enabled !== false
        }
      }))
      setMcpServers((cfg.mcpServers || []).map((server) => ({
        id: server.id,
        name: server.name,
        command: server.command,
        args: (server.args || []).join(' '),
        env: JSON.stringify(server.env || {}, null, 2),
        enabled: server.enabled !== false
      })))
      setKnowledgeFiles(files)
      if (!selectedKnowledgeFile && files[0]) setSelectedKnowledgeFile(files[0].path)
    } finally {
      setLoading(false)
    }
  }, [selectedKnowledgeFile])

  useEffect(() => {
    void loadAll()
    return subscribeToolActivity(setActivity)
  }, [loadAll])

  useEffect(() => {
    if (!selectedKnowledgeFile) return
    void (async () => {
      const res = await window.api.knowledgeReadLocal(selectedKnowledgeFile)
      setKnowledgeDraft(res.success ? (res.content || '') : `读取失败: ${res.error || 'unknown'}`)
    })()
  }, [selectedKnowledgeFile])

  const saveConfig = useCallback(async () => {
    const payload: AgentConfigState = {
      knowledgeSourceOverrides: sources.map((s) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        useFor: s.useFor,
        enabled: s.enabled
      })),
      disabledTools: [...disabledTools],
      mcpServers: mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        command: s.command,
        args: s.args.trim() ? s.args.trim().split(/\s+/) : [],
        env: (() => {
          try { return JSON.parse(s.env || '{}') as Record<string, string> } catch { return {} }
        })(),
        enabled: s.enabled
      }))
    }
    const res = await window.api.saveAgentConfig(payload)
    if (res.success) {
      setSaveHint('已保存')
      onConfigSaved?.()
      window.setTimeout(() => setSaveHint(''), 2000)
    } else {
      setSaveHint(res.error || '保存失败')
    }
  }, [sources, disabledTools, mcpServers, onConfigSaved])

  const saveKnowledgeFile = useCallback(async () => {
    if (!selectedKnowledgeFile) return
    const res = await window.api.knowledgeSaveLocal(selectedKnowledgeFile, knowledgeDraft)
    setSaveHint(res.success ? '知识库文件已保存' : (res.error || '保存失败'))
    if (res.success) void loadAll()
    window.setTimeout(() => setSaveHint(''), 2000)
  }, [selectedKnowledgeFile, knowledgeDraft, loadAll])

  const sectionBtn = (key: PanelSection, label: string) => (
    <button
      type="button"
      className={`tools-panel-tab ${section === key ? 'active' : ''}`}
      onClick={() => setSection(key)}
    >
      {label}
    </button>
  )

  if (loading) {
    return <div className="tools-panel"><div className="mc-dim">加载 Agent 配置…</div></div>
  }

  return (
    <div className="tools-panel">
      <div className="tools-panel-tabs">
        {sectionBtn('sources', '知识源')}
        {sectionBtn('tools', '内置工具')}
        {sectionBtn('knowledge', '知识库')}
        {sectionBtn('mcp', 'MCP')}
        {sectionBtn('activity', '实时调用')}
      </div>

      {saveHint && <div className="tools-panel-hint">{saveHint}</div>}

      {section === 'sources' && (
        <div className="tools-panel-section">
          {sources.map((source, index) => (
            <div key={source.id} className="tools-panel-card">
              <label className="tools-panel-row">
                <input
                  type="checkbox"
                  checked={source.enabled}
                  onChange={(e) => {
                    const next = [...sources]
                    next[index] = { ...source, enabled: e.target.checked }
                    setSources(next)
                  }}
                />
                <span>{source.title}</span>
              </label>
              <input
                className="tools-panel-input"
                value={source.url}
                onChange={(e) => {
                  const next = [...sources]
                  next[index] = { ...source, url: e.target.value }
                  setSources(next)
                }}
                placeholder="URL"
              />
              <textarea
                className="tools-panel-textarea"
                rows={2}
                value={source.useFor}
                onChange={(e) => {
                  const next = [...sources]
                  next[index] = { ...source, useFor: e.target.value }
                  setSources(next)
                }}
                placeholder="用途说明"
              />
            </div>
          ))}
          <button type="button" className="btn-primary" onClick={() => void saveConfig()}>保存知识源配置</button>
        </div>
      )}

      {section === 'tools' && (
        <div className="tools-panel-section">
          {builtinTools.map((tool) => (
            <div key={tool.name} className="tools-panel-card">
              <label className="tools-panel-row">
                <input
                  type="checkbox"
                  checked={!disabledTools.has(tool.name)}
                  onChange={(e) => {
                    const next = new Set(disabledTools)
                    if (e.target.checked) next.delete(tool.name)
                    else next.add(tool.name)
                    setDisabledTools(next)
                  }}
                />
                <strong>{tool.name}</strong>
              </label>
              <div className="mc-dim" style={{ fontSize: 12, marginTop: 4 }}>{tool.description}</div>
              <pre className="tools-panel-pre">{JSON.stringify(tool.parameters, null, 2)}</pre>
            </div>
          ))}
          <button type="button" className="btn-primary" onClick={() => void saveConfig()}>保存工具开关</button>
        </div>
      )}

      {section === 'knowledge' && (
        <div className="tools-panel-section">
          <select
            className="tools-panel-input"
            value={selectedKnowledgeFile || ''}
            onChange={(e) => setSelectedKnowledgeFile(e.target.value)}
          >
            {knowledgeFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}{file.overridden ? ' (已覆盖)' : ''}
              </option>
            ))}
          </select>
          <textarea
            className="tools-panel-textarea tools-panel-editor"
            value={knowledgeDraft}
            onChange={(e) => setKnowledgeDraft(e.target.value)}
          />
          <button type="button" className="btn-primary" onClick={() => void saveKnowledgeFile()}>保存知识库文件</button>
        </div>
      )}

      {section === 'mcp' && (
        <div className="tools-panel-section">
          <div className="mc-dim" style={{ fontSize: 12, marginBottom: 8 }}>
            MCP 仅配置与展示，当前版本不会真正连接外部服务器。
          </div>
          {mcpServers.map((server, index) => (
            <div key={server.id} className="tools-panel-card">
              <label className="tools-panel-row">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => {
                    const next = [...mcpServers]
                    next[index] = { ...server, enabled: e.target.checked }
                    setMcpServers(next)
                  }}
                />
                <input
                  className="tools-panel-input"
                  value={server.name}
                  onChange={(e) => {
                    const next = [...mcpServers]
                    next[index] = { ...server, name: e.target.value }
                    setMcpServers(next)
                  }}
                  placeholder="名称"
                />
              </label>
              <input
                className="tools-panel-input"
                value={server.command}
                onChange={(e) => {
                  const next = [...mcpServers]
                  next[index] = { ...server, command: e.target.value }
                  setMcpServers(next)
                }}
                placeholder="command"
              />
              <input
                className="tools-panel-input"
                value={server.args}
                onChange={(e) => {
                  const next = [...mcpServers]
                  next[index] = { ...server, args: e.target.value }
                  setMcpServers(next)
                }}
                placeholder="args（空格分隔）"
              />
              <textarea
                className="tools-panel-textarea"
                rows={3}
                value={server.env}
                onChange={(e) => {
                  const next = [...mcpServers]
                  next[index] = { ...server, env: e.target.value }
                  setMcpServers(next)
                }}
                placeholder='env JSON，例如 {"API_KEY":"..."}'
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setMcpServers(mcpServers.filter((s) => s.id !== server.id))}
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setMcpServers([...mcpServers, { id: uid(), name: '新 MCP', command: '', args: '', env: '{}', enabled: true }])}
          >
            添加 MCP 服务器
          </button>
          <button type="button" className="btn-primary" onClick={() => void saveConfig()}>保存 MCP 配置</button>
        </div>
      )}

      {section === 'activity' && (
        <div className="tools-panel-section">
          <div className="tools-panel-row" style={{ justifyContent: 'space-between' }}>
            <span>最近 {activity.length} 条工具调用</span>
            <button type="button" className="btn-ghost" onClick={clearToolActivity}>清空</button>
          </div>
          {activity.length === 0 && <div className="mc-dim">暂无调用记录。开始 Agent 对话后会在此显示。</div>}
          {activity.map((entry) => (
            <div key={entry.id} className="tools-panel-card">
              <div className="tools-panel-row">
                <strong>{entry.name}</strong>
                <span className={`tools-status tools-status-${entry.status}`}>{entry.status}</span>
              </div>
              {entry.args && (
                <pre className="tools-panel-pre">{JSON.stringify(entry.args, null, 2)}</pre>
              )}
              {entry.output && (
                <pre className="tools-panel-pre">{entry.output.slice(0, 1200)}{entry.output.length > 1200 ? '…' : ''}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default ToolsPanel
