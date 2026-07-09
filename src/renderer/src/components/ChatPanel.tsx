import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import appIcon from '../../../../build/appIcon.png'
import installerIcon from '../../../../build/installerIcon.png'
import { Controller } from '../harness/controller'
import { Registry } from '../harness/tools'
import { registerModCraftingTools } from '../harness/tool-definitions'
import { EventKind } from '../harness/events'
import type { Event } from '../harness/events'
import TaskPlan from './TaskPlan'
import type { PlanStep } from './TaskPlan'
import { parsePlanSteps, isActionablePlanText } from '../utils/plan-steps'
import { resolveTurnDoneStatus } from '../utils/turn-status'
import { EMPTY_USAGE, estimateCostDelta, contextPercentFromPrompt, normalizeSessionUsage, type UsageStats } from '../utils/usage'
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
import ChatComposer from './ChatComposer'
import type { ComposerMode } from '../harness/turn-intent'
import MarkdownContent from './MarkdownContent'
import MessageFooter from './MessageFooter'
import { recordToolDispatch, recordToolResult } from '../utils/tool-activity'
import TemplateFormPanel from './TemplateFormPanel'
import RollbackWarningPanel from './RollbackWarningPanel'

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
  onUpdateSessionMeta?: (sessionId: string, meta: { composerMode?: ComposerMode; sessionGoal?: string }) => void
  onTemplateSelect?: (templateId: string, name: string) => void
}

const toolRegistry = new Registry()
registerModCraftingTools(toolRegistry)

async function reloadAgentToolRegistry(controller: Controller | null): Promise<Registry> {
  const registry = new Registry()
  let disabled: string[] = []
  try {
    const cfg = await window.api.loadAgentConfig()
    disabled = cfg.disabledTools || []
  } catch {
    // ignore
  }
  registerModCraftingTools(registry, { disabledTools: disabled })
  controller?.setRegistry(registry)
  return registry
}

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
  complete_step: '完成步骤',
  fabric_docs_search: '搜索文档',
  fabric_javadoc_lookup: '查询 JavaDoc',
  vanilla_mc_wiki_query: '查询 Wiki',
  fabric_meta_version_check: '检查版本',
  fabric_mod_json_validate: '验证 mod.json',
  fabric_recipe_generate: '生成配方',
  fabric_content_register: '注册内容',
  fabric_data_assets_generate: '生成资源',
  fabric_mixin_scaffold: '生成 Mixin',
  fabric_log_debugger: '分析日志',
  explain_code: '代码解释',
  list_templates: '列出模板',
  fabric_template_generate: '生成模板',
  ask_clarification: '向用户提问'
}

function getToolDisplayName(name: string, args?: Record<string, unknown>): string {
  if (name === 'trigger_build' && args) {
    const task = String(args.task || '')
    if (task === 'runClient') return '游戏测试'
    if (task === 'build') return '构建编译'
    if (task === 'runServer') return '启动服务端'
    if (task === 'runDatagen') return '数据生成'
    if (task === 'test') return '运行测试'
    return '触发构建'
  }
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

interface ChatPanelRef {
  handleTemplateSelect: (templateId: string, name: string) => void
}

const ChatPanel = forwardRef<ChatPanelRef, ChatPanelProps>(function ChatPanel({ projectPath, contextFiles, setContextFiles, selectedFile, apiConfig, ensureApiKey, onUsageChange, onRunningChange, currentSessionId, sessions, onPersistSession, onNewSession, onRenameSession, toolchainReady = true, onUpdateSessionMeta }, ref) {
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [composerMode, setComposerMode] = useState<ComposerMode>('agent')
  const composerModeRef = useRef<ComposerMode>('agent')
  composerModeRef.current = composerMode
  const [sessionGoal, setSessionGoal] = useState('')
  const [planReady, setPlanReady] = useState(false)
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
  const reasoningScrollRef = useRef<HTMLDivElement | null>(null)
  const [usageAccum, setUsageAccum] = useState<UsageStats>(EMPTY_USAGE)
  const turnUsageRef = useRef({ promptTokens: 0, completionTokens: 0 })
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const activePlanRef = useRef<ActivePlan | null>(null)
  activePlanRef.current = activePlan
  const [completionFlash, setCompletionFlash] = useState('')
  const completionFlashTimerRef = useRef<number | null>(null)
  const [clarificationPending, setClarificationPending] = useState(false)
  const [clarificationQuestion, setClarificationQuestion] = useState('')
  const [clarificationOptions, setClarificationOptions] = useState<string[]>([])
  const [clarificationOtherInput, setClarificationOtherInput] = useState('')
  const [clarificationSelectedIndex, setClarificationSelectedIndex] = useState<number | null>(null)
  const [showTemplateForm, setShowTemplateForm] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [rollbackWarning, setRollbackWarning] = useState<{ msgId: string; content: string; fileCount: number } | null>(null)
  const displayMessagesRef = useRef<DisplayMessage[]>([])
  displayMessagesRef.current = displayMessages

  const onPersistSessionRef = useRef(onPersistSession)
  onPersistSessionRef.current = onPersistSession
  const onUpdateSessionMetaRef = useRef(onUpdateSessionMeta)
  onUpdateSessionMetaRef.current = onUpdateSessionMeta

  const persistComposerMeta = useCallback((meta: { composerMode?: ComposerMode; sessionGoal?: string }) => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    onUpdateSessionMetaRef.current?.(sid, meta)
  }, [])

  const flushPersist = useCallback((
    messages: DisplayMessage[],
    plan: ActivePlan | null,
    options?: { appendSystem?: PersistedMessage[]; resetSystem?: boolean }
  ) => {
    const sid = currentSessionIdRef.current
    if (!sid) return
    const serialized = serializeDisplayMessages(messages, plan)
    let systemMsgs = options?.resetSystem
      ? []
      : (sessionsRef.current.find((s) => s.id === sid)?.messages.filter((m) => m.role === 'system') ?? [])
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
    void reloadAgentToolRegistry(ctrl)
    const onConfigSaved = (): void => { void reloadAgentToolRegistry(controllerRef.current) }
    window.addEventListener('agent-config-saved', onConfigSaved)
    return () => {
      window.removeEventListener('agent-config-saved', onConfigSaved)
      ctrl.cancel()
    }
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
      setUsageAccum(EMPTY_USAGE)
      onUsageChangeRef.current?.(EMPTY_USAGE)
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
    setComposerMode(session.composerMode ?? 'agent')
    setSessionGoal(session.sessionGoal ?? '')
    setPlanReady(false)
    controllerRef.current?.setComposerMode(session.composerMode ?? 'agent')
    controllerRef.current?.setSessionGoal(session.sessionGoal ?? '')
    const restoredUsage = normalizeSessionUsage(session.usage, apiConfigRef.current.model)
    setUsageAccum(restoredUsage)
    onUsageChangeRef.current?.(restoredUsage)
    // Only restore controller snapshot if it does NOT already have more messages
    // than the persisted session. This prevents the persistence cycle from
    // overwriting in-memory messages accumulated during an active turn.
    const currentCtrlMsgs = controllerRef.current?.getSnapshot() ?? []
    const persistedMsgs = toControllerMessages(session.messages)
    if (currentCtrlMsgs.length === 0 || persistedMsgs.length > currentCtrlMsgs.length) {
      controllerRef.current?.restoreSnapshot(persistedMsgs)
    }
    // Restore plan tracker so workflow engine can resume execution
    if (restoredPlan?.steps && restoredPlan.steps.length > 0) {
      controllerRef.current?.restorePlanTracker(restoredPlan.steps)
    }
  }, [currentSessionId, sessions])

  useEffect(() => {
    return () => {
      flushPersist(displayMessagesRef.current, activePlanRef.current)
    }
  }, [flushPersist])

  // Watch for external context injected via "发送给AI" buttons (crash reports, build errors, etc.)
  const contextConsumedRef = useRef(0)
  useEffect(() => {
    if (contextFiles.length > contextConsumedRef.current) {
      const newItems = contextFiles.slice(contextConsumedRef.current)
      contextConsumedRef.current = contextFiles.length
      const text = newItems.join('\n\n')
      setInput((prev) => (prev ? `${prev}\n\n${text}` : text))
      // Clear after consuming so the same content isn't re-appended
      setContextFiles([])
      contextConsumedRef.current = 0
    }
  }, [contextFiles, setContextFiles])

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
          const planText = (event.text || '').trim()
          const actionable = event.planActionable ?? isActionablePlanText(planText)
          if (actionable && planText) {
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
          }
        } else if (event.phase === 'plan_stream_end') {
          if (t.msgId) collapseAllReasoning(t.msgId, t.entries)
          refreshDisplay()
        } else if (event.phase === 'execute_start') {
          setAgentStatus('执行中...')
          setPlanReady(false)
        } else if (event.phase === 'plan_ready') {
          setPlanReady(true)
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
            activePlanRef.current = nextPlan
            setActivePlan(nextPlan)
            flushPersist(displayMessagesRef.current, nextPlan)
          }
        }
        break

      case EventKind.ClarificationNeeded:
        if (event.clarification) {
          setClarificationPending(true)
          setClarificationQuestion(event.clarification.question)
          setClarificationOptions(event.clarification.options || [])
          setClarificationOtherInput('')
          setClarificationSelectedIndex(null)
          setIsLoading(false)
          setAgentStatus('')
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
          recordToolDispatch(event.tool.name, event.tool.id, event.tool.args as Record<string, unknown> | undefined)
          markLastReasoningDone(t.msgId, t.entries)
          setCollapsedToolIds((prev) => {
            const next = new Set(prev)
            next.delete(event.tool!.id)
            return next
          })
          // Parse args for display
          let parsedArgs: Record<string, unknown> | undefined
          try {
            if (event.tool.args) {
              parsedArgs = typeof event.tool.args === 'string'
                ? JSON.parse(event.tool.args)
                : event.tool.args as unknown as Record<string, unknown>
            }
          } catch { /* ignore */ }
          t.entries.push({
            kind: 'tool',
            id: event.tool.id,
            name: event.tool.name,
            status: 'running',
            startMs: Date.now(),
            args: parsedArgs,
            displayName: getToolDisplayName(event.tool.name, parsedArgs)
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
          recordToolResult(
            event.tool.name || 'unknown',
            event.tool.id,
            event.tool.output || event.tool.error || '',
            { error: Boolean(event.tool.error), durationMs: event.tool.durationMs }
          )
          setCollapsedToolIds((prev) => new Set(prev).add(event.tool!.id))
          // Find existing tool entry by id and update it
          for (const entry of t.entries) {
            if (entry.kind === 'tool' && entry.id === event.tool.id) {
              entry.status = event.tool.error ? 'error' : 'done'
              entry.output = event.tool.output || event.tool.error || entry.liveOutput || ''
              entry.liveOutput = undefined
              entry.durationMs = event.tool.durationMs
              if (event.tool.fileDiff) {
                entry.fileDiff = event.tool.fileDiff
              }
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
        setClarificationPending(false)
        setClarificationQuestion('')
        t.streamDone = true
        if (t.msgId) collapseAllReasoning(t.msgId, t.entries)
        const hasError = Boolean(event.error)
        t.entries = finalizeRunningTools(t.entries, hasError)
        if (event.phase === 'plan_failed') {
          activePlanRef.current = null
        }
        const planSnapshot = event.phase === 'plan_failed' ? null : activePlanRef.current

        const finalSteps = planSnapshot
          ? planSnapshot.steps.map((s) => ({
              ...s,
              status: hasError && s.status === 'running'
                ? 'error' as const
                : s.status
            }))
          : undefined
        const finalPlanDone = finalSteps ? finalSteps.every((s) => s.status === 'completed') : false
        const turnStatus = resolveTurnDoneStatus({
          hasError,
          error: event.error,
          finalSteps,
          composerMode: composerModeRef.current,
          turnMode: event.turnMode,
          phase: event.phase
        })

        setIsLoading(false)
        setAgentStatus('')
        onRunningChangeRef.current?.(false)

        if (!hasError && finalPlanDone) {
          setCompletionFlash('任务已完成')
          if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
          completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
        } else if (!hasError && turnStatus === 'planned') {
          setCompletionFlash('计划已就绪')
          setPlanReady(true)
          if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
          completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
        } else if (!hasError && turnStatus === 'answered') {
          setCompletionFlash('')
        } else if (!hasError && !finalPlanDone && finalSteps?.length) {
          setCompletionFlash('任务部分完成')
          if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
          completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
        }

        setUsageAccum((prev) => {
          onUsageChangeRef.current?.(prev)
          return prev
        })

        const anchorId = planSnapshot?.anchorMsgId || t.msgId

        const fileChanges = t.entries
          .filter(e => e.kind === 'tool' && ['write_file', 'edit_file'].includes(e.name || ''))
          .map(e => {
            const diff = (e as any).fileDiff
            if (!diff) return null
            return {
              path: diff.path,
              oldContent: diff.oldContent,
              action: diff.action
            }
          })
          .filter(Boolean)

        const ctrl = controllerRef.current

        setDisplayMessages((prev) => {
          const next = prev.map((m) => {
            if (m.isStreaming || m.id === anchorId || m.id === t.msgId) {
              const isAnchor = m.id === anchorId || m.id === t.msgId
              const msgIndex = next.findIndex(n => n.id === m.id)
              
              const stateSnapshot = isAnchor ? {
                messageIndex: msgIndex >= 0 ? msgIndex : prev.findIndex(p => p.id === m.id),
                controllerMessages: ctrl?.getSnapshot() || [],
                planTrackerSteps: planSnapshot?.steps.map(s => ({
                  id: s.id,
                  description: s.description,
                  status: s.status
                })),
                phase: event.phase === 'plan' ? 'plan' : 'execute',
                composerMode: composerModeRef.current,
                sessionGoal: sessionGoalRef.current,
                activePlan: planSnapshot ? { ...planSnapshot, steps: [...planSnapshot.steps] } : undefined,
                fileSnapshots: fileChanges.map(c => ({
                  path: c.path,
                  content: c.oldContent || '',
                  timestamp: Date.now()
                }))
              } : m.stateSnapshot

              return {
                ...m,
                ...(isAnchor ? { entries: [...t.entries] } : {}),
                isStreaming: false,
                ...(isAnchor ? {
                  turnStatus,
                  embeddedPlan: event.phase === 'plan_failed'
                    ? undefined
                    : (finalSteps && finalSteps.length > 0 ? finalSteps : m.embeddedPlan)
                } : {}),
                stateSnapshot
              }
            }
            return m
          })
          flushPersist(next, turnStatus === 'planned' ? planSnapshot : null)
          return next
        })

        setActivePlan(turnStatus === 'planned' ? planSnapshot : null)
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

    if (clarificationPending) {
      let answer = input.trim()
      if (!answer && clarificationOtherInput.trim()) {
        answer = clarificationOtherInput.trim()
      }
      setInput('')
      setClarificationPending(false)
      setClarificationQuestion('')
      setClarificationOptions([])
      setClarificationOtherInput('')
      setClarificationSelectedIndex(null)
      setIsLoading(true)
      setAgentStatus('思考中...')
      const ctrl = controllerRef.current
      if (ctrl) {
        try { await ctrl.answerClarification(answer) }
        catch {
          setIsLoading(false)
          setAgentStatus('')
          onRunningChangeRef.current?.(false)
        }
      }
      return
    }

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
      controllerRef.current?.setComposerMode(composerMode)
      controllerRef.current?.setSessionGoal(sessionGoal)
      persistComposerMeta({ composerMode, sessionGoal })
    } else {
      setDisplayMessages((prev) => {
        const next = [...prev, { id: uid(), role: 'user' as const, content: userMsg, timestamp: Date.now() }]
        flushPersist(next, null)
        return next
      })
    }

    const ctrl = controllerRef.current
    if (!ctrl) return
    ctrl.setComposerMode(composerMode)
    ctrl.setSessionGoal(sessionGoal)
    try { await ctrl.send(userMsg) }
    catch {
      setIsLoading(false)
      setAgentStatus('')
      onRunningChangeRef.current?.(false)
    }
  }, [input, isLoading, toolchainReady, apiConfig, ensureApiKey, currentSessionId, flushPersist, onNewSession, composerMode, sessionGoal, clarificationPending])

  const handleExecutePlan = useCallback(async () => {
    if (isLoading || !toolchainReady) return
    const ctrl = controllerRef.current
    if (!ctrl) return
    setIsLoading(true)
    setAgentStatus('执行中...')
    setPlanReady(false)
    try {
      await ctrl.startExecuteFromPlan()
    } catch {
      setIsLoading(false)
      setAgentStatus('')
      onRunningChangeRef.current?.(false)
    }
  }, [isLoading, toolchainReady])

  const handleTemplateSelect = useCallback((templateId: string, name: string) => {
    if (isLoading || clarificationPending) {
      alert('AI 正在处理中，请稍候')
      return
    }
    if (!toolchainReady) {
      alert('构建环境初始化中，请等待进度条完成')
      return
    }
    if (!projectPath) {
      alert('请先打开一个项目')
      return
    }

    const resolvedKey = ensureApiKey ? ensureApiKey() : Promise.resolve(apiConfig.apiKey.trim())
    resolvedKey.then((key) => {
      if (!key) {
        alert('请先配置 API Key（左侧「设置」→ 保存密钥）')
        return
      }

      setSelectedTemplateId(templateId)
      setShowTemplateForm(true)
    })
  }, [isLoading, clarificationPending, toolchainReady, projectPath, apiConfig, ensureApiKey])

  const handleTemplateFormConfirm = useCallback((prompt: string) => {
    setShowTemplateForm(false)
    setContextFiles([])

    if (!currentSessionId) {
      const newId = onNewSession(prompt)
      currentSessionIdRef.current = newId
      setDisplayMessages([{ id: uid(), role: 'user', content: prompt, timestamp: Date.now() }])
      controllerRef.current?.clearSession()
      controllerRef.current?.setComposerMode(composerMode)
      controllerRef.current?.setSessionGoal(sessionGoal)
    } else {
      setDisplayMessages((prev) => {
        const next = [...prev, { id: uid(), role: 'user' as const, content: prompt, timestamp: Date.now() }]
        flushPersist(next, null)
        return next
      })
    }

    const ctrl = controllerRef.current
    if (!ctrl) return
    ctrl.setComposerMode(composerMode)
    ctrl.setSessionGoal(sessionGoal)
    setIsLoading(true)
    setAgentStatus('思考中...')
    ctrl.send(prompt).catch(() => {
      setIsLoading(false)
      setAgentStatus('')
      onRunningChangeRef.current?.(false)
    })
  }, [currentSessionId, onNewSession, flushPersist, composerMode, sessionGoal, setContextFiles])

  const handleTemplateFormCancel = useCallback(() => {
    setShowTemplateForm(false)
    setSelectedTemplateId('')
  }, [])

  useImperativeHandle(ref, () => ({
    handleTemplateSelect
  }), [handleTemplateSelect])

  const handleComposerModeChange = useCallback((mode: ComposerMode) => {
    setComposerMode(mode)
    controllerRef.current?.setComposerMode(mode)
    persistComposerMeta({ composerMode: mode })
  }, [persistComposerMeta])

  const handleSessionGoalChange = useCallback((goal: string) => {
    setSessionGoal(goal)
    controllerRef.current?.setSessionGoal(goal)
    persistComposerMeta({ sessionGoal: goal })
  }, [persistComposerMeta])

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
    flushPersist(truncated, null, { resetSystem: true })

    const serialized = serializeDisplayMessages(truncated, null)
    controllerRef.current?.restoreSnapshot(
      toControllerMessages(serialized)
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

  const handleRollback = useCallback((msgId: string) => {
    if (isLoading) return

    const msgIndex = displayMessages.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = displayMessages[msgIndex]
    const snapshot = targetMsg.stateSnapshot
    if (!snapshot) return

    const fileCount = snapshot.fileSnapshots.length
    setRollbackWarning({
      msgId,
      content: targetMsg.content,
      fileCount
    })
  }, [isLoading, displayMessages])

  const handleRollbackConfirm = useCallback(async () => {
    if (!rollbackWarning) return

    const { msgId, content: messageContent } = rollbackWarning
    setRollbackWarning(null)

    const msgIndex = displayMessages.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return

    const targetMsg = displayMessages[msgIndex]
    const snapshot = targetMsg.stateSnapshot
    if (!snapshot) return

    for (const fs of snapshot.fileSnapshots) {
      if (fs.content) {
        await window.api.writeFile(`${projectPath}/${fs.path}`, fs.content)
      } else {
        await window.api.deleteFile(`${projectPath}/${fs.path}`).catch(() => {})
      }
    }

    const restoredMessages = displayMessages.slice(0, msgIndex)

    const ctrl = controllerRef.current
    if (ctrl) {
      ctrl.restoreSnapshot(snapshot.controllerMessages)
      ctrl.setComposerMode(snapshot.composerMode)
      ctrl.setSessionGoal(snapshot.sessionGoal)
    }

    setDisplayMessages(restoredMessages)
    setActivePlan(snapshot.activePlan || null)
    setComposerMode(snapshot.composerMode)
    setSessionGoal(snapshot.sessionGoal)

    setCollapsedToolIds(new Set())
    setCollapsedReasoningKeys(new Set())

    setInput(messageContent)

    if (projectPath) {
      window.api.listDirectory(projectPath)
    }

    flushPersist(restoredMessages, snapshot.activePlan || null)

    setCompletionFlash('已回滚')
    if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
    completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
  }, [rollbackWarning, displayMessages, projectPath, flushPersist])

  const handleRollbackCancel = useCallback(() => {
    setRollbackWarning(null)
  }, [])

  // ======== RENDER ========
  const renderContent = (content: string) => <MarkdownContent content={content} />

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
              {msg.turnStatus === 'planned' && <span className="turn-badge turn-badge--planned">计划就绪</span>}
              {msg.turnStatus === 'answered' && <span className="turn-badge turn-badge--answered">已回复</span>}
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
                          <div
                            className={`reasoning-block-bd reasoning-line${isActiveStream ? ' active-stream' : ''}`}
                            ref={isActiveStream ? (el) => {
                              if (el) { el.scrollTop = el.scrollHeight }
                            } : undefined}
                          >{entry.content}</div>
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
                      entry.status === 'done' ? <span className="tool-status-dot done" />
                        : entry.status === 'running' ? <span className="tool-status-dot running" />
                          : entry.status === 'error' ? <span className="tool-status-dot error" />
                            : <span className="tool-status-dot pending" />
                    const displayName = entry.displayName || getToolDisplayName(entry.name, entry.args)
                    const diff = entry.fileDiff
                    const showDiffStats = diff && (diff.added > 0 || diff.removed > 0)
                    const showDiffPreview = diff && (diff.firstAdded || diff.firstRemoved) && !isCollapsed
                    // Extract target path for file operations
                    const targetPath = diff?.path
                      || (typeof entry.args?.path === 'string' ? entry.args.path : undefined)
                      || undefined
                    const showPathTag = targetPath && (entry.status === 'done' || entry.status === 'error')
                    const pathFileName = targetPath ? targetPath.split('/').pop() || targetPath : ''
                    return (
                      <div
                        key={`tool-${entry.id}`}
                        className={`tool-line${entry.status === 'running' ? ' running' : ''}`}
                      >
                        {statusMark}
                        <span className="tool-line-name">{displayName}</span>
                        {showPathTag && (
                          <span className="tool-line-path" title={targetPath}>{pathFileName}</span>
                        )}
                        {showDiffStats && (
                          <span className="tool-line-diff">
                            {diff.added > 0 && <span className="diff-added">+{diff.added}</span>}
                            {diff.removed > 0 && <span className="diff-removed">-{diff.removed}</span>}
                          </span>
                        )}
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
                                {extractPreview(entry.name, displayOutput, entry.args)}
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
                        {showDiffPreview && (
                          <div className="tool-line-diff-preview">
                            {diff.firstAdded && (
                              <div className="diff-preview-line diff-preview-added">
                                <span className="diff-preview-marker">+</span>
                                <span>{diff.firstAdded}</span>
                              </div>
                            )}
                            {diff.firstRemoved && (
                              <div className="diff-preview-line diff-preview-removed">
                                <span className="diff-preview-marker">-</span>
                                <span>{diff.firstRemoved}</span>
                              </div>
                            )}
                          </div>
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
          onRollback={handleRollback}
          canRollback={displayMessages.indexOf(msg) < displayMessages.length - 1}
        />
      </div>
    )
  }

  return (
    <>
      <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-header-left">
          <img src={appIcon} alt="" className="chat-brand-icon" />
          <span className="chat-header-brand">AI 智能体</span>
        </div>
        <div className="chat-header-right">
          <button
            className="chat-header-export-btn"
            title="导出完整会话历史到桌面 JSON 文件"
            onClick={async () => {
              try {
                const displayPayload = JSON.stringify({
                  exportedAt: new Date().toISOString(),
                  source: 'display-messages',
                  sessionGoal: activePlan?.steps?.length ? activePlan.steps.map(s => s.description).join('; ') : '(未设定)',
                  messageCount: displayMessages.length,
                  messages: displayMessages,
                }, null, 2)
                const result = await window.api.sessionExport(displayPayload, 'mc-session-display')
                if (result.success) {
                  // Also try to dump controller messages if available
                  try {
                    const ctrlPayload = JSON.stringify({
                      exportedAt: new Date().toISOString(),
                      source: 'controller-api',
                      messages: controllerRef.current?.getSnapshot() || []
                    }, null, 2)
                    await window.api.sessionExport(ctrlPayload, 'mc-session-api')
                  } catch { /* controller may not have messages */ }
                  setCompletionFlash(`已导出: ${result.name}`)
                  setTimeout(() => setCompletionFlash(null), 3000)
                }
              } catch {
                setCompletionFlash('导出失败')
                setTimeout(() => setCompletionFlash(null), 3000)
              }
            }}
          >导出</button>
          {completionFlash ? (
            <span className="chat-header-status chat-header-status--done">{completionFlash}</span>
          ) : agentStatus ? (
            <span className="chat-header-status">{agentStatus}</span>
          ) : null}
        </div>
      </div>
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleScroll}>
        {activePlan?.pinned && !displayMessages.some(m => m.role === 'assistant' && m.turnStatus) && (
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
        {clarificationPending && (
          <div className="clarification-banner">
            <div className="clarification-banner-hd">
              <span className="clarification-banner-icon">?</span>
              <span>AI 需要你的确认</span>
            </div>
            <div className="clarification-banner-question">{clarificationQuestion}</div>
            {clarificationOptions.length > 0 ? (
              <div className="clarification-banner-options">
                {clarificationOptions.map((opt, i) => {
                  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
                  const letter = letters[i] || String(i + 1)
                  return (
                    <button
                      key={i}
                      className={`clarification-option-btn ${clarificationSelectedIndex === i ? 'selected' : ''}`}
                      onClick={() => {
                        setClarificationSelectedIndex(i)
                        setInput(opt)
                        setClarificationOtherInput('')
                      }}
                    >
                      <span className="clarification-option-letter">{letter}</span>
                      <span className="clarification-option-text">{opt}</span>
                    </button>
                  )
                })}
                <button
                  className={`clarification-option-btn ${clarificationSelectedIndex === -1 ? 'selected' : ''}`}
                  onClick={() => {
                    setClarificationSelectedIndex(-1)
                  }}
                >
                  <span className="clarification-option-letter">其他</span>
                  <span className="clarification-option-text">
                    <input
                      type="text"
                      className="clarification-other-input"
                      placeholder="请输入其他选项..."
                      value={clarificationOtherInput}
                      onChange={(e) => {
                        setClarificationOtherInput(e.target.value)
                        setInput(e.target.value)
                      }}
                    />
                  </span>
                </button>
              </div>
            ) : (
              <div className="clarification-banner-hint">请在下方输入你的回答，然后发送</div>
            )}
          </div>
        )}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          onCancel={handleCancel}
          isLoading={isLoading}
          disabled={!projectPath || isLoading || !toolchainReady}
          composerMode={composerMode}
          onComposerModeChange={handleComposerModeChange}
          sessionGoal={sessionGoal}
          onSessionGoalChange={handleSessionGoalChange}
          planReady={planReady}
          onExecutePlan={handleExecutePlan}
          toolchainReady={toolchainReady}
          hasProject={Boolean(projectPath)}
          onQuickTemplateSelect={handleTemplateSelect}
        />
      </div>

      {showTemplateForm && (
        <TemplateFormPanel
          templateId={selectedTemplateId}
          onConfirm={handleTemplateFormConfirm}
          onCancel={handleTemplateFormCancel}
        />
      )}
    </div>

    {rollbackWarning && (
      <RollbackWarningPanel
        messageContent={rollbackWarning.content}
        fileCount={rollbackWarning.fileCount}
        onConfirm={handleRollbackConfirm}
        onCancel={handleRollbackCancel}
      />
    )}
    </>
  )
})

// Extract a clean preview summary from tool output (for collapsed view).
// Returns user-facing info only — no AI diagnostic text, no emoji.
function extractPreview(toolName: string, output: string, args?: Record<string, unknown>): string {
  if (!output) return ""

  // File tools
  if (toolName === "read_file") {
    const path = String(args?.path || "")
    const fileName = path.split("/").pop() || path
    const match = output.match(/共 (\d+) 行，显示 (\d+)-(\d+) 行/)
    if (match) return `${fileName}  ${match[2]}-${match[3]} / ${match[1]} 行`
    const sizeMatch = output.match(/(\d+)\s*bytes/)
    return sizeMatch ? `${fileName} (${sizeMatch[1]} bytes)` : fileName
  }
  if (toolName === "write_file") {
    const path = String(args?.path || "")
    const fileName = path.split("/").pop() || path
    const diffMatch = output.match(/新增 (\d+) 行.*删除 (\d+) 行/)
    const sizeMatch = output.match(/(\d+)\s*bytes/)
    if (diffMatch) return `${fileName}  +${diffMatch[1]} -${diffMatch[2]}`
    if (sizeMatch) return `${fileName}  + 行 (${sizeMatch[1]} bytes)`
    return fileName
  }
  if (toolName === "edit_file") {
    const path = String(args?.path || "")
    const fileName = path.split("/").pop() || path
    const lineMatch = output.match(/第 (\d+) 行/)
    const diffMatch = output.match(/\+(\d+) 行|修改 (\d+) 行/)
    const lineInfo = lineMatch ? `第 ${lineMatch[1]} 行` : ""
    const diffInfo = diffMatch ? ` +${diffMatch[1] || diffMatch[2]}` : ""
    return `${fileName}${lineInfo ? " " + lineInfo : ""}${diffInfo}`
  }

  // Directory
  if (toolName === "list_directory") {
    const path = String(args?.path || "")
    const dirName = path.split("/").pop() || "/"
    const items = output.split("\n").filter(l => l.trim() && !l.startsWith("total"))
    return `${dirName} (${items.length} 项)`
  }

  // Build/Run
  if (toolName === "trigger_build" || toolName === "run_command") {
    if (output.includes("BUILD SUCCESSFUL")) {
      const timeMatch = output.match(/(\d+)s/)
      return timeMatch ? `BUILD SUCCESSFUL (${timeMatch[1]}s)` : "BUILD SUCCESSFUL"
    }
    if (output.includes("BUILD FAILED")) return "BUILD FAILED"
    if (output.includes("MC_PHASE:playing") || output.includes("已启动游戏")) return "游戏运行中"
    const exitMatch = output.match(/\[exit code: (\d+)\]|\[退出码: (\d+)\]/)
    const exitCode = exitMatch?.[1] ?? exitMatch?.[2]
    if (exitCode && exitCode !== "0") return `退出码 ${exitCode}`
    return "已完成"
  }

  // Knowledge search
  if (toolName === "fabric_docs_search" || toolName === "fabric_javadoc_lookup" || toolName === "vanilla_mc_wiki_query") {
    const kw = String(args?.keyword || "")
    const summary = output.match(/结果：(.+)$/m)?.[1] || ""
    return summary ? `${kw.slice(0,28)} → ${summary}` : kw.slice(0,36)
  }
  if (toolName === "fabric_meta_version_check") {
    const mc = output.match(/"minecraft_version":\s*"([^"]+)"/)?.[1] || ""
    return mc ? `MC ${mc}` : "版本查询"
  }

  // Recipe
  if (toolName === "create_recipe" || toolName === "fabric_recipe_generate") {
    const name = String(args?.name || "")
    if (name) return `${name}.json`
    const pm = output.match(/已生成配方:\s*(\S+)/)
    if (pm) { const p = pm[1]; return p.split("/").pop() || p }
    return "配方"
  }

  // Content/data
  if (toolName === "fabric_content_register") {
    const p = String(args?.path || args?.className || "")
    return p ? p.replace(/^.*\//, "") : "内容注册"
  }
  if (toolName === "fabric_data_assets_generate") {
    const files = output.match(/- (\S+)/g)
    return files ? `${files.length} 个资源文件` : "资源生成"
  }

  // Mixin
  if (toolName === "fabric_mixin_scaffold") {
    const cls = args?.mixinClass ? String(args.mixinClass).split(".").pop() : null
    return cls || "Mixin"
  }
  if (toolName === "fabric_mixin_register") {
    const cls = String(args?.mixinClass || "").split(".").pop() || ""
    return cls ? `${cls} 已注册` : "已注册"
  }

  // Debug/log
  if (toolName === "fabric_log_debugger") {
    const k = output.match(/"kind":\s*"([^"]+)"/)?.[1] || ""
    return k || "日志分析"
  }
  if (toolName === "read_error_log") {
    if (output.includes("BUILD FAILED")) return "BUILD FAILED"
    if (output.includes("BUILD SUCCESSFUL")) return "BUILD SUCCESSFUL"
    return "日志"
  }

  // Validation
  if (toolName === "fabric_mod_json_validate") {
    if (output.includes('"ok": true')) return "校验通过"
    const issues = (output.match(/issue|warning/gi) || []).length
    return issues > 0 ? `${issues} 个问题` : "校验完成"
  }

  // Meta
  if (toolName === "complete_step") {
    const m = output.match(/步骤 #(\d+)/)
    return m ? `步骤 ${m[1]} 已完成` : "步骤完成"
  }
  if (toolName === "ask_clarification") {
    const q = String(args?.question || "")
    return q.length > 40 ? q.slice(0, 40) + "…" : q || "需要确认"
  }

  const fl = output.split("\n")[0]?.trim() || ""
  return fl.length > 52 ? fl.slice(0, 52) + "…" : fl
}

export default ChatPanel
