import React, { useState, useRef, useEffect, useCallback } from 'react'
import appIcon from '../../../../build/appIcon.png'
import installerIcon from '../../../../build/installerIcon.png'
import { IconSend, IconSquare } from './Icon'
import { Controller } from '../harness/controller'
import { Registry } from '../harness/tools'
import { registerModCraftingTools } from '../harness/tool-definitions'
import { EventKind } from '../harness/events'
import type { Event } from '../harness/events'
import TaskPlan from './TaskPlan'
import type { PlanStep } from './TaskPlan'
import { parsePlanSteps } from '../utils/plan-steps'
import { EMPTY_USAGE, estimateCostDelta, contextPercentFromPrompt, type UsageStats } from '../utils/usage'
import type { ChatSession, PersistedMessage } from '../types/chat'
import {
  serializeDisplayMessages,
  deserializeToDisplay,
  restoreActivePlan,
  buildRestoredCollapseState,
  toControllerMessages
} from '../utils/chat-persist'
import { groupMessagesIntoTurns } from '../utils/chat-turns'
import type { ChatTurn } from '../utils/chat-turns'
import type { DisplayMessage, ChronoEntry } from '../types/display-message'
import MessageFooter from './MessageFooter'

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
  sessions: ChatSession[]
  onPersistSession: (sessionId: string, messages: PersistedMessage[]) => void
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

interface ActivePlan {
  steps: PlanStep[]
  anchorMsgId: string
  pinned: boolean
}

function generateMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `msg-${crypto.randomUUID()}`
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function uid(): string {
  return generateMessageId()
}

// 工具中文名映射
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read_file: '读取文件',
  write_file: '写入文件',
  list_directory: '列出目录',
  run_command: '运行命令',
  trigger_build: '触发构建',
  create_recipe: '创建配方',
  read_error_log: '读取错误日志',
  complete_step: '完成任务步骤'
}
function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name
}

function toPlanSteps(steps: Array<{ id: string; description: string; status: string }>): PlanStep[] {
  return steps.map((s) => ({
    id: s.id,
    description: s.description,
    status: (s.status === 'completed' || s.status === 'running' || s.status === 'error'
      ? s.status
      : 'pending') as PlanStep['status']
  }))
}

const NUMBERED_LINE_RE = /^\s*\d+[.\、\s]+/

function isNumberedPlanText(content: string): boolean {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  const numbered = lines.filter((l) => NUMBERED_LINE_RE.test(l))
  return numbered.length >= 2 || (numbered.length === 1 && lines.length === 1)
}

function replacePlanEntriesWithSummary(entries: ChronoEntry[], stepCount: number): ChronoEntry[] {
  const kept = entries.filter((e) => e.kind !== 'text' || !isNumberedPlanText(e.content))
  return [...kept, { kind: 'text', content: `已制定实施计划（${stepCount} 步），进度见上方。` }]
}

function finalizeRunningTools(entries: ChronoEntry[], hasError: boolean): ChronoEntry[] {
  return entries.map((e) => {
    if (e.kind === 'tool' && e.status === 'running') {
      return { ...e, status: hasError ? 'error' as const : 'done' as const }
    }
    return e
  })
}

function resolveTurnStatus(error?: string): DisplayMessage['turnStatus'] {
  if (!error) return 'completed'
  if (/cancel/i.test(error)) return 'cancelled'
  return 'error'
}

const ChatPanel: React.FC<ChatPanelProps> = ({ projectPath, contextFiles, setContextFiles, selectedFile, apiConfig, ensureApiKey, onUsageChange, onRunningChange, currentSessionId, sessions, onPersistSession, onNewSession, onRenameSession, toolchainReady = true }) => {
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
  const [collapsedReasoningKeys, setCollapsedReasoningKeys] = useState<Set<string>>(new Set())
  const [runTick, setRunTick] = useState(0)
  const toolOutputRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [usageAccum, setUsageAccum] = useState<UsageStats>(EMPTY_USAGE)
  const turnUsageRef = useRef({ promptTokens: 0, completionTokens: 0 })
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const activePlanRef = useRef<ActivePlan | null>(null)
  activePlanRef.current = activePlan
  const [completionFlash, setCompletionFlash] = useState('')
  const completionFlashTimerRef = useRef<number | null>(null)
  const displayMessagesRef = useRef<DisplayMessage[]>([])
  displayMessagesRef.current = displayMessages

  const onPersistSessionRef = useRef(onPersistSession)
  onPersistSessionRef.current = onPersistSession

  const flushPersist = useCallback((
    messages: DisplayMessage[],
    plan: ActivePlan | null,
    options?: { appendSystem?: PersistedMessage[] }
  ) => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    const serialized = serializeDisplayMessages(messages, plan)
    const session = sessionsRef.current.find((s) => s.id === sid)
    let systemMsgs = session?.messages.filter((m) => m.role === 'system') ?? []
    if (options?.appendSystem?.length) {
      systemMsgs = [...systemMsgs, ...options.appendSystem]
    }
    onPersistSessionRef.current(sid, [...serialized, ...systemMsgs])
  }, [])

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

  const toggleReasoning = useCallback((key: string) => {
    setCollapsedReasoningKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const collapseAllReasoning = useCallback((msgId: string, entries: ChronoEntry[]) => {
    const keys: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.kind === 'reasoning') {
        e.done = true
        keys.push(`${msgId}-${i}`)
      }
    }
    if (keys.length === 0) return
    setCollapsedReasoningKeys((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.add(k))
      return next
    })
  }, [])

  const markLastReasoningDone = useCallback((msgId: string, entries: ChronoEntry[]) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'reasoning' && !e.done) {
        e.done = true
        setCollapsedReasoningKeys((prev) => new Set(prev).add(`${msgId}-${i}`))
        break
      }
      if (e.kind !== 'reasoning') break
    }
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
  }, [displayMessages, agentStatus, runTick, activePlan, completionFlash])

  useEffect(() => {
    if (!isLoading) return
    const id = window.setInterval(() => setRunTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [isLoading])

  useEffect(() => {
    return () => {
      if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
    }
  }, [])

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

  // Restore UI + controller when switching sessions; wait until session payload is available
  const restoredSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!currentSessionId) {
      restoredSessionIdRef.current = null
      setDisplayMessages([])
      setActivePlan(null)
      setCollapsedToolIds(new Set())
      setCollapsedReasoningKeys(new Set())
      turnRef.current = { msgId: '', entries: [], streamDone: false }
      controllerRef.current?.clearSession()
      return
    }

    if (restoredSessionIdRef.current === currentSessionId) return

    const session = sessionsRef.current.find((s) => s.id === currentSessionId)
    if (!session) return

    restoredSessionIdRef.current = currentSessionId
    turnRef.current = { msgId: '', entries: [], streamDone: false }
    const display = deserializeToDisplay(session.messages, uid) as DisplayMessage[]
    const restoredPlan = restoreActivePlan(display, session.messages)
    const { toolIds, reasoningKeys } = buildRestoredCollapseState(display)
    setCollapsedToolIds(toolIds)
    setCollapsedReasoningKeys(reasoningKeys)
    setDisplayMessages(display)
    setActivePlan(restoredPlan)
    controllerRef.current?.restoreSnapshot(toControllerMessages(session.messages))
  }, [currentSessionId, sessions])

  useEffect(() => {
    return () => {
      flushPersist(displayMessagesRef.current, activePlanRef.current)
    }
  }, [flushPersist])

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
          if (steps.length > 0 && t.msgId) {
            const planStepList = toPlanSteps(steps.map((s) => ({ ...s, status: 'pending' })))
            const nextPlan = { steps: planStepList, anchorMsgId: t.msgId, pinned: true }
            t.entries = replacePlanEntriesWithSummary(t.entries, steps.length)
            setActivePlan(nextPlan)
            setDisplayMessages((prev) => {
              const next = prev.map((m) => (
                m.id === t.msgId ? { ...m, entries: [...t.entries] } : m
              ))
              flushPersist(next, nextPlan)
              return next
            })
          }
        } else if (event.phase === 'plan_stream_end') {
          if (t.msgId) collapseAllReasoning(t.msgId, t.entries)
          refreshDisplay()
        } else if (event.phase === 'execute_start') {
          setAgentStatus('执行中...')
        }
        break

      case EventKind.PlanState:
        if (event.planSteps && event.planSteps.length > 0) {
          const nextSteps = toPlanSteps(event.planSteps)
          const nextPlan = activePlanRef.current
            ? { ...activePlanRef.current, steps: nextSteps }
            : t.msgId
              ? { steps: nextSteps, anchorMsgId: t.msgId, pinned: true }
              : null
          if (nextPlan) {
            setActivePlan(nextPlan)
            flushPersist(displayMessagesRef.current, nextPlan)
          }
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
            turnCacheMissTokens: 0
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
          markLastReasoningDone(t.msgId, t.entries)
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
          markLastReasoningDone(t.msgId, t.entries)
          setCollapsedToolIds((prev) => {
            const next = new Set(prev)
            next.delete(event.tool!.id)
            return next
          })
          t.entries.push({
            kind: 'tool',
            id: event.tool.id,
            name: event.tool.name,
            status: 'running',
            startMs: Date.now()
          })
          refreshDisplay()
        }
        break

      case EventKind.ToolProgress:
        if (event.tool?.id && event.tool.output) {
          for (const entry of t.entries) {
            if (entry.kind === 'tool' && entry.id === event.tool.id) {
              entry.status = 'running'
              entry.liveOutput = (entry.liveOutput || '') + event.tool.output
              break
            }
          }
          refreshDisplay()
          const outEl = toolOutputRefs.current.get(event.tool.id)
          if (outEl) outEl.scrollTop = outEl.scrollHeight
        }
        break

      case EventKind.ToolResult:
        if (event.tool) {
          setCollapsedToolIds((prev) => new Set(prev).add(event.tool!.id))
          // Find existing tool entry by id and update it
          for (const entry of t.entries) {
            if (entry.kind === 'tool' && entry.id === event.tool.id) {
              entry.status = event.tool.error ? 'error' : 'done'
              entry.output = event.tool.output || event.tool.error || entry.liveOutput || ''
              entry.liveOutput = undefined
              entry.durationMs = event.tool.durationMs
              break
            }
          }
          // Detect complete_step results to mark plan steps done
          const output = event.tool.output || ''
          const stepDoneMatch = output.match(/\[STEP_DONE:(\d+)\]/)
          if (stepDoneMatch) {
            const stepIdx = parseInt(stepDoneMatch[1]) - 1
            setActivePlan((prev) => {
              const next = prev
                ? {
                    ...prev,
                    steps: prev.steps.map((s, i) =>
                      i === stepIdx ? { ...s, status: 'completed' as const } : s
                    )
                  }
                : prev
              if (next) flushPersist(displayMessagesRef.current, next)
              return next
            })
          }
          if (t.msgId) {
            setDisplayMessages((prev) => {
              const next = prev.map((m) => (
                m.id === t.msgId ? { ...m, entries: [...t.entries], isStreaming: !t.streamDone } : m
              ))
              flushPersist(next, activePlanRef.current)
              return next
            })
          } else {
            refreshDisplay()
          }
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
            const promptTotal = turnUsageRef.current.promptTokens
            const next = {
              ...prev,
              sessionTokens: prev.sessionTokens + stepTokens,
              turnTokens: prev.turnTokens + stepTokens,
              cacheHitTokens: prev.cacheHitTokens + hit,
              cacheMissTokens: prev.cacheMissTokens + miss,
              turnCacheHitTokens: prev.turnCacheHitTokens + hit,
              turnCacheMissTokens: prev.turnCacheMissTokens + miss,
              lastPromptTokens: promptTotal,
              contextPercent: contextPercentFromPrompt(promptTotal, apiConfigRef.current.model),
              cost: prev.cost + estimateCostDelta(pT, cT, hit, miss)
            }
            onUsageChangeRef.current?.(next)
            return next
          })
        }
        break

      case EventKind.TurnDone: {
        t.streamDone = true
        if (t.msgId) collapseAllReasoning(t.msgId, t.entries)
        const hasError = Boolean(event.error)
        t.entries = finalizeRunningTools(t.entries, hasError)
        const planSnapshot = activePlanRef.current

        const finalSteps = planSnapshot
          ? planSnapshot.steps.map((s) => ({
              ...s,
              status: hasError && s.status === 'running'
                ? 'error' as const
                : s.status
            }))
          : undefined
        const finalPlanDone = finalSteps ? finalSteps.every((s) => s.status === 'completed') : true
        const turnStatus: DisplayMessage['turnStatus'] = hasError
          ? resolveTurnStatus(event.error)
          : finalPlanDone
            ? 'completed'
            : 'partial'

        setIsLoading(false)
        setAgentStatus('')
        onRunningChangeRef.current?.(false)

        if (!hasError && finalPlanDone) {
          setCompletionFlash('任务已完成')
          if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
          completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
        } else if (!hasError && !finalPlanDone) {
          setCompletionFlash('任务部分完成')
          if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
          completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
        }

        setUsageAccum((prev) => {
          onUsageChangeRef.current?.(prev)
          return prev
        })

        const anchorId = planSnapshot?.anchorMsgId || t.msgId

        setDisplayMessages((prev) => {
          const next = prev.map((m) => {
            if (m.isStreaming || m.id === anchorId || m.id === t.msgId) {
              const isAnchor = m.id === anchorId || m.id === t.msgId
              return {
                ...m,
                ...(isAnchor ? { entries: [...t.entries] } : {}),
                isStreaming: false,
                ...(isAnchor ? {
                  turnStatus,
                  embeddedPlan: finalSteps && finalSteps.length > 0 ? finalSteps : m.embeddedPlan
                } : {})
              }
            }
            return m
          })
          flushPersist(next, null)
          return next
        })

        setActivePlan(null)
        t.msgId = ''
        break
      }

      case EventKind.Notice:
        if (event.notice) {
          if (event.notice.level === 'error') {
            flushPersist(displayMessagesRef.current, activePlanRef.current, {
              appendSystem: [{ role: 'system', content: event.notice.text, timestamp: Date.now() }]
            })
          } else if (event.notice.level === 'warn') {
            setAgentStatus(event.notice.text)
          }
        }
        break
    }
  }, [refreshDisplay, collapseAllReasoning, markLastReasoningDone, flushPersist])

  // Session helpers — delegated to App (single source of truth)
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
    setAgentStatus('思考中...')
    setActivePlan(null)
    setCompletionFlash('')

    if (!currentSessionId) {
      const newId = onNewSession(userMsg)
      currentSessionIdRef.current = newId
      setDisplayMessages([{ id: uid(), role: 'user', content: userMsg, timestamp: Date.now() }])
      controllerRef.current?.clearSession()
    } else {
      setDisplayMessages((prev) => {
        const next = [...prev, { id: uid(), role: 'user' as const, content: userMsg, timestamp: Date.now() }]
        flushPersist(next, null)
        return next
      })
    }

    const ctrl = controllerRef.current
    if (!ctrl) return
    try { await ctrl.send(userMsg) }
    catch {
      setIsLoading(false)
      setAgentStatus('')
      onRunningChangeRef.current?.(false)
    }
  }, [input, isLoading, toolchainReady, apiConfig, ensureApiKey, currentSessionId, flushPersist, onNewSession])

  const handleCancel = useCallback(() => {
    controllerRef.current?.cancel()
    const t = turnRef.current
    t.streamDone = true
    t.entries = finalizeRunningTools(t.entries, true)
    const planSnapshot = activePlanRef.current

    setIsLoading(false)
    setAgentStatus('')
    onRunningChangeRef.current?.(false)

    const anchorId = planSnapshot?.anchorMsgId || t.msgId
    const finalSteps = planSnapshot?.steps

    setDisplayMessages((prev) => {
      const next = prev.map((m) => {
        if (m.isStreaming || m.id === anchorId || m.id === t.msgId) {
          const isAnchor = m.id === anchorId || m.id === t.msgId
          return {
            ...m,
            ...(isAnchor && t.msgId ? { entries: [...t.entries] } : {}),
            isStreaming: false,
            ...(isAnchor ? {
              turnStatus: 'cancelled' as const,
              embeddedPlan: finalSteps && finalSteps.length > 0 ? finalSteps : m.embeddedPlan
            } : {})
          }
        }
        return m
      })
      flushPersist(next, null)
      return next
    })

    setActivePlan(null)
    t.msgId = ''
  }, [flushPersist])

  const handleRetryTurn = useCallback(async (turnId: string) => {
    if (isLoading) return

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

    const turnIndex = displayMessages.findIndex((m) => m.id === turnId)
    if (turnIndex < 0) return

    const truncated = displayMessages.slice(0, turnIndex + 1)

    setIsLoading(true)
    setAgentStatus('思考中...')
    setActivePlan(null)
    setCompletionFlash('')
    turnRef.current = { msgId: '', entries: [], streamDone: false }

    setDisplayMessages(truncated)
    flushPersist(truncated, null)

    const sid = currentSessionIdRef.current
    const session = sid ? sessionsRef.current.find((s) => s.id === sid) : undefined
    const systemMsgs = session?.messages.filter((m) => m.role === 'system') ?? []
    const serialized = serializeDisplayMessages(truncated, null)
    controllerRef.current?.restoreSnapshot(
      toControllerMessages([...serialized, ...systemMsgs])
    )

    const ctrl = controllerRef.current
    if (!ctrl) return
    try { await ctrl.retryFromUser() }
    catch {
      setIsLoading(false)
      setAgentStatus('')
      onRunningChangeRef.current?.(false)
    }
  }, [isLoading, apiConfig, ensureApiKey, displayMessages, flushPersist])

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

  const renderMessage = (msg: DisplayMessage, turn: ChatTurn) => {
    const isUser = msg.role === 'user'
    const suppressPlanText = Boolean(
      msg.embeddedPlan?.length
      || (activePlan?.pinned && activePlan.anchorMsgId === msg.id)
    )
    return (
      <div className={`bubble ${isUser ? 'user' : 'ai'}${msg.turnStatus === 'completed' ? ' bubble--done' : ''}`}>
        <div className="bubble-hd">
          {isUser ? (
            <>
              <span className="bubble-av">你</span>
              <span className="role mc-dim">用户</span>
            </>
          ) : (
            <>
              <img src={installerIcon} alt="" />
              <span className="role">AI 助手</span>
              {msg.turnStatus === 'completed' && <span className="turn-badge turn-badge--done">已完成</span>}
              {msg.turnStatus === 'partial' && <span className="turn-badge turn-badge--partial">部分完成</span>}
              {msg.turnStatus === 'error' && <span className="turn-badge turn-badge--error">已中断</span>}
              {msg.turnStatus === 'cancelled' && <span className="turn-badge turn-badge--cancelled">已取消</span>}
              {msg.isStreaming && !msg.turnStatus && <span className="streaming-dot">●</span>}
            </>
          )}
        </div>
        <div className="bubble-bd">
          {isUser && (
            <div>{renderContent(msg.content)}</div>
          )}
          {!isUser && (
            <>
              {msg.embeddedPlan && msg.embeddedPlan.length > 0 && (
                <TaskPlan steps={msg.embeddedPlan} variant="anchored" defaultCollapsed />
              )}
              {msg.entries && msg.entries.length === 0 && msg.isStreaming && (
                <span className="mc-dim" style={{ fontSize: '12px', fontStyle: 'italic' }}>思考中...</span>
              )}
              {msg.entries && msg.entries.length > 0 && msg.entries.map((entry, i) => {
                switch (entry.kind) {
                  case 'reasoning': {
                    const rKey = `${msg.id}-${i}`
                    const isCollapsed = collapsedReasoningKeys.has(rKey)
                    const isActiveStream = Boolean(
                      msg.isStreaming && !entry.done && i === msg.entries!.length - 1
                    )
                    const showExpanded = isActiveStream || !isCollapsed
                    const preview = entry.content.trim().replace(/\s+/g, ' ').slice(0, 80)
                    return (
                      <div key={`r-${i}`} className="reasoning-block">
                        <button
                          type="button"
                          className="reasoning-block-hd"
                          onClick={() => { if (!isActiveStream) toggleReasoning(rKey) }}
                          disabled={isActiveStream}
                        >
                          <span className="reasoning-block-icon">{showExpanded ? '▾' : '▸'}</span>
                          <span>{isActiveStream ? '思考中…' : '思考过程'}</span>
                          {!showExpanded && preview && (
                            <span className="reasoning-preview">{preview}{entry.content.length > 80 ? '…' : ''}</span>
                          )}
                        </button>
                        {showExpanded && (
                          <div className="reasoning-block-bd reasoning-line">{entry.content}</div>
                        )}
                      </div>
                    )
                  }
                  case 'text':
                    if (suppressPlanText && isNumberedPlanText(entry.content)) return null
                    return <div key={`t-${i}`}>{renderContent(entry.content)}</div>
                  case 'tool': {
                    const isCollapsed = collapsedToolIds.has(entry.id)
                    const displayOutput = entry.liveOutput || entry.output
                    const elapsedSec = entry.startMs && entry.status === 'running'
                      ? Math.max(1, Math.floor((Date.now() - entry.startMs) / 1000))
                      : null
                    const statusMark =
                      entry.status === 'done' ? <span className="ok">✓</span>
                        : entry.status === 'running' ? <span className="run">⟳</span>
                          : entry.status === 'error' ? <span className="err">✗</span>
                            : <span className="mc-dim">·</span>
                    return (
                      <div
                        key={`tool-${entry.id}`}
                        className={`tool-line${entry.status === 'running' ? ' running' : ''}`}
                      >
                        {statusMark}
                        <span className="tool-line-name">{getToolDisplayName(entry.name)}</span>
                        {entry.durationMs != null && (
                          <span className="mc-dim" style={{ fontSize: '10px' }}>
                            ({entry.durationMs >= 1000
                              ? `${(entry.durationMs / 1000).toFixed(1)}s`
                              : `${entry.durationMs}ms`})
                          </span>
                        )}
                        {elapsedSec != null && (
                          <span className="mc-dim" style={{ fontSize: '10px' }}>({elapsedSec}s)</span>
                        )}
                        {(entry.status === 'done' || entry.status === 'error') && displayOutput && (
                          <>
                            {isCollapsed && (
                              <span className="tool-line-preview" title={displayOutput}>
                                {extractPreview(entry.name, displayOutput)}
                              </span>
                            )}
                            <span
                              className="tool-line-toggle"
                              onClick={() => toggleToolOutput(entry.id)}
                            >
                              {isCollapsed ? '展开 ▶' : '收起 ▲'}
                            </span>
                          </>
                        )}
                        {entry.status === 'running' && (
                          <span
                            className="tool-line-toggle mc-dim"
                            onClick={() => toggleToolOutput(entry.id)}
                          >
                            {isCollapsed ? '展开日志 ▶' : '收起 ▲'}
                          </span>
                        )}
                        {entry.status === 'pending' && (
                          <span className="tool-line-toggle mc-dim">等待中…</span>
                        )}
                        {displayOutput && !isCollapsed && (
                          <div
                            className="tool-line-output"
                            ref={(el) => {
                              if (el) toolOutputRefs.current.set(entry.id, el)
                              else toolOutputRefs.current.delete(entry.id)
                            }}
                          >
                            <pre className={entry.status === 'error' ? 'is-error' : undefined}>
                              {displayOutput}
                            </pre>
                          </div>
                        )}
                      </div>
                    )
                  }
                  default:
                    return null
                }
              })}
              {(!msg.entries || msg.entries.length === 0) && msg.content && (
                <div>{renderContent(msg.content)}</div>
              )}
            </>
          )}
        </div>
        <MessageFooter
          role={isUser ? 'user' : 'assistant'}
          message={msg}
          turn={turn}
          isLoading={isLoading}
          onRetry={handleRetryTurn}
        />
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-left">
          <img src={appIcon} alt="" className="chat-brand-icon" />
          <span className="chat-header-brand">AI 智能体</span>
        </div>
        {completionFlash ? (
          <span className="chat-header-status chat-header-status--done">{completionFlash}</span>
        ) : agentStatus ? (
          <span className="chat-header-status">{agentStatus}</span>
        ) : null}
      </div>
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleScroll}>
        {activePlan?.pinned && (
          <div className="chat-plan-sticky">
            <TaskPlan steps={activePlan.steps} variant="pinned" />
          </div>
        )}
        {displayMessages.length === 0 && !activePlan?.pinned && (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '24px 0', fontSize: '13px' }}>
            {projectPath ? '描述你想开发的功能，AI 会自动规划并执行' : '请先打开或新建一个项目'}
          </div>
        )}
        {groupMessagesIntoTurns(displayMessages).map((turn) => (
          <div key={turn.id} className="chat-turn">
            {turn.user && renderMessage(turn.user, turn)}
            {turn.assistant && renderMessage(turn.assistant, turn)}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-area">
        {!toolchainReady && (
          <div className="chat-toolchain-lock-banner">
            构建环境初始化中，AI 开发与构建功能暂时锁定，请等待进度条完成。
          </div>
        )}
        <div className="chat-input-composite">
          <textarea
            className="chat-input-composite__field"
            placeholder={!toolchainReady ? '等待构建环境就绪…' : projectPath ? '描述功能或问题...' : '请先打开项目'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            disabled={!projectPath || isLoading || !toolchainReady}
          />
          <div className="chat-input-composite__actions">
            {isLoading ? (
              <button type="button" className="mc-btn mc-btn--red chat-send-btn" onClick={handleCancel}>
                <IconSquare size="sm" /> 停止
              </button>
            ) : (
              <button type="button" className="mc-btn mc-btn--primary chat-send-btn" onClick={handleSend} disabled={!projectPath || !input.trim() || !toolchainReady}>
                <IconSend size="sm" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Extract a preview summary from tool output (for collapsed view)
function extractPreview(toolName: string, output: string): string {
  const cap = (text: string, max = 48): string =>
    text.length > max ? `${text.slice(0, max)}…` : text

  if (toolName === 'list_directory') {
    const lines = output.split('\n').filter((l) => l.trim())
    if (lines.length === 0) return '(空)'
    const first = lines[0].trim()
    if (lines.length === 1) return cap(first)
    return cap(`${first} 等 ${lines.length} 项`)
  }
  if (toolName === 'run_command' || toolName === 'trigger_build') {
    if (output.includes('BUILD SUCCESSFUL')) return 'BUILD SUCCESSFUL'
    if (output.includes('BUILD FAILED')) return 'BUILD FAILED'
    const exitMatch = output.match(/\[exit code: (\d+)\]|\[退出码: (\d+)\]/)
    const exitCode = exitMatch?.[1] ?? exitMatch?.[2]
    const lines = output.split('\n').filter((l) => l.trim())
    const last = lines[lines.length - 1]?.trim() || ''
    if (last && last.length <= 60) {
      return exitCode && exitCode !== '0' ? `${last} (exit ${exitCode})` : last
    }
    return exitCode ? `exit ${exitCode}` : last.slice(0, 60) || '(完成)'
  }
  const firstLine = output.split('\n')[0]?.trim() || ''
  return cap(firstLine)
}

export default ChatPanel
