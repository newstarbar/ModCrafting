// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FABRIC_KNOWLEDGE_SOURCES } from '../harness/fabric-agent-policy'
import { Registry } from '../harness/tools'
import { registerModCraftingTools } from '../harness/tool-definitions'

export type ToolsPanelMode = 'tools' | 'knowledge' | 'skills'

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
  disabledSkills?: string[]
  mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
}

function uid(): string {
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const ToolsPanel: React.FC<{ mode: ToolsPanelMode; onConfigSaved?: () => void }> = ({ mode, onConfigSaved }) => {
  const [sources, setSources] = useState<KnowledgeSourceRow[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerRow[]>([])
  const [disabledTools, setDisabledTools] = useState<Set<string>>(new Set())
  const [knowledgeFiles, setKnowledgeFiles] = useState<Array<{ path: string; bundled: boolean; overridden: boolean }>>([])
  const [selectedKnowledgeFile, setSelectedKnowledgeFile] = useState<string | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState('')
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; relPath: string; bundled: boolean; overridden: boolean; enabled: boolean }>>([])
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set())
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [saveHint, setSaveHint] = useState('')
  const [loading, setLoading] = useState(true)

  const builtinTools = useMemo(() => {
    if (mode !== 'tools') return []
    const registry = new Registry()
    registerModCraftingTools(registry)
    return registry.schemas()
  }, [mode])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const cfg = await window.api.loadAgentConfig()
      if (mode === 'tools') {
        setDisabledTools(new Set(cfg.disabledTools || []))
        setMcpServers((cfg.mcpServers || []).map((server) => ({
          id: server.id,
          name: server.name,
          command: server.command,
          args: (server.args || []).join(' '),
          env: JSON.stringify(server.env || {}, null, 2),
          enabled: server.enabled !== false
        })))
      } else if (mode === 'skills') {
        const rows = await window.api.listSkills()
        setSkills(rows)
        const disabled = new Set(cfg.disabledSkills || [])
        // 磁盘上可能残留已改名/已删除技能的 id，按当前技能列表重新对齐
        setDisabledSkills(new Set(rows.filter((row) => disabled.has(row.id)).map((row) => row.id)))
        setSelectedSkillId((prev) => prev || rows[0]?.id || null)
      } else {
        const files = await window.api.listKnowledgeFiles()
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
        setKnowledgeFiles(files)
        setSelectedKnowledgeFile((prev) => prev || files[0]?.path || null)
      }
    } finally {
      setLoading(false)
    }
  }, [mode])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (mode !== 'knowledge' || !selectedKnowledgeFile) return
    void (async () => {
      const res = await window.api.knowledgeReadLocal(selectedKnowledgeFile)
      setKnowledgeDraft(res.success ? (res.content || '') : `读取失败: ${res.error || 'unknown'}`)
    })()
  }, [mode, selectedKnowledgeFile])

  // 技能正文按整份 SKILL.md 编辑（原样取回，保留未知 frontmatter 字段），保存即写入 userData 覆盖层
  useEffect(() => {
    if (mode !== 'skills' || !selectedSkillId) return
    void (async () => {
      const res = await window.api.readSkill(selectedSkillId)
      setSkillDraft(res.success ? (res.raw ?? res.content ?? '') : `读取失败: ${res.error || 'unknown'}`)
    })()
  }, [mode, selectedSkillId])

  const saveConfig = useCallback(async () => {
    // 分 mode 写入，避免覆盖另一设置分区刚保存的字段
    const existing = await window.api.loadAgentConfig()
    const payload: AgentConfigState = mode === 'tools'
      ? {
          knowledgeSourceOverrides: existing.knowledgeSourceOverrides || [],
          disabledTools: [...disabledTools],
          disabledSkills: existing.disabledSkills || [],
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
      : mode === 'skills'
        ? {
            knowledgeSourceOverrides: existing.knowledgeSourceOverrides || [],
            disabledTools: existing.disabledTools || [],
            disabledSkills: [...disabledSkills],
            mcpServers: existing.mcpServers || []
          }
        : {
            knowledgeSourceOverrides: sources.map((s) => ({
              id: s.id,
              title: s.title,
              url: s.url,
              useFor: s.useFor,
              enabled: s.enabled
            })),
            disabledTools: existing.disabledTools || [],
            disabledSkills: existing.disabledSkills || [],
            mcpServers: existing.mcpServers || []
          }
    const res = await window.api.saveAgentConfig(payload)
    if (res.success) {
      setSaveHint('已保存')
      onConfigSaved?.()
      window.dispatchEvent(new Event('agent-config-saved'))
      window.setTimeout(() => setSaveHint(''), 2000)
    } else {
      setSaveHint(res.error || '保存失败')
    }
  }, [mode, sources, disabledTools, disabledSkills, mcpServers, onConfigSaved])

  const saveKnowledgeFile = useCallback(async () => {
    if (!selectedKnowledgeFile) return
    const res = await window.api.knowledgeSaveLocal(selectedKnowledgeFile, knowledgeDraft)
    setSaveHint(res.success ? '知识库文件已保存' : (res.error || '保存失败'))
    if (res.success) void loadAll()
    window.setTimeout(() => setSaveHint(''), 2000)
  }, [selectedKnowledgeFile, knowledgeDraft, loadAll])

  const saveSkillFile = useCallback(async () => {
    if (!selectedSkillId) return
    const res = await window.api.saveSkill(selectedSkillId, skillDraft)
    setSaveHint(res.success ? '技能已保存为用户版本' : (res.error || '保存失败'))
    if (res.success) void loadAll()
    window.setTimeout(() => setSaveHint(''), 2500)
  }, [selectedSkillId, skillDraft, loadAll])

  const resetSkillFile = useCallback(async () => {
    if (!selectedSkillId) return
    const res = await window.api.resetSkillOverride(selectedSkillId)
    setSaveHint(res.success ? '已恢复内置版本' : (res.error || '恢复失败'))
    if (res.success) void loadAll()
    window.setTimeout(() => setSaveHint(''), 2500)
  }, [selectedSkillId, loadAll])

  if (loading) {
    return <div className="tools-panel"><div className="mc-dim">加载 Agent 配置…</div></div>
  }

  return (
    <div className="tools-panel">
      {saveHint && <div className="tools-panel-hint">{saveHint}</div>}

      {mode === 'tools' && (
        <>
          <div className="tools-panel-section">
            <h3 className="tools-panel-section-title">内置工具</h3>
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
              </div>
            ))}
            <button type="button" className="btn-primary" onClick={() => void saveConfig()}>保存工具开关</button>
          </div>

          <div className="tools-panel-section" style={{ marginTop: 20 }}>
            <h3 className="tools-panel-section-title">MCP</h3>
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
        </>
      )}

      {mode === 'knowledge' && (
        <>
          <div className="tools-panel-section">
            <h3 className="tools-panel-section-title">知识源</h3>
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

          <div className="tools-panel-section" style={{ marginTop: 20 }}>
            <h3 className="tools-panel-section-title">本地知识库文件</h3>
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
        </>
      )}

      {mode === 'skills' && (
        <>
          <div className="tools-panel-section">
            <h3 className="tools-panel-section-title">技能包</h3>
            <div className="mc-dim" style={{ fontSize: 12, marginBottom: 8 }}>
              技能是写给 Agent 的可复用流程指令。索引常驻系统提示词，完整正文由 Agent 按需调用 read_skill 取回。
            </div>
            {skills.length === 0 && (
              <div className="mc-dim" style={{ fontSize: 12 }}>未找到技能。内置技能位于应用资源的 skills/ 目录，用户技能位于 userData/skills/。</div>
            )}
            {skills.map((skill) => (
              <div key={skill.id} className="tools-panel-card">
                <label className="tools-panel-row">
                  <input
                    type="checkbox"
                    checked={!disabledSkills.has(skill.id)}
                    onChange={(e) => {
                      const next = new Set(disabledSkills)
                      if (e.target.checked) next.delete(skill.id)
                      else next.add(skill.id)
                      setDisabledSkills(next)
                    }}
                  />
                  <strong>{skill.name}</strong>
                  <span className="mc-dim" style={{ fontSize: 12, marginLeft: 6 }}>
                    {skill.id}{skill.overridden ? ' · 用户版本' : ''}
                  </span>
                </label>
                <div className="mc-dim" style={{ fontSize: 12, marginTop: 4 }}>{skill.description}</div>
              </div>
            ))}
            <button type="button" className="btn-primary" onClick={() => void saveConfig()}>保存技能开关</button>
          </div>

          <div className="tools-panel-section" style={{ marginTop: 20 }}>
            <h3 className="tools-panel-section-title">技能内容</h3>
            <select
              className="tools-panel-input"
              value={selectedSkillId || ''}
              onChange={(e) => setSelectedSkillId(e.target.value)}
            >
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.id}{skill.overridden ? ' (已覆盖)' : ''}
                </option>
              ))}
            </select>
            <textarea
              className="tools-panel-textarea tools-panel-editor"
              value={skillDraft}
              onChange={(e) => setSkillDraft(e.target.value)}
            />
            <button type="button" className="btn-primary" onClick={() => void saveSkillFile()}>保存为用户技能</button>
            {skills.find((skill) => skill.id === selectedSkillId)?.overridden && (
              <button type="button" className="btn-ghost" onClick={() => void resetSkillFile()}>恢复内置版本</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default ToolsPanel
