import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Controller } from '../harness/controller'
import { Registry } from '../harness/tools'
import { registerModCraftingTools } from '../harness/tool-definitions'
import { EventKind } from '../harness/events'
import type { Event } from '../harness/events'
import TaskPlan from './TaskPlan'
import type { PlanStep } from './TaskPlan'
import { EMPTY_USAGE, estimateCostDelta, contextPercentFromPrompt, type UsageStats } from '../utils/usage'

interface ChatPanelProps {
  projectPath: string | null
  contextFiles: string[]
  setContextFiles: (files: string[]) => void
  selectedFile: { path: string; name: string } | null
  apiConfig: { endpoint: string; apiKey: string; model: string }
  ensureApiKey?: () => Promise<string | null>
  onUsageChange?: (usage: UsageStats) => void
  onRunningChange?: (running: boolean) => void
  currentSessionId: string | null
  sessions: Session[]
  onAppendToSession: (sessionId: string, role: string, content: string) => void
  onNewSession: (firstMessage?: string) => string
  onRenameSession: (id: string, name: string) => void
  toolchainReady?: boolean
}

const toolRegistry = new Registry()
registerModCraftingTools(toolRegistry)

interface ToolCallDisplay {
  id: string; name: string
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string; durationMs?: number
}

// A single chronologically-ordered entry in an assistant message
type ChronoEntry =
  | { kind: 'reasoning'; content: string }
  | { kind: 'text'; content: string }
  | { kind: 'tool'; id: string; name: string; status: 'pending' | 'running' | 'done' | 'error'; output?: string; durationMs?: number }

interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string  // kept for user messages
  entries?: ChronoEntry[]  // used for assistant messages — chronologically ordered
  isStreaming?: boolean
  timestamp: number
}

interface Session {
  id: string; name: string
  messages: Array<{ role: string; content: string }>
  createdAt: number; updatedAt: number
}


let msgId = 0
function uid(): string { return `msg-${++msgId}` }

// 工具中文名映射
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  list_directory: '列出目录',
  run_command: '运行命令',
  trigger_build: '触发构建',
  read_error_log: '读取错误日志',
  complete_step: '完成任务步骤'
}
function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name
}

// Parse plan steps from AI text output
// Looks for numbered lines like "1. 创建文件..." or "- 创建文件..."
function parsePlanSteps(text: string): PlanStep[] {
  const steps: PlanStep[] = []
  const lines = text.split('\n')
  let idCounter = 0
  for (const line of lines) {
    const trimmed = line.replace(/^[\s*\-]+/, '').trim()
    // Match: "1. something" or "1、something" or "- something"
    const match = trimmed.match(/^(\d+)[.\、\s]+(.+)$/)
    if (match) {
      idCounter++
      steps.push({
        id: String(idCounter),
        description: match[2].trim(),
        status: 'pending'
      })
    }
  }
  return steps
}

const ChatPanel: React.FC<ChatPanelProps> = ({ projectPath, contextFiles, setContextFiles, selectedFile, apiConfig, ensureApiKey, onUsageChange, onRunningChange, currentSessionId, sessions, onAppendToSession, onNewSession, onRenameSession, toolchainReady = true }) => {
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [agentStatus, setAgentStatus] = useState('')
  // sessions and currentSessionId come from App (single source of truth)
  // Use a ref so handleEvent (created once) always gets the latest session ID
  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<Controller | null>(null)

  const [collapsedToolIds, setCollapsedToolIds] = useState<Set<string>>(new Set())
  const [usageAccum, setUsageAccum] = useState<UsageStats>(EMPTY_USAGE)
  const turnUsageRef = useRef({ promptTokens: 0, completionTokens: 0 })
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([])

  const appendToSessionRef = useRef<(role: string, content: string) => void>(() => {})
  const onRunningChangeRef = useRef(onRunningChange)
  const onUsageChangeRef = useRef(onUsageChange)
  const apiConfigRef = useRef(apiConfig)
  onRunningChangeRef.current = onRunningChange
  onUsageChangeRef.current = onUsageChange
  apiConfigRef.current = apiConfig

  const toggleToolOutput = useCallback((id: string) => {
    setCollapsedToolIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const turnRef = useRef({
    msgId: '',
    entries: [] as ChronoEntry[],
    streamDone: false
  })

  const isUserScrolledUpRef = useRef(false)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const handleScroll = useCallback(() => {
    const el = chatMessagesRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    isUserScrolledUpRef.current = !atBottom
  }, [])
  useEffect(() => {
    if (isUserScrolledUpRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [displayMessages, agentStatus])

  // Init controller once
  useEffect(() => {
    const ctrl = new Controller({
      registry: toolRegistry, projectPath, apiConfig,
      onEvent: handleEvent,
      onAgentStatus: (s) => setAgentStatus(s),
      onStreamUpdate: () => {}
    })
    controllerRef.current = ctrl
    return () => { ctrl.cancel() }
  }, [])

  useEffect(() => { controllerRef.current?.setProjectPath(projectPath) }, [projectPath])
  useEffect(() => { controllerRef.current?.setApiConfig(apiConfig) }, [apiConfig])

  // Restore UI + controller only when switching sessions (not on every session update)
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSessionIdRef.current
    if (prev === currentSessionId) return
    prevSessionIdRef.current = currentSessionId

    if (!currentSessionId) {
      setDisplayMessages([])
      setPlanSteps([])
      controllerRef.current?.clearSession()
      return
    }

    const session = sessionsRef.current.find((s) => s.id === currentSessionId)
    if (!session) return

    // Skip restore when first message just created this session (UI already set)
    if (prev === null && session.messages.length <= 1) return

    const display: DisplayMessage[] = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        id: uid(),
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: Date.now()
      }))
    setDisplayMessages(display)
    setPlanSteps([])
    controllerRef.current?.restoreSnapshot(session.messages)
  }, [currentSessionId])

  // Refresh display from turnRef
  const refreshDisplay = useCallback(() => {
    const t = turnRef.current
    if (!t.msgId) return
    setDisplayMessages((prev) => prev.map((m) => {
      if (m.id !== t.msgId) return m
      return {
        ...m,
        entries: [...t.entries],
        isStreaming: !t.streamDone
      }
    }))
  }, [])

  // ======== EVENT HANDLER ========
  const handleEvent = useCallback((event: Event) => {
    const t = turnRef.current

    switch (event.kind) {
      case EventKind.Phase:
        if (event.phase === 'plan_start') {
          t.msgId = uid()
          t.entries = []
          t.streamDone = false
          setDisplayMessages((prev) => [...prev, {
            id: t.msgId, role: 'assistant',
            entries: [], isStreaming: true, timestamp: Date.now()
          }])
        } else if (event.phase === 'plan_done') {
          const planText = event.text || t.entries
            .filter((e): e is { kind: 'reasoning' | 'text'; content: string } & ChronoEntry =>
              e.kind === 'reasoning' || e.kind === 'text'
            )
            .map((e) => e.content)
            .join('\n')
          const steps = parsePlanSteps(planText)
          if (steps.length > 0) {
            setPlanSteps(steps)
          }
        } else if (event.phase === 'execute_start') {
          setAgentStatus('🔧 执行中...')
        }
        break

      case EventKind.TurnStarted:
        turnUsageRef.current = { promptTokens: 0, completionTokens: 0 }
        onRunningChangeRef.current?.(true)
        setUsageAccum((prev) => {
          const next = {
            ...prev,
            turns: prev.turns + 1,
            turnTokens: 0,
            turnCacheHitTokens: 0,
            turnCacheMissTokens: 0,
            contextPercent: 0
          }
          onUsageChangeRef.current?.(next)
          return next
        })
        if (!t.msgId) {
          t.msgId = uid()
          t.entries = []
          t.streamDone = false
          setDisplayMessages((prev) => [...prev, {
            id: t.msgId, role: 'assistant',
            entries: [], isStreaming: true, timestamp: Date.now()
          }])
        } else {
          t.streamDone = false
          refreshDisplay()
        }
        break

      case EventKind.Reasoning:
        if (event.text) {
          const last = t.entries[t.entries.length - 1]
          if (last?.kind === 'reasoning') {
            // Append to the last reasoning entry (streaming chunk)
            last.content += event.text
          } else {
            // New reasoning entry (after a tool or text)
            t.entries.push({ kind: 'reasoning', content: event.text })
          }
          refreshDisplay()
        }
        break

      case EventKind.Text:
        if (event.text) {
          const last = t.entries[t.entries.length - 1]
          if (last?.kind === 'text') {
            // Append to the last text entry (streaming chunk)
            last.content += event.text
          } else {
            // New text entry (after a tool or reasoning)
            t.entries.push({ kind: 'text', content: event.text })
          }
          refreshDisplay()
        }
        break

      case EventKind.ToolDispatch:
        if (event.tool && event.tool.name) {
          // Always add new tool entry (breaks reasoning/text stream)
          t.entries.push({
            kind: 'tool',
            id: event.tool.id,
            name: event.tool.name,
            status: 'pending'
          })
          refreshDisplay()
        }
        break

      case EventKind.ToolResult:
        if (event.tool) {
          // Find existing tool entry by id and update it
          for (const entry of t.entries) {
            if (entry.kind === 'tool' && entry.id === event.tool.id) {
              entry.status = event.tool.error ? 'error' : 'done'
              entry.output = event.tool.output || event.tool.error || ''
              entry.durationMs = event.tool.durationMs
              break
            }
          }
          // Detect complete_step results to mark plan steps done
          const output = event.tool.output || ''
          const stepDoneMatch = output.match(/\[STEP_DONE:(\d+)\]/)
          if (stepDoneMatch) {
            const stepIdx = parseInt(stepDoneMatch[1]) - 1
            setPlanSteps((prev) => prev.map((s, i) =>
              i === stepIdx ? { ...s, status: 'completed' as const } : s
            ))
          }
          refreshDisplay()
        }
        break

      case EventKind.Usage:
        if (event.usage) {
          const u = event.usage
          const pT = u.promptTokens || 0
          const cT = u.completionTokens || 0
          const hit = u.cacheHitTokens || 0
          const miss = u.cacheMissTokens || 0
          const stepTokens = u.totalTokens || (pT + cT)
          turnUsageRef.current = {
            promptTokens: turnUsageRef.current.promptTokens + pT,
            completionTokens: turnUsageRef.current.completionTokens + cT
          }
          setUsageAccum((prev) => {
            const next = {
              ...prev,
              sessionTokens: prev.sessionTokens + stepTokens,
              turnTokens: prev.turnTokens + stepTokens,
              cacheHitTokens: prev.cacheHitTokens + hit,
              cacheMissTokens: prev.cacheMissTokens + miss,
              turnCacheHitTokens: prev.turnCacheHitTokens + hit,
              turnCacheMissTokens: prev.turnCacheMissTokens + miss,
              contextPercent: contextPercentFromPrompt(pT, apiConfigRef.current.model),
              cost: prev.cost + estimateCostDelta(pT, cT, hit, miss)
            }
            onUsageChangeRef.current?.(next)
            return next
          })
        }
        break

      case EventKind.TurnDone:
        t.streamDone = true
        setIsLoading(false)
        setAgentStatus('')
        onRunningChangeRef.current?.(false)

        setUsageAccum((prev) => {
          onUsageChangeRef.current?.(prev)
          return prev
        })
        const combinedText = t.entries
          .filter((e): e is { kind: 'text' | 'reasoning'; content: string } & ChronoEntry =>
            e.kind === 'text' || e.kind === 'reasoning'
          )
          .map((e) => e.content)
          .join('\n') || '(完成)'
        setDisplayMessages((prev) => prev.map((m) => {
          if (m.id !== t.msgId) return m
          appendToSessionRef.current('assistant', combinedText)
          return {
            ...m,
            entries: [...t.entries],
            isStreaming: false
          }
        }))
        t.msgId = ''
        break

      case EventKind.Notice:
        if (event.notice && event.notice.level === 'error') {
          appendToSessionRef.current('system', event.notice.text)
        }
        break
    }
  }, [refreshDisplay])

  // Session helpers — delegated to App (single source of truth)
  const appendToSession = useCallback((role: string, content: string) => {
    const sid = currentSessionIdRef.current
    if (sid) {
      onAppendToSession(sid, role, content)
    }
  }, [onAppendToSession])
  appendToSessionRef.current = appendToSession

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading || !toolchainReady) return

    const resolvedKey = ensureApiKey
      ? await ensureApiKey()
      : apiConfig.apiKey.trim()
    if (!resolvedKey) {
      alert('请先配置 API Key（左侧「设置」→ 保存密钥）')
      return
    }
    if (resolvedKey !== apiConfig.apiKey) {
      controllerRef.current?.setApiConfig({ ...apiConfig, apiKey: resolvedKey })
    }

    const userMsg = input.trim()
    setInput('')
    setIsLoading(true)
    setAgentStatus('🤔 思考中...')
    setPlanSteps([])

    if (!currentSessionId) {
      const newId = onNewSession(userMsg)
      currentSessionIdRef.current = newId
      setDisplayMessages([{ id: uid(), role: 'user', content: userMsg, timestamp: Date.now() }])
      controllerRef.current?.clearSession()
    } else {
      setDisplayMessages((prev) => [...prev, { id: uid(), role: 'user', content: userMsg, timestamp: Date.now() }])
      appendToSession('user', userMsg)
    }

    const ctrl = controllerRef.current
    if (!ctrl) return
    try { await ctrl.send(userMsg) }
    catch { setIsLoading(false); setAgentStatus('') }
  }, [input, isLoading, toolchainReady, apiConfig, ensureApiKey, currentSessionId, appendToSession, onNewSession])

  const handleCancel = useCallback(() => {
    controllerRef.current?.cancel()
    setIsLoading(false)
    setAgentStatus('')
    onRunningChangeRef.current?.(false)
  }, [])

  // ======== RENDER ========
  const renderContent = (content: string) => {
    if (!content) return null
    const parts = content.split(/(```[\s\S]*?```)/g)
    return parts.map((part, i) => {
      if (part.startsWith('```')) {
        const m = part.match(/```(\w*)\n([\s\S]*?)```/)
        if (m) return (
          <div key={i} className="code-block-wrapper">
            <div className="code-block-header"><span>{m[1] || '代码'}</span></div>
            <pre className="code-block"><code>{m[2]}</code></pre>
          </div>
        )
      }
      return <span key={i} style={{ whiteSpace: 'pre-wrap' }}>{part}</span>
    })
  }

  const renderMessage = (msg: DisplayMessage) => (
    <div key={msg.id} className={`chat-message ${msg.role}`}>
      <div className="role">
        {msg.role === 'user' ? '👤 你' : '🤖 AI'}
        {msg.isStreaming && <span className="streaming-dot">●</span>}
      </div>
      <div className="message-content">
        {/* User messages: show content as-is */}
        {msg.role === 'user' && (
          <div style={{ minHeight: '1em' }}>{renderContent(msg.content)}</div>
        )}

        {/* Assistant messages: render entries in chronological order */}
        {msg.role === 'assistant' && (
          <div>
            {msg.entries && msg.entries.length === 0 && msg.isStreaming && (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '12px' }}>思考中...</span>
            )}
            {msg.entries && msg.entries.length > 0 && msg.entries.map((entry, i) => {
              switch (entry.kind) {
                case 'reasoning':
                  return (
                    <div key={`r-${i}`} style={{
                      fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic',
                      padding: '2px 0', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                    }}>
                      💭 {entry.content}
                    </div>
                  )
                case 'text':
                  return (
                    <div key={`t-${i}`} style={{ padding: '2px 0' }}>
                      {renderContent(entry.content)}
                    </div>
                  )
                case 'tool': {
                  const isCollapsed = collapsedToolIds.has(entry.id)
                  return (
                    <div key={`tool-${entry.id}`} style={{
                      padding: '3px 0', borderBottom: '1px solid var(--border-color)',
                      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px', fontSize: '12px'
                    }}>
                      <span style={{ flexShrink: 0 }}>
                        {entry.status === 'pending' && '⏳'}
                        {entry.status === 'running' && '🔄'}
                        {entry.status === 'done' && '✅'}
                        {entry.status === 'error' && '❌'}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{getToolDisplayName(entry.name)}</span>
                      {entry.durationMs && <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>({entry.durationMs}ms)</span>}

                      {/* Preview / expand toggle for completed tools */}
                      {(entry.status === 'done' || entry.status === 'error') && entry.output && (
                        isCollapsed ? (
                          <span onClick={() => toggleToolOutput(entry.id)}
                            style={{ fontSize: '10px', color: 'var(--accent)', cursor: 'pointer', marginLeft: 'auto', flexShrink: 0 }}>
                            {extractPreview(entry.name, entry.output)} ▶
                          </span>
                        ) : (
                          <span onClick={() => toggleToolOutput(entry.id)}
                            style={{ fontSize: '10px', color: 'var(--accent)', cursor: 'pointer', marginLeft: 'auto', flexShrink: 0 }}>
                            收起 ▲
                          </span>
                        )
                      )}

                      {/* Pending/running status */}
                      {(entry.status === 'pending' || entry.status === 'running') && (
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0 }}>
                          {entry.status === 'running' ? '执行中...' : '等待中...'}
                        </span>
                      )}

                      {/* Full output when expanded */}
                      {entry.output && !isCollapsed && (
                        <div style={{ width: '100%', marginTop: '2px' }}>
                          <pre style={{
                            margin: 0, padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)',
                            background: entry.status === 'error' ? 'rgba(243,139,168,0.1)' : 'var(--bg-tertiary)',
                            borderRadius: '4px', maxHeight: '200px', overflow: 'auto',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.5,
                            color: entry.status === 'error' ? 'var(--error)' : undefined
                          }}>{entry.output}</pre>
                        </div>
                      )}
                    </div>
                  )
                }
                default:
                  return null
              }
            })}
            {/* Fallback for restored sessions (messages with content but no entries) */}
            {(!msg.entries || msg.entries.length === 0) && msg.content && (
              <div>{renderContent(msg.content)}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🤖 AI 智能体</span>
          <div style={{ display: 'flex', gap: '4px' }}>
          </div>
        </div>
        {agentStatus && <div style={{ fontSize: '12px', color: 'var(--accent)', marginTop: '4px' }}>{agentStatus}</div>}
      </div>
      {planSteps.length > 0 && (
        <TaskPlan steps={planSteps} />
      )}
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleScroll}>
        {displayMessages.length === 0 && (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0', fontSize: '13px' }}>
            {projectPath ? '描述你想开发的功能，AI 会自动规划并执行' : '请先打开或新建一个项目'}
          </div>
        )}
        {displayMessages.map(renderMessage)}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        {!toolchainReady && (
          <div className="chat-toolchain-lock-banner">
            构建环境初始化中，AI 开发与构建功能暂时锁定，请等待进度条完成。
          </div>
        )}
        <textarea className="chat-input"
          placeholder={!toolchainReady ? '等待构建环境就绪…' : projectPath ? '描述功能或问题...' : '请先打开项目'}
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          disabled={!projectPath || isLoading || !toolchainReady} />
        {isLoading ? (
          <button className="chat-send-btn" style={{ background: 'var(--error)', color: 'white' }} onClick={handleCancel}>⏹ 停止</button>
        ) : (
          <button className="chat-send-btn" onClick={handleSend} disabled={!projectPath || !input.trim() || !toolchainReady}>发送</button>
        )}
      </div>
    </div>
  )
}

// Extract a preview summary from tool output (for collapsed view)
function extractPreview(toolName: string, output: string): string {
  if (toolName === 'list_directory') {
    const lines = output.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return '(空)'
    const first = lines[0].replace(/^[📁📄]\s*/, '').trim()
    if (lines.length <= 3) return output.replace(/[📁📄]\s*/g, '').split('\n').join(', ')
    return `${first} 等 ${lines.length} 项`
  }
  // read_file: show first line
  const firstLine = output.split('\n')[0]?.trim() || ''
  return firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '')
}

export default ChatPanel
