// @ts-nocheck
import { Controller } from './controller.ts'
import { Registry } from './tools.ts'
import { registerModCraftingTools } from './tool-definitions.ts'
import { EventKind, type Event } from './events.ts'
import {
  collaborationForAutomation,
  toolArgsForAutomation,
  toolOutputForAutomation
} from './automation-event-projection.ts'
import type { PlanStep } from '../components/TaskPlan.tsx'
import { parsePlanSteps, isActionablePlanText } from '../utils/plan-steps.ts'
import { resolveTurnDoneStatus } from '../utils/turn-status.ts'
import { ensureClosingSummaryEntry, type ClosingReason } from '../utils/turn-closing-summary.ts'
import {
  buildPreTurnSnapshot,
  enrichUserSnapshotAfterTurnDone,
  type TurnFileChange
} from '../utils/rollback-snapshot.ts'
import {
  EMPTY_USAGE,
  estimateCostDelta,
  contextPercentFromPrompt,
  normalizeSessionUsage,
  workingContextWindow,
  type UsageStats
} from '../utils/usage.ts'
import {
  buildContextAttribution,
  toContextFrame,
  CONTEXT_ATTRIBUTION_ENABLED,
  CONTEXT_HISTORY_LIMIT
} from '../utils/context-attribution.ts'
import type { ChatSession, PersistedMessage } from '../types/chat.ts'
import {
  serializeDisplayMessages,
  deserializeToDisplay,
  restoreActivePlan,
  buildRestoredCollapseState,
  toControllerMessagesWithAttachments
} from '../utils/chat-persist.ts'
import type { DisplayMessage, ChronoEntry } from '../types/display-message.ts'
import type { ComposerMode } from './turn-intent.ts'
import { recordToolDispatch, recordToolResult } from '../utils/tool-activity.ts'
import { collectExploreGroupKeys, isExploreTool } from '../utils/tool-explore-group.ts'
import { getToolLabelZh } from './tool-labels.ts'
import type { MessageAttachment } from '../context/context-ingress.ts'
import { buildUserContent } from '../context/user-content.ts'
import type {
  CollaborationTrace,
  ModelRef,
  ModelRoutingConfig,
  RoutingSelection
} from '../../../shared/model-routing.ts'
import type { GameTestWorkflowStatus } from './game-test-protocol.ts'

function generateMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `msg-${crypto.randomUUID()}`
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function uid(): string {
  return generateMessageId()
}

function toPlanSteps(steps: Array<{
  id: string
  description: string
  status: string
  kind?: 'inspect' | 'write' | 'recipe' | 'mixin'
  targetPath?: string
  targetPaths?: string[]
  evidence?: string
}>): PlanStep[] {
  return steps.map((s) => ({
    ...s,
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

function formatClarificationTextEntry(question: string, options: string[]): string {
  const q = question.trim()
  if (!options.length) return q
  const opts = options.map((o, i) => `${i + 1}. ${o}`).join('\n')
  return `${q}\n\n选项：\n${opts}`
}

function appendClarificationTextEntry(
  entries: ChronoEntry[],
  question: string,
  options: string[]
): ChronoEntry[] {
  const content = formatClarificationTextEntry(question, options)
  if (!content) return entries
  const last = entries[entries.length - 1]
  if (last?.kind === 'text' && last.content.trim() === content.trim()) return entries
  return [...entries, { kind: 'text', content }]
}

export interface ActivePlan {
  steps: PlanStep[]
  anchorMsgId: string
  pinned: boolean
}

export interface SessionRuntimeSnapshot {
  sessionId: string
  projectPath: string | null
  displayMessages: DisplayMessage[]
  activePlan: ActivePlan | null
  isLoading: boolean
  agentStatus: string
  planReady: boolean
  composerMode: ComposerMode
  sessionGoal: string
  usageAccum: UsageStats
  completionFlash: string
  clarificationPending: boolean
  clarificationQuestion: string
  clarificationOptions: string[]
  gameTestStatus: GameTestWorkflowStatus | null
  collapsedToolIds: Set<string>
  collapsedExploreGroupKeys: Set<string>
  collapsedReasoningKeys: Set<string>
  turnState: {
    msgId: string
    entries: ChronoEntry[]
    streamDone: boolean
    collaborationTrace: CollaborationTrace[]
  }
}

export interface SessionRuntimeInitOptions {
  sessionId: string
  projectPath: string | null
  apiConfig: { endpoint: string; apiKey: string; model: string; providerId: string }
  routingConfig?: ModelRoutingConfig
  routingSelection?: RoutingSelection
  resolveRoutingModel?: (model: ModelRef) => Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string } | null>
  onPersistSession?: (sessionId: string, messages: PersistedMessage[]) => void
  onUpdateSessionMeta?: (sessionId: string, meta: { composerMode?: ComposerMode; sessionGoal?: string }) => void
  onUsageChange?: (usage: UsageStats, meta?: { costDelta?: number }) => void
  onRunningChange?: (running: boolean) => void
}

export class SessionRuntime {
  public readonly sessionId: string
  public projectPath: string | null
  public apiConfig: { endpoint: string; apiKey: string; model: string; providerId: string }
  public routingConfig?: ModelRoutingConfig
  public routingSelection?: RoutingSelection
  public resolveRoutingModel?: (model: ModelRef) => Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string } | null>

  public controller: Controller
  public displayMessages: DisplayMessage[] = []
  public activePlan: ActivePlan | null = null
  public isLoading = false
  public agentStatus = ''
  public planReady = false
  public composerMode: ComposerMode = 'agent'
  public sessionGoal = ''
  public usageAccum: UsageStats = EMPTY_USAGE
  public completionFlash = ''
  public clarificationPending = false
  public clarificationQuestion = ''
  public clarificationOptions: string[] = []
  public gameTestStatus: GameTestWorkflowStatus | null = null

  public collapsedToolIds = new Set<string>()
  public collapsedExploreGroupKeys = new Set<string>()
  public collapsedReasoningKeys = new Set<string>()

  public turn = {
    msgId: '',
    entries: [] as ChronoEntry[],
    streamDone: false,
    collaborationTrace: [] as CollaborationTrace[]
  }

  private turnUsage = { promptTokens: 0, completionTokens: 0 }
  private completionFlashTimer: number | null = null
  private listeners = new Set<(snapshot: SessionRuntimeSnapshot) => void>()
  private hydrated = false
  private destroyed = false

  public onPersistSession?: (sessionId: string, messages: PersistedMessage[]) => void
  public onUpdateSessionMeta?: (sessionId: string, meta: { composerMode?: ComposerMode; sessionGoal?: string }) => void
  public onUsageChange?: (usage: UsageStats, meta?: { costDelta?: number }) => void
  public onRunningChange?: (running: boolean) => void

  constructor(opts: SessionRuntimeInitOptions, registry: Registry) {
    this.sessionId = opts.sessionId
    this.projectPath = opts.projectPath
    this.apiConfig = opts.apiConfig
    this.routingConfig = opts.routingConfig
    this.routingSelection = opts.routingSelection
    this.resolveRoutingModel = opts.resolveRoutingModel
    this.onPersistSession = opts.onPersistSession
    this.onUpdateSessionMeta = opts.onUpdateSessionMeta
    this.onUsageChange = opts.onUsageChange
    this.onRunningChange = opts.onRunningChange

    this.controller = new Controller({
      registry,
      projectPath: this.projectPath,
      apiConfig: this.apiConfig,
      routingConfig: this.routingConfig,
      routingSelection: this.routingSelection,
      resolveModelConfig: this.resolveRoutingModel,
      onEvent: (event) => this.handleEvent(event),
      onAgentStatus: (status) => {
        this.agentStatus = status
        this.notify()
      },
      onStreamUpdate: () => {}
    })
  }

  public subscribe(listener: (snapshot: SessionRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  public notify(): void {
    if (this.destroyed) return
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('SessionRuntime listener error:', err)
      }
    }
    SessionRuntimeManager.getInstance().notifyGlobalStatus(this.sessionId, this.isLoading, this.clarificationPending)
  }

  public getSnapshot(): SessionRuntimeSnapshot {
    return {
      sessionId: this.sessionId,
      projectPath: this.projectPath,
      displayMessages: this.displayMessages,
      activePlan: this.activePlan,
      isLoading: this.isLoading,
      agentStatus: this.agentStatus,
      planReady: this.planReady,
      composerMode: this.composerMode,
      sessionGoal: this.sessionGoal,
      usageAccum: this.usageAccum,
      completionFlash: this.completionFlash,
      clarificationPending: this.clarificationPending,
      clarificationQuestion: this.clarificationQuestion,
      clarificationOptions: this.clarificationOptions,
      gameTestStatus: this.gameTestStatus,
      collapsedToolIds: this.collapsedToolIds,
      collapsedExploreGroupKeys: this.collapsedExploreGroupKeys,
      collapsedReasoningKeys: this.collapsedReasoningKeys,
      turnState: {
        msgId: this.turn.msgId,
        entries: this.turn.entries,
        streamDone: this.turn.streamDone,
        collaborationTrace: this.turn.collaborationTrace
      }
    }
  }

  public setProjectPath(path: string | null): void {
    this.projectPath = path
    this.controller.setProjectPath(path)
  }

  public setApiConfig(cfg: { endpoint: string; apiKey: string; model: string; providerId: string }): void {
    this.apiConfig = cfg
    this.controller.setApiConfig(cfg)
  }

  public setRouting(
    routingConfig?: ModelRoutingConfig,
    routingSelection?: RoutingSelection,
    resolveRoutingModel?: (model: ModelRef) => Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string } | null>
  ): void {
    this.routingConfig = routingConfig
    this.routingSelection = routingSelection
    this.resolveRoutingModel = resolveRoutingModel
    this.controller.setRouting(routingConfig, routingSelection, resolveRoutingModel)
  }

  public setComposerMode(mode: ComposerMode): void {
    this.composerMode = mode
    this.controller.setComposerMode(mode)
    this.onUpdateSessionMeta?.(this.sessionId, { composerMode: mode })
    this.notify()
  }

  public setSessionGoal(goal: string): void {
    this.sessionGoal = goal
    this.controller.setSessionGoal(goal)
    this.onUpdateSessionMeta?.(this.sessionId, { sessionGoal: goal })
    this.notify()
  }

  public toggleToolOutput(id: string): void {
    const next = new Set(this.collapsedToolIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    this.collapsedToolIds = next
    this.notify()
  }

  public toggleExploreGroup(key: string): void {
    const next = new Set(this.collapsedExploreGroupKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this.collapsedExploreGroupKeys = next
    this.notify()
  }

  public toggleReasoning(key: string): void {
    const next = new Set(this.collapsedReasoningKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this.collapsedReasoningKeys = next
    this.notify()
  }

  public collapseAllReasoning(msgId: string, entries: ChronoEntry[]): void {
    const keys: string[] = []
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.kind === 'reasoning') {
        e.done = true
        keys.push(`${msgId}-${i}`)
      }
    }
    if (keys.length === 0) return
    const next = new Set(this.collapsedReasoningKeys)
    keys.forEach((k) => next.add(k))
    this.collapsedReasoningKeys = next
  }

  public markLastReasoningDone(msgId: string, entries: ChronoEntry[]): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'reasoning' && !e.done) {
        e.done = true
        const next = new Set(this.collapsedReasoningKeys)
        next.add(`${msgId}-${i}`)
        this.collapsedReasoningKeys = next
        break
      }
      if (e.kind !== 'reasoning') break
    }
  }

  public refreshDisplay(): void {
    const t = this.turn
    if (!t.msgId) return
    this.displayMessages = this.displayMessages.map((m) => {
      if (m.id !== t.msgId) return m
      return {
        ...m,
        entries: [...t.entries],
        isStreaming: !t.streamDone
      }
    })
    this.notify()
  }

  public flushPersist(
    messages: DisplayMessage[] = this.displayMessages,
    plan: ActivePlan | null = this.activePlan,
    options?: { appendSystem?: PersistedMessage[]; resetSystem?: boolean }
  ): void {
    if (!this.onPersistSession) return
    const serialized = serializeDisplayMessages(messages, plan)
    let systemMsgs = options?.resetSystem ? [] : []
    if (options?.appendSystem?.length) {
      systemMsgs = [...systemMsgs, ...options.appendSystem]
    }
    this.onPersistSession(this.sessionId, [...serialized, ...systemMsgs])
  }

  public hydrateFromSession(session: ChatSession, readAttachmentDataUrl?: (path: string) => Promise<{ ok: boolean; dataUrl?: string }>): void {
    if (this.hydrated && this.controller.running) {
      return
    }
    this.hydrated = true
    this.composerMode = session.composerMode ?? 'agent'
    this.sessionGoal = session.sessionGoal ?? ''
    this.controller.setComposerMode(this.composerMode)
    this.controller.setSessionGoal(this.sessionGoal)

    const display = deserializeToDisplay(session.messages, uid) as DisplayMessage[]
    const restoredPlan = restoreActivePlan(display, session.messages)
    const { toolIds, reasoningKeys, exploreGroupKeys } = buildRestoredCollapseState(display)
    this.collapsedToolIds = toolIds
    this.collapsedExploreGroupKeys = exploreGroupKeys
    this.collapsedReasoningKeys = reasoningKeys
    this.displayMessages = display
    this.activePlan = restoredPlan
    this.planReady = false

    const restoredUsage = normalizeSessionUsage(session.usage, this.apiConfig.model, this.apiConfig.providerId)
    this.usageAccum = restoredUsage
    this.onUsageChange?.(restoredUsage)

    const persistedMsgsPromise = toControllerMessagesWithAttachments(
      session.messages,
      readAttachmentDataUrl || ((p) => window.api.readAttachmentDataUrl(p))
    )
    void persistedMsgsPromise.then((persistedMsgs) => {
      if (this.destroyed) return
      this.controller.restoreSnapshot(persistedMsgs)
      if (restoredPlan?.steps && restoredPlan.steps.length > 0) {
        this.controller.restorePlanTracker(restoredPlan.steps)
      } else {
        this.controller.restorePlanTracker([])
      }
      this.notify()
    })
  }

  public updateDisplayMessages(updater: (prev: DisplayMessage[]) => DisplayMessage[]): void {
    this.displayMessages = updater(this.displayMessages)
    this.flushPersist(this.displayMessages, this.activePlan)
    this.notify()
  }

  public updateActivePlan(plan: ActivePlan | null): void {
    this.activePlan = plan
    this.flushPersist(this.displayMessages, plan)
    this.notify()
  }

  public async send(
    userMsg: string,
    messageAttachments: MessageAttachment[] = [],
    imageDataUrls: Map<string, string> = new Map(),
    options?: { executeWaitingPlan?: boolean }
  ): Promise<void> {
    if (this.isLoading || this.controller.running) {
      throw new Error('turn_already_running')
    }

    const sendContent = buildUserContent(userMsg, messageAttachments, imageDataUrls)

    if (options?.executeWaitingPlan && this.activePlan?.steps?.length) {
      this.controller.restorePlanTracker(this.activePlan.steps)
    } else {
      this.controller.clearPlanForNewTurn()
      this.activePlan = null
      this.planReady = false
    }

    this.gameTestStatus = null
    this.isLoading = true
    this.agentStatus = '思考中...'
    this.completionFlash = ''
    this.onRunningChange?.(true)

    const assistantPlaceholder: DisplayMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      entries: [],
      isStreaming: true,
      timestamp: Date.now(),
      model: this.apiConfig.model,
      providerId: this.apiConfig.providerId
    }
    this.turn = { msgId: assistantPlaceholder.id, entries: [], streamDone: false, collaborationTrace: [] }

    const preSnapshot = buildPreTurnSnapshot({
      messageIndex: this.displayMessages.length,
      controller: this.controller,
      composerMode: this.composerMode,
      sessionGoal: this.sessionGoal,
      activePlan: this.activePlan
    })
    const userMessage: DisplayMessage = {
      id: uid(),
      role: 'user',
      content: userMsg,
      timestamp: Date.now(),
      stateSnapshot: preSnapshot,
      attachments: messageAttachments.length ? messageAttachments : undefined
    }

    this.displayMessages = [...this.displayMessages, userMessage, assistantPlaceholder]
    this.flushPersist(this.displayMessages, options?.executeWaitingPlan ? this.activePlan : null)
    this.notify()

    this.controller.setComposerMode(this.composerMode)
    this.controller.setSessionGoal(this.sessionGoal)

    try {
      await this.controller.send(sendContent)
    } catch {
      this.isLoading = false
      this.agentStatus = ''
      this.onRunningChange?.(false)
      this.notify()
    } finally {
      if (!this.controller.running) {
        if (this.isLoading) {
          this.isLoading = false
          this.agentStatus = ''
          this.onRunningChange?.(false)
          this.notify()
        }
      }
    }
  }

  public async answerClarification(answer: string): Promise<void> {
    const trimmed = answer.trim()
    if (!trimmed || !this.clarificationPending) return
    this.clarificationPending = false
    this.clarificationQuestion = ''
    this.clarificationOptions = []
    this.isLoading = true
    this.agentStatus = '思考中...'
    this.onRunningChange?.(true)
    this.notify()

    try {
      await this.controller.answerClarification(trimmed)
    } catch {
      this.isLoading = false
      this.agentStatus = ''
      this.onRunningChange?.(false)
      this.notify()
    }
  }

  public resolveGuiLayout(entryId: string, layoutJson: string): void {
    this.controller.resolveGuiLayout(entryId, layoutJson)
    this.displayMessages = this.displayMessages.map((m) => {
      if (!m.entries) return m
      const found = m.entries.some((e) => e.kind === 'guiLayoutPreview' && e.id === entryId)
      if (!found) return m
      return {
        ...m,
        entries: m.entries.map((e) =>
          e.kind === 'guiLayoutPreview' && e.id === entryId
            ? { ...e, status: 'confirmed' as const, layoutJson }
            : e
        )
      }
    })
    this.flushPersist(this.displayMessages, this.activePlan)
    this.notify()
  }

  public cancelGuiLayout(entryId: string): void {
    this.controller.cancelGuiLayout(entryId)
    this.displayMessages = this.displayMessages.map((m) => {
      if (!m.entries) return m
      const found = m.entries.some((e) => e.kind === 'guiLayoutPreview' && e.id === entryId)
      if (!found) return m
      return {
        ...m,
        entries: m.entries.map((e) =>
          e.kind === 'guiLayoutPreview' && e.id === entryId
            ? { ...e, status: 'cancelled' as const }
            : e
        )
      }
    })
    this.flushPersist(this.displayMessages, this.activePlan)
    this.notify()
  }

  public async executePlan(): Promise<void> {
    if (this.isLoading || this.controller.running) return
    this.isLoading = true
    this.agentStatus = '执行中...'
    this.planReady = false
    this.onRunningChange?.(true)
    this.notify()
    try {
      await this.controller.startExecuteFromPlan()
    } catch {
      this.isLoading = false
      this.agentStatus = ''
      this.onRunningChange?.(false)
      this.notify()
    }
  }

  public async retryTurn(turnId: string): Promise<void> {
    if (this.isLoading || this.controller.running) return
    const turnIndex = this.displayMessages.findIndex((m) => m.id === turnId)
    if (turnIndex < 0) return

    const truncated = this.displayMessages.slice(0, turnIndex + 1)
    const currentPlan = this.activePlan
    const hasValidPlan = Boolean(
      currentPlan &&
      currentPlan.steps.length > 0 &&
      truncated.some((m) => m.id === currentPlan.anchorMsgId)
    )
    const planToKeep = hasValidPlan ? currentPlan : null

    this.isLoading = true
    this.agentStatus = '思考中...'
    this.activePlan = planToKeep
    this.completionFlash = ''
    this.turn = { msgId: '', entries: [], streamDone: false, collaborationTrace: [] }
    this.displayMessages = truncated
    this.flushPersist(truncated, planToKeep, { resetSystem: true })
    this.notify()

    const serialized = serializeDisplayMessages(truncated, planToKeep)
    void toControllerMessagesWithAttachments(serialized, (p) => window.api.readAttachmentDataUrl(p)).then((msgs) => {
      this.controller.restoreSnapshot(msgs)
      if (planToKeep) {
        this.controller.restorePlanTracker(planToKeep.steps)
      }
    })

    try {
      if (planToKeep) {
        await this.controller.retryExecuteTurn()
      } else {
        await this.controller.retryFromUser()
      }
    } catch {
      this.isLoading = false
      this.agentStatus = ''
      this.onRunningChange?.(false)
      this.notify()
    }
  }

  public feedbackGuiLayout(entryId: string, feedback: string): void {
    this.controller.feedbackGuiLayout(entryId, feedback)
    this.displayMessages = this.displayMessages.map((m) => {
      if (!m.entries) return m
      const found = m.entries.some((e) => e.kind === 'guiLayoutPreview' && e.id === entryId)
      if (!found) return m
      return {
        ...m,
        entries: m.entries.map((e) =>
          e.kind === 'guiLayoutPreview' && e.id === entryId
            ? { ...e, status: 'cancelled' as const }
            : e
        )
      }
    })
    this.flushPersist(this.displayMessages, this.activePlan)
    this.notify()
  }

  public approve(requestId: string, approved: boolean): void {
    this.controller.approve(requestId, approved)
  }

  public async resolveVisualReview(requestId: string, decision: 'accepted' | 'rejected'): Promise<unknown> {
    this.isLoading = true
    this.agentStatus = decision === 'accepted' ? 'recording user_confirmation...' : 'entering product repair...'
    this.onRunningChange?.(true)
    this.notify()
    try {
      const result = await this.controller.resolveVisualReview(requestId, decision)
      if (decision === 'accepted') {
        this.gameTestStatus = null
      }
      return result
    } finally {
      if (!this.controller.running) {
        this.isLoading = false
        this.agentStatus = ''
        this.onRunningChange?.(false)
        this.notify()
      }
    }
  }

  public cancel(): void {
    this.controller.cancel()
    const t = this.turn
    t.streamDone = true
    t.entries = finalizeRunningTools(t.entries, true)
    const planSnapshot = this.activePlan
    const finalSteps = planSnapshot?.steps

    t.entries = ensureClosingSummaryEntry(t.entries, {
      reason: 'cancelled',
      steps: finalSteps,
      sessionGoal: this.sessionGoal,
      error: 'Cancelled'
    })

    this.isLoading = false
    this.agentStatus = ''
    this.clarificationPending = false
    this.onRunningChange?.(false)
    this.setFlash('已停止')

    const anchorId = planSnapshot?.anchorMsgId || t.msgId
    this.displayMessages = this.displayMessages.map((m) => {
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
    this.activePlan = null
    this.flushPersist(this.displayMessages, null)
    t.msgId = ''
    this.notify()
  }

  private handleEvent(event: Event): void {
    if (this.destroyed) return
    const t = this.turn

    void window.api?.automationEmit?.({
      type: 'harness_event',
      sessionId: this.sessionId,
      kind: event.kind,
      phase: event.phase,
      text: event.text?.slice(0, 4_000),
      error: event.error,
      notice: event.notice,
      tool: event.tool ? {
        id: event.tool.id,
        name: event.tool.name,
        args: toolArgsForAutomation(event.tool.name, event.tool.args),
        output: toolOutputForAutomation(event.tool.name, event.tool.output),
        outcome: event.tool.outcome,
        error: event.tool.error,
        durationMs: event.tool.durationMs,
        source: event.tool.source,
        validation: event.tool.validation
      } : undefined,
      planSteps: event.planSteps,
      routeDecision: event.routeDecision,
      collaboration: event.collaboration ? collaborationForAutomation(event.collaboration) : undefined,
      modelInvocation: event.modelInvocation,
      gameTestStatus: event.gameTestStatus
    })

    switch (event.kind) {
      case EventKind.Phase:
        if (event.phase === 'plan_start') {
          if (!t.msgId) {
            t.msgId = uid()
            t.entries = []
            t.streamDone = false
            this.displayMessages = [...this.displayMessages, {
              id: t.msgId, role: 'assistant',
              entries: [], isStreaming: true, timestamp: Date.now(),
              model: this.apiConfig.model, providerId: this.apiConfig.providerId,
              collaborationTrace: [...t.collaborationTrace]
            }]
          } else {
            t.streamDone = false
            this.refreshDisplay()
          }
        } else if (event.phase === 'plan_done') {
          const planText = (event.text || '').trim()
          const actionable = event.planActionable ?? isActionablePlanText(planText)
          if (actionable && planText) {
            const steps = parsePlanSteps(planText)
            if (steps.length > 0 && t.msgId) {
              const planStepList = toPlanSteps(steps.map((s) => ({ ...s, status: 'pending' })))
              const nextPlan = { steps: planStepList, anchorMsgId: t.msgId, pinned: true }
              t.entries = replacePlanEntriesWithSummary(t.entries, steps.length)
              this.activePlan = nextPlan
              this.displayMessages = this.displayMessages.map((m) => (
                m.id === t.msgId ? { ...m, entries: [...t.entries] } : m
              ))
              this.flushPersist(this.displayMessages, nextPlan)
            }
          }
        } else if (event.phase === 'plan_stream_end') {
          if (t.msgId) this.collapseAllReasoning(t.msgId, t.entries)
          this.refreshDisplay()
        } else if (event.phase === 'execute_start') {
          this.agentStatus = '执行中...'
          this.planReady = false
        } else if (event.phase === 'plan_ready') {
          this.planReady = true
        } else if (event.phase === 'clarification_resume') {
          t.streamDone = false
          if (t.msgId) {
            this.displayMessages = this.displayMessages.map((m) => (
              m.id === t.msgId
                ? { ...m, isStreaming: true, turnStatus: undefined }
                : m
            ))
          } else {
            this.refreshDisplay()
          }
        }
        break

      case EventKind.Collaboration: {
        if (event.collaboration) {
          const trace = event.collaboration
          const index = t.collaborationTrace.findIndex((item) => item.id === trace.id)
          if (index >= 0) t.collaborationTrace[index] = trace
          else t.collaborationTrace.push(trace)
          if (t.msgId) {
            this.displayMessages = this.displayMessages.map((message) => message.id === t.msgId
              ? { ...message, collaborationTrace: [...t.collaborationTrace] }
              : message)
          }
        }
        if (event.routeDecision) this.agentStatus = `协作路由：${event.routeDecision.reason}`
        break
      }

      case EventKind.PlanState:
        if (event.planSteps && event.planSteps.length > 0) {
          const nextSteps = toPlanSteps(event.planSteps)
          const nextPlan = this.activePlan
            ? { ...this.activePlan, steps: nextSteps }
            : t.msgId
              ? { steps: nextSteps, anchorMsgId: t.msgId, pinned: true }
              : null
          if (nextPlan) {
            this.activePlan = nextPlan
            this.displayMessages = this.displayMessages.map((m) => (
              m.id === nextPlan.anchorMsgId
                ? { ...m, embeddedPlan: nextSteps }
                : m
            ))
            this.flushPersist(this.displayMessages, nextPlan)
          }
        }
        break

      case EventKind.ClarificationNeeded:
        if (event.clarification) {
          this.clarificationPending = true
          this.clarificationQuestion = event.clarification.question
          this.clarificationOptions = event.clarification.options || []
          this.isLoading = false
          this.agentStatus = ''
          this.onRunningChange?.(false)

          t.streamDone = true
          if (t.msgId) {
            this.collapseAllReasoning(t.msgId, t.entries)
            t.entries = finalizeRunningTools(t.entries, false)
            t.entries = appendClarificationTextEntry(
              t.entries,
              event.clarification.question,
              event.clarification.options || []
            )
            this.displayMessages = this.displayMessages.map((m) => (
              m.id === t.msgId
                ? {
                    ...m,
                    entries: [...t.entries],
                    isStreaming: false,
                    turnStatus: 'answered' as const
                  }
                : m
            ))
            this.flushPersist(this.displayMessages, this.activePlan)
          }
        }
        break

      case EventKind.GameTestStatus:
        if (event.gameTestStatus) {
          this.gameTestStatus = event.gameTestStatus
          this.agentStatus = event.gameTestStatus.message
        }
        break

      case EventKind.GuiLayoutPreview:
        if (event.guiLayout) {
          const gl = event.guiLayout
          if (t.msgId) {
            const layoutEntry: ChronoEntry = {
              kind: 'guiLayoutPreview',
              id: gl.id,
              title: gl.title,
              layoutType: gl.layoutType,
              html: gl.html,
              elements: gl.elements,
              status: 'pending'
            }
            t.entries = [...t.entries, layoutEntry]
            this.displayMessages = this.displayMessages.map((m) => (
              m.id === t.msgId
                ? { ...m, entries: [...t.entries] }
                : m
            ))
            this.flushPersist(this.displayMessages, this.activePlan)
          }
        }
        break

      case EventKind.GuiLayoutPreviewCancelled:
        this.displayMessages = this.displayMessages.map((m) => {
          if (!m.entries) return m
          let msgChanged = false
          const entries = m.entries.map((e) => {
            if (e.kind === 'guiLayoutPreview' && e.status === 'pending') {
              msgChanged = true
              return { ...e, status: 'cancelled' as const }
            }
            return e
          })
          return msgChanged ? { ...m, entries } : m
        })
        this.flushPersist(this.displayMessages, this.activePlan)
        break

      case EventKind.TurnStarted:
        this.turnUsage = { promptTokens: 0, completionTokens: 0 }
        this.onRunningChange?.(true)
        this.usageAccum = {
          ...this.usageAccum,
          turns: this.usageAccum.turns + 1,
          turnTokens: 0,
          turnCacheHitTokens: 0,
          turnCacheMissTokens: 0
        }
        this.onUsageChange?.(this.usageAccum)
        if (!t.msgId) {
          t.msgId = uid()
          t.entries = []
          t.streamDone = false
          this.displayMessages = [...this.displayMessages, {
            id: t.msgId, role: 'assistant',
            entries: [], isStreaming: true, timestamp: Date.now(),
            model: this.apiConfig.model, providerId: this.apiConfig.providerId
          }]
        } else {
          t.streamDone = false
          this.refreshDisplay()
        }
        break

      case EventKind.Reasoning:
        if (event.text) {
          const last = t.entries[t.entries.length - 1]
          if (last?.kind === 'reasoning') {
            last.content += event.text
          } else {
            t.entries.push({ kind: 'reasoning', content: event.text })
          }
          this.refreshDisplay()
        }
        break

      case EventKind.Text:
        if (event.text) {
          this.markLastReasoningDone(t.msgId, t.entries)
          const last = t.entries[t.entries.length - 1]
          if (last?.kind === 'text') {
            last.content += event.text
          } else {
            t.entries.push({ kind: 'text', content: event.text })
          }
          this.refreshDisplay()
        }
        break

      case EventKind.ToolDispatch:
        if (event.tool && event.tool.name) {
          recordToolDispatch(event.tool.name, event.tool.id, event.tool.args as Record<string, unknown> | undefined)
          this.markLastReasoningDone(t.msgId, t.entries)
          const nextCollapsedToolIds = new Set(this.collapsedToolIds)
          if (isExploreTool(event.tool.name)) {
            nextCollapsedToolIds.add(event.tool.id)
          } else {
            nextCollapsedToolIds.delete(event.tool.id)
          }
          this.collapsedToolIds = nextCollapsedToolIds

          const nextCollapsedExplore = new Set(this.collapsedExploreGroupKeys)
          for (const key of collectExploreGroupKeys(t.msgId, t.entries)) {
            nextCollapsedExplore.add(key)
          }
          this.collapsedExploreGroupKeys = nextCollapsedExplore

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
            displayName: getToolLabelZh(event.tool.name, parsedArgs)
          })
          this.refreshDisplay()
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
          this.refreshDisplay()
        }
        break

      case EventKind.ToolResult:
        if (event.tool) {
          if (event.tool.name === 'mc_run_test' && event.tool.validation?.verdict === 'PASS') {
            this.gameTestStatus = null
          }
          recordToolResult(
            event.tool.name || 'unknown',
            event.tool.id,
            event.tool.output || event.tool.error || '',
            { error: Boolean(event.tool.error), durationMs: event.tool.durationMs }
          )
          this.collapsedToolIds = new Set(this.collapsedToolIds).add(event.tool.id)

          const nextCollapsedExp = new Set(this.collapsedExploreGroupKeys)
          for (const key of collectExploreGroupKeys(t.msgId, t.entries)) {
            nextCollapsedExp.add(key)
          }
          this.collapsedExploreGroupKeys = nextCollapsedExp

          let foundEntry = false
          for (const entry of t.entries) {
            if (entry.kind === 'tool' && entry.id === event.tool.id) {
              foundEntry = true
              entry.status = event.tool.outcome === 'timed_out'
                ? 'timed_out'
                : event.tool.outcome === 'cancelled'
                  ? 'cancelled'
                  : event.tool.error ? 'error' : 'done'
              entry.output = event.tool.output || event.tool.error || entry.liveOutput || ''
              entry.liveOutput = undefined
              entry.durationMs = event.tool.durationMs
              if (event.tool.fileDiff) {
                entry.fileDiff = event.tool.fileDiff
              }
              if (event.tool.imageBase64) {
                entry.imageBase64 = event.tool.imageBase64
                entry.imageMimeType = event.tool.imageMimeType
              }
              break
            }
          }

          if (!foundEntry && event.tool.name === 'task_summary_screenshot' && event.tool.imageBase64) {
            t.entries.push({
              kind: 'tool',
              id: event.tool.id,
              name: event.tool.name,
              status: 'done',
              output: event.tool.output || '',
              imageBase64: event.tool.imageBase64,
              imageMimeType: event.tool.imageMimeType,
              displayName: '任务总结截图'
            })
            this.refreshDisplay()
          }

          const output = event.tool.output || ''
          const stepDoneMatch = output.match(/\[STEP_DONE:(\d+)\]/)
          if (stepDoneMatch) {
            const stepIdx = parseInt(stepDoneMatch[1]) - 1
            if (this.activePlan) {
              this.activePlan = {
                ...this.activePlan,
                steps: this.activePlan.steps.map((s, i) =>
                  i === stepIdx ? { ...s, status: 'completed' as const } : s
                )
              }
              this.flushPersist(this.displayMessages, this.activePlan)
            }
          }

          if (t.msgId) {
            this.displayMessages = this.displayMessages.map((m) => (
              m.id === t.msgId ? { ...m, entries: [...t.entries], isStreaming: !t.streamDone } : m
            ))
            this.flushPersist(this.displayMessages, this.activePlan)
          } else {
            this.refreshDisplay()
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
          this.turnUsage = {
            promptTokens: this.turnUsage.promptTokens + pT,
            completionTokens: this.turnUsage.completionTokens + cT
          }
          const costDelta = estimateCostDelta(pT, cT, hit, miss, {
            model: u.modelId || this.apiConfig.model,
            providerId: u.providerId || this.apiConfig.providerId
          })
          // Attribution reads the controller snapshot, i.e. what was really sent.
          // Accounting must never be able to break a run, so failures degrade to none.
          let attribution = this.usageAccum.attribution ?? null
          let attributionHistory = this.usageAccum.attributionHistory ?? []
          if (CONTEXT_ATTRIBUTION_ENABLED && pT > 0) {
            try {
              attribution = buildContextAttribution(this.controller.getSnapshot(), {
                promptTokens: pT,
                windowTokens: workingContextWindow(
                  u.modelId || this.apiConfig.model,
                  u.providerId || this.apiConfig.providerId
                )
              })
              attributionHistory = [...attributionHistory, toContextFrame(attribution)]
                .slice(-CONTEXT_HISTORY_LIMIT)
            } catch {
              attribution = null
            }
          }
          this.usageAccum = {
            ...this.usageAccum,
            sessionTokens: this.usageAccum.sessionTokens + stepTokens,
            turnTokens: this.usageAccum.turnTokens + stepTokens,
            cacheHitTokens: this.usageAccum.cacheHitTokens + hit,
            cacheMissTokens: this.usageAccum.cacheMissTokens + miss,
            turnCacheHitTokens: this.usageAccum.turnCacheHitTokens + hit,
            turnCacheMissTokens: this.usageAccum.turnCacheMissTokens + miss,
            lastPromptTokens: pT,
            contextPercent: contextPercentFromPrompt(pT, this.apiConfig.model, this.apiConfig.providerId),
            cost: this.usageAccum.cost + costDelta,
            attribution,
            attributionHistory
          }
          this.onUsageChange?.(this.usageAccum, costDelta > 0 ? { costDelta } : undefined)
        }
        break

      case EventKind.TurnDone: {
        this.clarificationPending = false
        this.clarificationQuestion = ''
        t.streamDone = true
        if (t.msgId) this.collapseAllReasoning(t.msgId, t.entries)
        const hasError = Boolean(event.error)
        t.entries = finalizeRunningTools(t.entries, hasError)
        if (event.phase === 'plan_failed') {
          this.activePlan = null
        }
        const planSnapshot = event.phase === 'plan_failed' ? null : this.activePlan

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
          composerMode: this.composerMode,
          turnMode: event.turnMode,
          phase: event.phase
        })

        const closingReason: ClosingReason = turnStatus
        t.entries = ensureClosingSummaryEntry(t.entries, {
          reason: closingReason,
          steps: finalSteps,
          sessionGoal: this.sessionGoal,
          error: event.error
        })

        this.isLoading = false
        this.agentStatus = ''
        this.onRunningChange?.(false)

        if (!hasError && finalPlanDone) {
          this.setFlash('任务已完成')
          void window.api?.notifyTaskComplete?.()
        } else if (hasError || turnStatus === 'error') {
          this.setFlash('异常结束')
        } else if (!hasError && turnStatus === 'planned') {
          this.setFlash('计划已就绪')
          this.planReady = true
        } else if (!hasError && turnStatus === 'answered') {
          this.setFlash('')
        } else if (!hasError && (turnStatus === 'partial' || (!finalPlanDone && finalSteps?.length))) {
          this.setFlash('任务部分完成')
        }

        this.onUsageChange?.(this.usageAccum)

        const anchorId = planSnapshot?.anchorMsgId || t.msgId
        const fileChanges = t.entries
          .filter((e) => e.kind === 'tool' && ['write_file', 'edit_file'].includes(e.name || ''))
          .map((e) => {
            const diff = (e as { fileDiff?: { path: string; oldContent?: string; action?: 'create' | 'update' | 'delete' } }).fileDiff
            if (!diff) return null
            return {
              path: diff.path,
              oldContent: diff.oldContent,
              action: diff.action
            } satisfies TurnFileChange
          })
          .filter((c): c is TurnFileChange => c !== null)

        const resolvedAnchorId = anchorId || t.msgId
        let next = this.displayMessages.map((m) => {
          if (m.isStreaming || m.id === anchorId || m.id === t.msgId) {
            const isAnchor = m.id === anchorId || m.id === t.msgId
            return {
              ...m,
              ...(isAnchor ? { entries: [...t.entries] } : {}),
              isStreaming: false,
              ...(isAnchor ? {
                turnStatus,
                embeddedPlan: event.phase === 'plan_failed'
                  ? undefined
                  : (finalSteps && finalSteps.length > 0 ? finalSteps : m.embeddedPlan)
              } : {})
            }
          }
          return m
        })

        if (resolvedAnchorId) {
          next = enrichUserSnapshotAfterTurnDone(next, resolvedAnchorId, fileChanges, {
            planTrackerSteps: planSnapshot?.steps.map((s) => ({
              id: s.id,
              description: s.description,
              status: s.status
            })),
            phase: event.phase === 'plan' ? 'plan' : 'execute',
            activePlan: planSnapshot ? { ...planSnapshot, steps: [...planSnapshot.steps] } : undefined
          })
        }

        this.displayMessages = next
        this.activePlan = turnStatus === 'planned' || turnStatus === 'partial' ? planSnapshot : null
        this.flushPersist(
          this.displayMessages,
          turnStatus === 'planned' || turnStatus === 'partial' ? planSnapshot : null
        )
        t.msgId = ''
        break
      }

      case EventKind.Notice:
        if (event.notice) {
          if (event.notice.level === 'error') {
            this.flushPersist(this.displayMessages, this.activePlan, {
              appendSystem: [{ role: 'system', content: event.notice.text, timestamp: Date.now() }]
            })
          } else if (event.notice.level === 'warn') {
            this.agentStatus = event.notice.text
          }
        }
        break
    }

    this.notify()
  }

  private setFlash(msg: string): void {
    this.completionFlash = msg
    if (this.completionFlashTimer) window.clearTimeout(this.completionFlashTimer)
    if (msg) {
      this.completionFlashTimer = window.setTimeout(() => {
        this.completionFlash = ''
        this.notify()
      }, 3000)
    }
  }

  public destroy(): void {
    this.destroyed = true
    if (this.completionFlashTimer) window.clearTimeout(this.completionFlashTimer)
    this.listeners.clear()
    this.controller.cancel()
  }
}

export type GlobalSessionListener = (event: {
  sessionId: string
  running: boolean
  clarificationPending: boolean
}) => void

export class SessionRuntimeManager {
  private static instance: SessionRuntimeManager | null = null
  private runtimes = new Map<string, SessionRuntime>()
  private globalListeners = new Set<GlobalSessionListener>()
  private sharedRegistry: Registry

  private constructor() {
    this.sharedRegistry = new Registry()
    registerModCraftingTools(this.sharedRegistry)
  }

  public static getInstance(): SessionRuntimeManager {
    if (!SessionRuntimeManager.instance) {
      SessionRuntimeManager.instance = new SessionRuntimeManager()
    }
    return SessionRuntimeManager.instance
  }

  public getOrCreateRuntime(opts: SessionRuntimeInitOptions): SessionRuntime {
    let runtime = this.runtimes.get(opts.sessionId)
    if (!runtime) {
      runtime = new SessionRuntime(opts, this.sharedRegistry)
      this.runtimes.set(opts.sessionId, runtime)
    } else {
      runtime.projectPath = opts.projectPath
      runtime.apiConfig = opts.apiConfig
      runtime.routingConfig = opts.routingConfig
      runtime.routingSelection = opts.routingSelection
      runtime.resolveRoutingModel = opts.resolveRoutingModel
      runtime.onPersistSession = opts.onPersistSession
      runtime.onUpdateSessionMeta = opts.onUpdateSessionMeta
      runtime.onUsageChange = opts.onUsageChange
      runtime.onRunningChange = opts.onRunningChange
      runtime.controller.setProjectPath(opts.projectPath)
      runtime.controller.setApiConfig(opts.apiConfig)
      runtime.controller.setRouting(opts.routingConfig, opts.routingSelection, opts.resolveRoutingModel)
    }
    return runtime
  }

  public getRuntime(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId)
  }

  public destroyRuntime(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (runtime) {
      runtime.destroy()
      this.runtimes.delete(sessionId)
      this.notifyGlobalStatus(sessionId, false, false)
    }
  }

  public getRunningSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const [id, rt] of this.runtimes.entries()) {
      if (rt.isLoading || rt.controller.running) {
        ids.add(id)
      }
    }
    return ids
  }

  public getClarificationPendingSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const [id, rt] of this.runtimes.entries()) {
      if (rt.clarificationPending) {
        ids.add(id)
      }
    }
    return ids
  }

  public hasRunningAgentSession(
    projectPath: string | null,
    excludeSessionId?: string
  ): { running: boolean; sessionId?: string; composerMode?: ComposerMode } {
    if (!projectPath) return { running: false }
    for (const [id, rt] of this.runtimes.entries()) {
      if (excludeSessionId && id === excludeSessionId) continue
      if (rt.projectPath === projectPath && (rt.isLoading || rt.controller.running)) {
        if (rt.composerMode === 'agent') {
          return { running: true, sessionId: id, composerMode: rt.composerMode }
        }
      }
    }
    return { running: false }
  }

  public subscribeGlobal(listener: GlobalSessionListener): () => void {
    this.globalListeners.add(listener)
    return () => {
      this.globalListeners.delete(listener)
    }
  }

  public notifyGlobalStatus(sessionId: string, running: boolean, clarificationPending: boolean): void {
    for (const listener of this.globalListeners) {
      try {
        listener({ sessionId, running, clarificationPending })
      } catch (err) {
        console.error('GlobalSessionListener error:', err)
      }
    }
  }

  public async reloadTools(): Promise<void> {
    const registry = new Registry()
    let disabled: string[] = []
    try {
      const cfg = await window.api.loadAgentConfig()
      disabled = cfg.disabledTools || []
    } catch {
      // ignore
    }
    registerModCraftingTools(registry, { disabledTools: disabled })
    this.sharedRegistry = registry
    for (const rt of this.runtimes.values()) {
      rt.controller.setRegistry(registry)
    }
  }
}
