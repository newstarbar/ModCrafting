// @ts-nocheck
import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import appIcon from '../../../../packaging/appIcon.png'
import TaskPlan from './TaskPlan'
import type { PlanStep } from './TaskPlan'
import { isNumberedPlanText } from '../utils/plan-steps'
import { buildSessionMarkdown } from '../utils/session-export-md'
import SessionExportPanel from './SessionExportPanel'
import { EMPTY_USAGE, type UsageStats } from '../utils/usage'
import type { ChatSession, PersistedMessage } from '../types/chat'
import {
  serializeDisplayMessages,
  toControllerMessagesWithAttachments
} from '../utils/chat-persist'
import { groupMessagesIntoTurns } from '../utils/chat-turns'
import type { ChatTurn } from '../utils/chat-turns'
import { isDefaultSessionName, sessionTitleFromMessage } from '../utils/session-title'
import type { DisplayMessage, ChronoEntry } from '../types/display-message'
import ChatComposer from './ChatComposer'
import type { ComposerMode } from '../harness/turn-intent'
import ImageLightbox, { copyImageToClipboard } from './ImageLightbox'
import MarkdownContent from './MarkdownContent'
import MessageFooter from './MessageFooter'
import TemplateFormPanel from './TemplateFormPanel'
import { buildTemplateParamsFromForm, isQuickCreateTemplate, quickCreateSessionGoal } from '../project/template-params'
import { executeTemplateGenerate, resolveProjectConfig } from '../project/template-runner'
import { isCodeExplainInput } from '../harness/turn-intent'
import RollbackWarningPanel from './RollbackWarningPanel'
import DeleteMessagePanel from './DeleteMessagePanel'
import ClarificationOverlay from './ClarificationOverlay'
import GuiLayoutPreviewPanel from './GuiLayoutPreviewPanel'
import ConcurrentAgentConfirmModal from './ConcurrentAgentConfirmModal'
import { removeMessageFromDisplay } from '../utils/message-delete'
import { messagePlainText } from '../utils/message-text'
import { shouldShowPinnedPlan } from '../utils/plan-visibility'
import ToolExploreGroup from './ToolExploreGroup'
import { groupExploreToolRuns, isExploreTool } from '../utils/tool-explore-group'
import { extractPreview } from '../utils/tool-output-preview'
import { KnowledgeHitTags, hasKnowledgeHitTags } from './KnowledgeHitTags'
import type { ComposerAttachment, ContextPayload, MessageAttachment } from '../context/context-ingress'
import {
  attachmentToMessageAttachment,
  hasImageAttachment,
  mimeFromPath,
  newAttachmentId,
  payloadToAttachment
} from '../context/context-ingress'
import { isVisionCapableModel } from '../harness/chat-message'
import { type ContextChipData, getChipLabel } from './ContextChip'
import type { ModelRef, ModelRoutingConfig, RoutingSelection } from '../../../shared/model-routing'
import type { GameTestWorkflowStatus } from '../harness/game-test-protocol'
import { SessionRuntimeManager, SessionRuntime, type ActivePlan } from '../harness/session-runtime'
import { getToolLabelZh } from '../harness/tool-labels'

interface ChatPanelProps {
  projectPath: string | null
  contextQueue: ContextPayload[]
  setContextQueue: (queue: ContextPayload[]) => void
  selectedFile: { path: string; name: string } | null
  apiConfig: { endpoint: string; apiKey: string; model: string; providerId: string }
  ensureApiKey?: () => Promise<string | null>
  onUsageChange?: (usage: UsageStats, meta?: { costDelta?: number }) => void
  onRunningChange?: (running: boolean) => void
  currentSessionId: string | null
  sessions: ChatSession[]
  onPersistSession: (sessionId: string, messages: PersistedMessage[]) => void
  onNewSession: (firstMessage?: string, attachments?: MessageAttachment[]) => string
  onRenameSession: (id: string, name: string) => void
  toolchainReady?: boolean
  onUpdateSessionMeta?: (sessionId: string, meta: { composerMode?: ComposerMode; sessionGoal?: string }) => void
  onTemplateSelect?: (templateId: string, name: string) => void
  onProviderModelChange?: (selection: { providerId: string; modelId: string; endpoint: string }) => void
  onOpenApiSettings?: () => void
  onOpenAdvancedRouting?: () => void
  savedProviderIds?: string[]
  routingConfig?: ModelRoutingConfig
  routingSelection?: RoutingSelection
  resolveRoutingModel?: (model: ModelRef) => Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string } | null>
  onRoutingSelectionChange?: (selection: RoutingSelection) => void
}

function UserAttachmentImage({ path, name }: { path: string; name?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.readAttachmentDataUrl(path).then((r) => {
      if (!cancelled && r.ok) setSrc(r.dataUrl)
    })
    return () => { cancelled = true }
  }, [path])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const flash = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(''), 1600)
  }, [])

  if (!src) return <span className="chat-bubble-attachments__file">{name || '图片'}</span>

  return (
    <>
      <button
        type="button"
        className="chat-bubble-attachments__img-btn"
        title="点击放大预览"
        onClick={() => setLightboxOpen(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <img src={src} alt={name || '附件图片'} />
      </button>
      {lightboxOpen && (
        <ImageLightbox
          src={src}
          path={path}
          name={name}
          onClose={() => setLightboxOpen(false)}
        />
      )}
      {menu && (
        <div
          className="attachment-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              setLightboxOpen(true)
            }}
          >
            放大预览
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void copyImageToClipboard(src).then((ok) => flash(ok ? '已复制图片' : '复制失败'))
            }}
          >
            复制图片
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void navigator.clipboard.writeText(path).then(
                () => flash('已复制路径'),
                () => flash('复制失败')
              )
            }}
          >
            复制路径
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void window.api.saveAttachmentAs(path, name).then((r) => {
                if (r.cancelled) return
                flash(r.ok ? '已保存' : (r.error || '保存失败'))
              })
            }}
          >
            另存为
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void window.api.showItemInFolder(path).then((r) => {
                flash(r.success ? '已打开所在文件夹' : (r.error || '打开失败'))
              })
            }}
          >
            在文件夹中显示
          </button>
        </div>
      )}
      {toast ? <div className="attachment-toast">{toast}</div> : null}
    </>
  )
}

function getToolDisplayName(name: string, args?: Record<string, unknown>): string {
  return getToolLabelZh(name, args)
}

interface ChatPanelRef {
  handleTemplateSelect: (templateId: string, name: string) => void
  automationSend: (text: string, mode?: ComposerMode) => Promise<Record<string, unknown>>
  automationSnapshot: () => Record<string, unknown>
  automationCancel: () => void
  automationRespond: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const ChatPanel = forwardRef<ChatPanelRef, ChatPanelProps>(function ChatPanel({
  projectPath,
  contextQueue,
  setContextQueue,
  selectedFile: _selectedFile,
  apiConfig,
  ensureApiKey,
  onUsageChange,
  onRunningChange,
  currentSessionId,
  sessions,
  onPersistSession,
  onNewSession,
  onRenameSession,
  toolchainReady = true,
  onUpdateSessionMeta,
  onProviderModelChange,
  onOpenApiSettings,
  onOpenAdvancedRouting,
  savedProviderIds,
  routingConfig,
  routingSelection,
  resolveRoutingModel,
  onRoutingSelectionChange
}, ref) {
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const [contextChips, setContextChips] = useState<ContextChipData[]>([])
  const contextChipsRef = useRef(contextChips)
  contextChipsRef.current = contextChips
  const [composerMode, setComposerMode] = useState<ComposerMode>('agent')
  const composerModeRef = useRef<ComposerMode>('agent')
  composerModeRef.current = composerMode
  const [sessionGoal, setSessionGoal] = useState('')
  const sessionGoalRef = useRef(sessionGoal)
  sessionGoalRef.current = sessionGoal
  const [planReady, setPlanReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [agentStatus, setAgentStatus] = useState('')
  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const [collapsedToolIds, setCollapsedToolIds] = useState<Set<string>>(new Set())
  const [collapsedExploreGroupKeys, setCollapsedExploreGroupKeys] = useState<Set<string>>(new Set())
  const [collapsedReasoningKeys, setCollapsedReasoningKeys] = useState<Set<string>>(new Set())
  const [runTick, setRunTick] = useState(0)
  const toolOutputRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [usageAccum, setUsageAccum] = useState<UsageStats>(EMPTY_USAGE)
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const activePlanRef = useRef<ActivePlan | null>(null)
  activePlanRef.current = activePlan
  const [completionFlash, setCompletionFlash] = useState('')
  const completionFlashTimerRef = useRef<number | null>(null)
  const [clarificationPending, setClarificationPending] = useState(false)
  const [clarificationQuestion, setClarificationQuestion] = useState('')
  const [clarificationOptions, setClarificationOptions] = useState<string[]>([])
  const [gameTestStatus, setGameTestStatus] = useState<GameTestWorkflowStatus | null>(null)
  const clarificationPendingRef = useRef(false)
  clarificationPendingRef.current = clarificationPending

  const [showExportPanel, setShowExportPanel] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [showTemplateForm, setShowTemplateForm] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [rollbackWarning, setRollbackWarning] = useState<{ msgId: string; content: string; fileCount: number } | null>(null)
  const [deletePending, setDeletePending] = useState<{ msgId: string; role: 'user' | 'assistant'; preview: string } | null>(null)
  const [toolScreenshotLightbox, setToolScreenshotLightbox] = useState<{ src: string; name: string } | null>(null)
  const [concurrentAgentModal, setConcurrentAgentModal] = useState<{
    open: boolean
    runningSessionName: string
    onConfirm: () => void
  }>({ open: false, runningSessionName: '', onConfirm: () => {} })

  const onPersistSessionRef = useRef(onPersistSession)
  onPersistSessionRef.current = onPersistSession
  const onUpdateSessionMetaRef = useRef(onUpdateSessionMeta)
  onUpdateSessionMetaRef.current = onUpdateSessionMeta
  const onRunningChangeRef = useRef(onRunningChange)
  onRunningChangeRef.current = onRunningChange
  const onUsageChangeRef = useRef(onUsageChange)
  onUsageChangeRef.current = onUsageChange
  const apiConfigRef = useRef(apiConfig)
  apiConfigRef.current = apiConfig

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

  // Listen to config saves and reload tool registry globally
  useEffect(() => {
    const onConfigSaved = (): void => {
      void SessionRuntimeManager.getInstance().reloadTools()
    }
    window.addEventListener('agent-config-saved', onConfigSaved)
    return () => {
      window.removeEventListener('agent-config-saved', onConfigSaved)
    }
  }, [])

  // Helper to obtain current active runtime
  const getActiveRuntime = useCallback((): SessionRuntime | null => {
    const sid = currentSessionIdRef.current
    if (!sid) return null
    return SessionRuntimeManager.getInstance().getOrCreateRuntime({
      sessionId: sid,
      projectPath,
      apiConfig,
      routingConfig,
      routingSelection,
      resolveRoutingModel,
      onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
      onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
      onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
      onRunningChange: (r) => onRunningChangeRef.current?.(r)
    })
  }, [projectPath, apiConfig, routingConfig, routingSelection, resolveRoutingModel])

  // Subscribe to current session's runtime
  useEffect(() => {
    if (!currentSessionId) {
      setDisplayMessages([])
      setActivePlan(null)
      setIsLoading(false)
      setAgentStatus('')
      setPlanReady(false)
      setUsageAccum(EMPTY_USAGE)
      setClarificationPending(false)
      setGameTestStatus(null)
      onRunningChangeRef.current?.(false)
      onUsageChangeRef.current?.(EMPTY_USAGE)
      return
    }

    const session = sessionsRef.current.find((s) => s.id === currentSessionId)
    const runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
      sessionId: currentSessionId,
      projectPath,
      apiConfig,
      routingConfig,
      routingSelection,
      resolveRoutingModel,
      onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
      onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
      onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
      onRunningChange: (r) => onRunningChangeRef.current?.(r)
    })

    if (session) {
      runtime.hydrateFromSession(session)
    }

    const unsubscribe = runtime.subscribe((snapshot) => {
      setDisplayMessages(snapshot.displayMessages)
      setActivePlan(snapshot.activePlan)
      setIsLoading(snapshot.isLoading)
      setAgentStatus(snapshot.agentStatus)
      setPlanReady(snapshot.planReady)
      setComposerMode(snapshot.composerMode)
      setSessionGoal(snapshot.sessionGoal)
      setUsageAccum(snapshot.usageAccum)
      setCompletionFlash(snapshot.completionFlash)
      setClarificationPending(snapshot.clarificationPending)
      setClarificationQuestion(snapshot.clarificationQuestion)
      setClarificationOptions(snapshot.clarificationOptions)
      setGameTestStatus(snapshot.gameTestStatus)
      setCollapsedToolIds(snapshot.collapsedToolIds)
      setCollapsedExploreGroupKeys(snapshot.collapsedExploreGroupKeys)
      setCollapsedReasoningKeys(snapshot.collapsedReasoningKeys)
    })

    return () => {
      unsubscribe()
    }
  }, [currentSessionId, projectPath, apiConfig, routingConfig, routingSelection, resolveRoutingModel])

  // Watch for external context injected via ContextIngress (crash, code explain, game HUD, …)
  const contextConsumedRef = useRef(0)
  useEffect(() => {
    if (contextQueue.length <= contextConsumedRef.current) return
    const newItems = contextQueue.slice(contextConsumedRef.current)
    contextConsumedRef.current = contextQueue.length

    const textParts: string[] = []
    const nextAtts: ComposerAttachment[] = []
    const newChips: ContextChipData[] = []
    for (const item of newItems) {
      if (item.kind === 'text') {
        if (item.tag) {
          newChips.push({
            id: newAttachmentId(),
            type: item.tag.type,
            label: item.tag.label || getChipLabel(item.tag.type),
            text: item.text
          })
          if (item.tag.type === 'code-explain') {
            setComposerMode('ask')
            composerModeRef.current = 'ask'
            getActiveRuntime()?.setComposerMode('ask')
          }
        } else {
          textParts.push(item.text)
        }
      } else {
        const att = payloadToAttachment(item, newAttachmentId())
        if (att) nextAtts.push(att)
      }
    }
    if (nextAtts.length) {
      setAttachments((prev) => [...prev, ...nextAtts])
    }
    if (newChips.length) {
      setContextChips((prev) => [...prev, ...newChips])
    }
    if (textParts.length) {
      const text = textParts.join('\n\n')
      if (textParts.some((item) => isCodeExplainInput(item))) {
        setComposerMode('ask')
        composerModeRef.current = 'ask'
        getActiveRuntime()?.setComposerMode('ask')
      }
      const prefix = textParts.some((item) => isCodeExplainInput(item)) && !text.includes('请解释')
        ? '请解释以下代码：\n\n'
        : ''
      setInput((prev) => (prev ? `${prev}\n\n${prefix}${text}` : `${prefix}${text}`))
    }
    setContextQueue([])
    contextConsumedRef.current = 0
  }, [contextQueue, setContextQueue, getActiveRuntime])

  // Game HUD / external push → ContextIngress
  useEffect(() => {
    if (!window.api?.onContextPush) return
    return window.api.onContextPush((payload) => {
      if (payload.kind === 'text' && payload.text) {
        const text = payload.text
        if (isCodeExplainInput(text)) {
          setComposerMode('ask')
          composerModeRef.current = 'ask'
          getActiveRuntime()?.setComposerMode('ask')
        }
        setInput((prev) => (prev ? `${prev}\n\n${text}` : text))
        return
      }
      if (payload.kind === 'image' && payload.path) {
        const imagePath = payload.path
        setAttachments((prev) => [
          ...prev,
          {
            id: newAttachmentId(),
            kind: 'image',
            path: imagePath,
            mimeType: payload.mimeType || mimeFromPath(imagePath),
            name: payload.name,
            previewUrl: undefined
          }
        ])
        void window.api.readAttachmentDataUrl(imagePath).then((r) => {
          if (!r.ok) return
          setAttachments((prev) =>
            prev.map((a) => (a.kind === 'image' && a.path === imagePath ? { ...a, previewUrl: r.dataUrl } : a))
          )
        })
        return
      }
      if (payload.kind === 'file' && payload.path) {
        setAttachments((prev) => [
          ...prev,
          {
            id: newAttachmentId(),
            kind: 'file',
            path: payload.path,
            name: payload.name
          }
        ])
      }
    })
  }, [getActiveRuntime])

  const handleAttachFiles = useCallback(async () => {
    if (!window.api?.openAttachmentDialog) return
    const result = await window.api.openAttachmentDialog()
    if (result.cancelled || !result.files.length) return
    const newAtts: ComposerAttachment[] = result.files.map((f) => ({
      id: newAttachmentId(),
      kind: f.kind,
      path: f.path,
      name: f.name,
      mimeType: f.mimeType
    }))
    setAttachments((prev) => [...prev, ...newAtts])
    for (const att of newAtts) {
      if (att.kind !== 'image') continue
      void window.api.readAttachmentDataUrl(att.path).then((r) => {
        if (!r.ok) return
        setAttachments((prev) =>
          prev.map((a) => (a.id === att.id ? { ...a, previewUrl: r.dataUrl } : a))
        )
      })
    }
  }, [])

  const handlePasteFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const isImg = file.type.startsWith('image/')
      const name = file.name || (isImg ? 'pasted-image.png' : 'pasted-file')
      const buffer = await file.arrayBuffer()
      const saved = await window.api.savePastedAttachment(name, buffer)
      if (!saved.ok || !saved.path) continue

      const att: ComposerAttachment = {
        id: newAttachmentId(),
        kind: isImg ? 'image' : 'file',
        path: saved.path,
        name,
        mimeType: file.type || (isImg ? 'image/png' : 'application/octet-stream')
      }
      setAttachments((prev) => [...prev, att])
      if (isImg) {
        void window.api.readAttachmentDataUrl(saved.path).then((r) => {
          if (!r.ok) return
          setAttachments((prev) =>
            prev.map((a) => (a.id === att.id ? { ...a, previewUrl: r.dataUrl } : a))
          )
        })
      }
    }
  }, [])

  const handleDropFiles = useCallback(async (paths: string[]) => {
    if (!window.api?.inspectDroppedPaths) return
    const inspected = await window.api.inspectDroppedPaths(paths)
    if (!inspected.length) return
    const newAtts: ComposerAttachment[] = inspected.map((f) => ({
      id: newAttachmentId(),
      kind: f.kind,
      path: f.path,
      name: f.name,
      mimeType: f.mimeType
    }))
    setAttachments((prev) => [...prev, ...newAtts])
    for (const att of newAtts) {
      if (att.kind !== 'image') continue
      void window.api.readAttachmentDataUrl(att.path).then((r) => {
        if (!r.ok) return
        setAttachments((prev) =>
          prev.map((a) => (a.id === att.id ? { ...a, previewUrl: r.dataUrl } : a))
        )
      })
    }
  }, [])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleRemoveContextChip = useCallback((id: string) => {
    setContextChips((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const toggleToolOutput = useCallback((id: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.toggleToolOutput(id)
    } else {
      setCollapsedToolIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }, [getActiveRuntime])

  const toggleExploreGroup = useCallback((key: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.toggleExploreGroup(key)
    } else {
      setCollapsedExploreGroupKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }
  }, [getActiveRuntime])

  const toggleReasoning = useCallback((key: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.toggleReasoning(key)
    } else {
      setCollapsedReasoningKeys((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }
  }, [getActiveRuntime])

  const maybeRenameSessionForFirstMessage = useCallback((sessionId: string, messageText: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session || !isDefaultSessionName(session.name)) return
    const hasUserMessage = session.messages.some((m) => m.role === 'user')
      || displayMessages.some((m) => m.role === 'user')
    if (hasUserMessage) return
    const title = sessionTitleFromMessage(messageText)
    if (title) onRenameSession(sessionId, title)
  }, [sessions, displayMessages, onRenameSession])

  const executeSend = useCallback(async (
    userMsg: string,
    messageAttachments: MessageAttachment[],
    imageDataUrls: Map<string, string>,
    executeWaitingPlan: boolean
  ) => {
    let sid = currentSessionIdRef.current
    let runtime: SessionRuntime
    if (!sid) {
      const newId = onNewSession(
        userMsg || (messageAttachments.length ? '（附件）' : ''),
        messageAttachments.length ? messageAttachments : undefined
      )
      sid = newId
      currentSessionIdRef.current = newId
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: newId,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
      runtime.setComposerMode(composerModeRef.current)
      runtime.setSessionGoal(sessionGoalRef.current)
    } else {
      maybeRenameSessionForFirstMessage(sid, userMsg || '（附件）')
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: sid,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
    }

    await runtime.send(userMsg, messageAttachments, imageDataUrls, { executeWaitingPlan })
  }, [projectPath, apiConfig, routingConfig, routingSelection, resolveRoutingModel, onNewSession, maybeRenameSessionForFirstMessage])

  const handleSend = useCallback(async () => {
    const pendingAttachments = attachmentsRef.current
    const pendingChips = contextChipsRef.current
    const hasText = Boolean(input.trim())
    const hasAtt = pendingAttachments.length > 0
    const hasChips = pendingChips.length > 0
    if ((!hasText && !hasAtt && !hasChips) || isLoading || !toolchainReady) return
    if (clarificationPending) return
    if (hasImageAttachment(pendingAttachments) && !isVisionCapableModel(apiConfig.model, apiConfig.providerId)) {
      alert('当前模型不支持图片理解，请移除图片或切换到视觉模型后再发送')
      return
    }

    const resolvedKey = ensureApiKey
      ? await ensureApiKey()
      : apiConfig.apiKey.trim()
    if (!resolvedKey) {
      alert('请先配置 API Key（左侧「设置」→ 保存密钥）')
      return
    }

    const sid = currentSessionIdRef.current
    const currentRuntime = sid ? getActiveRuntime() : null
    if (currentRuntime && (currentRuntime.isLoading || currentRuntime.controller.running)) {
      setAgentStatus('上一轮仍在执行，请稍候或先停止')
      return
    }

    // 聚合标签：chip 文本前置到用户输入前面
    const chipText = pendingChips.map((c) => c.text).join('\n\n')
    const inputText = input.trim()
    const userMsg = chipText && inputText
      ? `${chipText}\n\n${inputText}`
      : chipText || inputText
    const messageAttachments: MessageAttachment[] = pendingAttachments.map(attachmentToMessageAttachment)
    const imageDataUrls = new Map<string, string>()
    for (const att of messageAttachments) {
      if (att.kind !== 'image') continue
      const loaded = await window.api.readAttachmentDataUrl(att.path)
      if (loaded.ok) imageDataUrls.set(att.path, loaded.dataUrl)
    }

    const executeWaitingPlan =
      planReady
      && /^(执行计划|开始执行|执行)[\s!！。.?？~，,]*$/i.test(userMsg)
      && Boolean(activePlanRef.current?.steps?.length)

    setInput('')
    setAttachments([])
    setContextChips([])

    // Concurrency check for Agent mode
    if (composerMode === 'agent') {
      const runningCheck = SessionRuntimeManager.getInstance().hasRunningAgentSession(projectPath, sid || undefined)
      if (runningCheck.running && runningCheck.sessionId) {
        const otherSessionName = sessions.find((s) => s.id === runningCheck.sessionId)?.name || '未命名会话'
        setConcurrentAgentModal({
          open: true,
          runningSessionName: otherSessionName,
          onConfirm: () => {
            setConcurrentAgentModal({ open: false, runningSessionName: '', onConfirm: () => {} })
            void executeSend(userMsg, messageAttachments, imageDataUrls, executeWaitingPlan)
          }
        })
        return
      }
    }

    await executeSend(userMsg, messageAttachments, imageDataUrls, executeWaitingPlan)
  }, [input, isLoading, toolchainReady, clarificationPending, apiConfig, ensureApiKey, getActiveRuntime, planReady, composerMode, projectPath, sessions, executeSend])

  const handleClarificationConfirm = useCallback(async (answer: string) => {
    const trimmed = answer.trim()
    if (!trimmed || isLoading || !clarificationPending) return
    const runtime = getActiveRuntime()
    if (runtime) {
      await runtime.answerClarification(trimmed)
    }
  }, [isLoading, clarificationPending, getActiveRuntime])

  const handleGuiLayoutConfirm = useCallback((entryId: string, layoutJson: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.resolveGuiLayout(entryId, layoutJson)
    }
  }, [getActiveRuntime])

  const handleGuiLayoutCancel = useCallback((entryId: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.cancelGuiLayout(entryId)
    }
  }, [getActiveRuntime])

  const handleGuiLayoutFeedback = useCallback((entryId: string, feedback: string) => {
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.feedbackGuiLayout(entryId, feedback)
    }
  }, [getActiveRuntime])

  const handleExecutePlan = useCallback(async () => {
    if (isLoading || !toolchainReady) return
    const runtime = getActiveRuntime()
    if (!runtime) return
    await runtime.executePlan()
  }, [isLoading, toolchainReady, getActiveRuntime])

  const handleTemplateSelect = useCallback((templateId: string, _name: string) => {
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

  const handleTemplateFormConfirm = useCallback(async (result: { prompt: string; templateId: string; formData: Record<string, unknown> }) => {
    setShowTemplateForm(false)
    setContextQueue([])

    let prompt = result.prompt
    if (isQuickCreateTemplate(result.templateId) && projectPath) {
      const config = await resolveProjectConfig(projectPath)
      if (config) {
        const params = buildTemplateParamsFromForm(result.templateId, result.formData)
        const gen = await executeTemplateGenerate({
          projectPath,
          templateId: params.templateId,
          name: params.name,
          displayName: params.displayName,
          formFields: params.formFields,
          config
        })
        prompt = gen.message
      }
    }

    const quickCreate = isQuickCreateTemplate(result.templateId)
    const nextSessionGoal = quickCreate ? quickCreateSessionGoal(prompt) : sessionGoal
    if (quickCreate) {
      setSessionGoal(nextSessionGoal)
      const sid = currentSessionIdRef.current
      if (sid) onUpdateSessionMetaRef.current?.(sid, { sessionGoal: nextSessionGoal })
    }

    let sid = currentSessionIdRef.current
    let runtime: SessionRuntime
    if (!sid) {
      const newId = onNewSession(prompt)
      sid = newId
      currentSessionIdRef.current = newId
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: newId,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
      runtime.setComposerMode(composerModeRef.current)
      runtime.setSessionGoal(nextSessionGoal)
    } else {
      maybeRenameSessionForFirstMessage(sid, prompt)
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: sid,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
      if (quickCreate) {
        runtime.controller.clearSession()
      }
      runtime.setComposerMode(composerMode)
      runtime.setSessionGoal(nextSessionGoal)
    }

    await runtime.send(prompt, [], new Map())
  }, [projectPath, sessionGoal, composerMode, onNewSession, maybeRenameSessionForFirstMessage, apiConfig, routingConfig, routingSelection, resolveRoutingModel, setContextQueue])

  const handleTemplateFormCancel = useCallback(() => {
    setShowTemplateForm(false)
    setSelectedTemplateId('')
  }, [])

  const automationSend = useCallback(async (text: string, mode: ComposerMode = 'agent') => {
    const prompt = text.trim()
    if (!prompt) throw new Error('empty_prompt')
    const sid = currentSessionIdRef.current
    let runtime: SessionRuntime
    if (!sid) {
      const newId = onNewSession(prompt)
      currentSessionIdRef.current = newId
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: newId,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
      runtime.setComposerMode(mode)
    } else {
      runtime = SessionRuntimeManager.getInstance().getOrCreateRuntime({
        sessionId: sid,
        projectPath,
        apiConfig,
        routingConfig,
        routingSelection,
        resolveRoutingModel,
        onPersistSession: (id, msgs) => onPersistSessionRef.current(id, msgs),
        onUpdateSessionMeta: (id, meta) => onUpdateSessionMetaRef.current?.(id, meta),
        onUsageChange: (u, m) => onUsageChangeRef.current?.(u, m),
        onRunningChange: (r) => onRunningChangeRef.current?.(r)
      })
      runtime.setComposerMode(mode)
    }
    if (runtime.isLoading || runtime.controller.running) throw new Error('turn_already_running')
    const resolvedKey = ensureApiKey ? await ensureApiKey() : apiConfig.apiKey.trim()
    if (!resolvedKey) throw new Error('api_key_unavailable')
    runtime.setApiConfig({ ...apiConfig, apiKey: resolvedKey })
    setComposerMode(mode)
    void runtime.send(prompt, [], new Map()).catch(() => {})
    return { accepted: true, ...runtime.controller.getAutomationSnapshot() }
  }, [apiConfig, ensureApiKey, projectPath, routingConfig, routingSelection, resolveRoutingModel, onNewSession])

  const automationSnapshot = useCallback(() => {
    const runtime = getActiveRuntime()
    return {
      controller: runtime?.controller.getAutomationSnapshot() || null,
      ui: {
        isLoading,
        agentStatus,
        composerMode,
        planReady,
        messageCount: displayMessages.length,
        activeAssistantStreaming: Boolean(
          [...displayMessages].reverse().find((message) => message.role === 'assistant')?.isStreaming
        ),
        activePlan: activePlanRef.current,
        guiLayout: [...displayMessages].reverse().flatMap((message) => [...(message.entries || [])].reverse())
          .find((entry) => entry.kind === 'guiLayoutPreview' && entry.status === 'pending') || null,
        clarification: clarificationPending
          ? { question: clarificationQuestion, options: clarificationOptions }
          : null,
        gameTestStatus
      }
    }
  }, [getActiveRuntime, isLoading, agentStatus, composerMode, planReady, displayMessages, clarificationPending, clarificationQuestion, clarificationOptions, gameTestStatus])

  const automationCancel = useCallback(() => {
    getActiveRuntime()?.cancel()
  }, [getActiveRuntime])

  const automationRespond = useCallback(async (params: Record<string, unknown>) => {
    const runtime = getActiveRuntime()
    if (!runtime) throw new Error('controller_unavailable')
    const requestId = String(params.requestId || '')
    const action = String(params.action || '')
    if (!action || (action !== 'clarify' && !requestId)) throw new Error('invalid_response')
    if (action === 'approve' || action === 'deny') {
      runtime.approve(requestId, action === 'approve')
      return { accepted: true }
    }
    if (action === 'clarify') {
      const answer = String(params.value || '').trim()
      if (!answer || !clarificationPendingRef.current) throw new Error('clarification_not_pending')
      void runtime.answerClarification(answer)
      return { accepted: true }
    }
    if (action === 'gui_layout') {
      runtime.resolveGuiLayout(requestId, String(params.value || '{}'))
      return { accepted: true }
    }
    if (action === 'visual_review') {
      const decision = String(params.decision || params.value || '').toLowerCase()
      if (decision !== 'accepted' && decision !== 'rejected') throw new Error('invalid_visual_review_decision')
      const result = await runtime.resolveVisualReview(requestId, decision as 'accepted' | 'rejected')
      return { accepted: true, result }
    }
    throw new Error('unsupported_response_action')
  }, [getActiveRuntime])

  useImperativeHandle(ref, () => ({
    handleTemplateSelect,
    automationSend,
    automationSnapshot,
    automationCancel,
    automationRespond
  }), [handleTemplateSelect, automationSend, automationSnapshot, automationCancel, automationRespond])

  const handleComposerModeChange = useCallback((mode: ComposerMode) => {
    setComposerMode(mode)
    const runtime = getActiveRuntime()
    if (runtime) runtime.setComposerMode(mode)
  }, [getActiveRuntime])

  const handleSessionGoalChange = useCallback((goal: string) => {
    setSessionGoal(goal)
    const runtime = getActiveRuntime()
    if (runtime) runtime.setSessionGoal(goal)
  }, [getActiveRuntime])

  const handleCancel = useCallback(() => {
    const runtime = getActiveRuntime()
    if (runtime) runtime.cancel()
  }, [getActiveRuntime])

  const handleRetryTurn = useCallback(async (turnId: string) => {
    if (isLoading) return
    const resolvedKey = ensureApiKey
      ? await ensureApiKey()
      : apiConfig.apiKey.trim()
    if (!resolvedKey) {
      alert('请先配置 API Key（左侧「设置」→ 保存密钥）')
      return
    }
    const runtime = getActiveRuntime()
    if (!runtime) return
    if (resolvedKey !== apiConfig.apiKey) {
      runtime.setApiConfig({ ...apiConfig, apiKey: resolvedKey })
    }
    await runtime.retryTurn(turnId)
  }, [isLoading, ensureApiKey, apiConfig, getActiveRuntime])

  const handleRollback = useCallback((msgId: string) => {
    if (isLoading) return
    const msgIndex = displayMessages.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return
    const targetMsg = displayMessages[msgIndex]
    const snapshot = targetMsg.stateSnapshot
    if (!snapshot) {
      setCompletionFlash('无法回滚：该消息缺少状态快照')
      if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
      completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
      return
    }
    setRollbackWarning({
      msgId,
      content: targetMsg.content,
      fileCount: snapshot.fileSnapshots.length
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
    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.controller.restoreSnapshot(snapshot.controllerMessages)
      runtime.setComposerMode(snapshot.composerMode)
      runtime.setSessionGoal(snapshot.sessionGoal)
      runtime.controller.restorePlanTracker(snapshot.planTrackerSteps ?? [])
      runtime.displayMessages = restoredMessages
      runtime.activePlan = snapshot.activePlan || null
      runtime.planReady = Boolean(snapshot.activePlan?.steps.length)
      runtime.collapsedToolIds = new Set()
      runtime.collapsedReasoningKeys = new Set()
      runtime.flushPersist(restoredMessages, snapshot.activePlan || null)
      runtime.notify()
    }

    setInput(messageContent)
    if (projectPath) {
      window.api.listDirectory(projectPath)
    }

    setCompletionFlash('已回滚')
    if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
    completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
  }, [rollbackWarning, displayMessages, projectPath, getActiveRuntime])

  const handleRollbackCancel = useCallback(() => {
    setRollbackWarning(null)
  }, [])

  const handleDeleteMessage = useCallback((msgId: string) => {
    if (isLoading) return
    const msgIndex = displayMessages.findIndex((m) => m.id === msgId)
    if (msgIndex === -1) return
    const targetMsg = displayMessages[msgIndex]
    const preview = messagePlainText(targetMsg).slice(0, 200) || '(无文本内容)'
    setDeletePending({
      msgId,
      role: targetMsg.role,
      preview
    })
  }, [isLoading, displayMessages])

  const handleDeleteConfirm = useCallback(() => {
    if (!deletePending) return
    const { msgId } = deletePending
    setDeletePending(null)
    const { next, removedIds } = removeMessageFromDisplay(displayMessages, msgId)

    let nextPlan = activePlanRef.current
    if (nextPlan && removedIds.includes(nextPlan.anchorMsgId)) {
      nextPlan = null
    }

    const runtime = getActiveRuntime()
    if (runtime) {
      runtime.displayMessages = next
      runtime.activePlan = nextPlan
      runtime.planReady = Boolean(nextPlan?.steps.length)
      const serialized = serializeDisplayMessages(next, nextPlan)
      void toControllerMessagesWithAttachments(serialized, (p) => window.api.readAttachmentDataUrl(p)).then((msgs) => {
        runtime.controller.restoreSnapshot(msgs)
        runtime.controller.restorePlanTracker([])
      })
      runtime.flushPersist(next, nextPlan)
      runtime.notify()
    }

    setCompletionFlash('已删除')
    if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
    completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
  }, [deletePending, displayMessages, getActiveRuntime])

  const handleDeleteCancel = useCallback(() => {
    setDeletePending(null)
  }, [])

  // ======== RENDER ========
  const renderContent = (content: string) => <MarkdownContent content={content} />

  const renderMessage = (msg: DisplayMessage, turn: ChatTurn) => {
    const isUser = msg.role === 'user'
    const showActivity = !isUser && isLoading && msg.isStreaming && turn.assistant?.id === msg.id
    const activityLabel = agentStatus.trim() || 'AI 正在处理，请稍候…'
    const activityElapsed = Math.max(1, Math.floor((Date.now() - msg.timestamp) / 1000))
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
              <img src={appIcon} alt="" />
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
            <>
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="chat-bubble-attachments">
                  {msg.attachments.map((att, i) =>
                    att.kind === 'image' ? (
                      <UserAttachmentImage key={`${att.path}-${i}`} path={att.path} name={att.name} />
                    ) : (
                      <span key={`${att.path}-${i}`} className="chat-bubble-attachments__file" title={att.path}>
                        {att.name || att.path.split(/[/\\]/).pop()}
                      </span>
                    )
                  )}
                </div>
              )}
              {msg.content ? <div>{renderContent(msg.content)}</div> : null}
            </>
          )}
          {!isUser && (
            <>
              {msg.embeddedPlan && msg.embeddedPlan.length > 0
                && !(shouldShowPinnedPlan(activePlan, displayMessages, planReady)
                  && activePlan?.anchorMsgId === msg.id) && (
                <TaskPlan steps={msg.embeddedPlan} variant="anchored" defaultCollapsed />
              )}
              {msg.entries && msg.entries.length === 0 && msg.isStreaming && (
                <span className="mc-dim" style={{ fontSize: '12px', fontStyle: 'italic' }}>思考中...</span>
              )}
              {msg.entries && msg.entries.length > 0 && groupExploreToolRuns(msg.id, msg.entries).map((segment) => {
                if (segment.type === 'explore-group') {
                  return (
                    <ToolExploreGroup
                      key={segment.key}
                      kind={segment.kind}
                      groupKey={segment.key}
                      tools={segment.tools}
                      reasoningCount={segment.reasoningCount}
                      collapsed={collapsedExploreGroupKeys.has(segment.key)}
                      collapsedToolIds={collapsedToolIds}
                      runTick={runTick}
                      onToggleGroup={toggleExploreGroup}
                      onToggleTool={toggleToolOutput}
                      getToolDisplayName={getToolDisplayName}
                    />
                  )
                }

                if (segment.type === 'tool') {
                  const entry = segment.entry
                  const isCollapsed = collapsedToolIds.has(entry.id)
                  const displayOutput = entry.liveOutput || entry.output
                  const elapsedSec = entry.startMs && entry.status === 'running'
                    ? Math.max(1, Math.floor((Date.now() - entry.startMs) / 1000))
                    : null
                  const statusMark =
                    entry.status === 'done' ? <span className="tool-status-dot done" />
                      : entry.status === 'running' ? <span className="tool-status-dot running" />
                        : entry.status === 'error' ? <span className="tool-status-dot error" />
                          : entry.status === 'timed_out' ? <span className="tool-status-dot error" title="已超时" />
                            : entry.status === 'cancelled' ? <span className="tool-status-dot pending" title="已取消" />
                          : <span className="tool-status-dot pending" />
                  const displayName = entry.displayName || getToolDisplayName(entry.name, entry.args)
                  const diff = entry.fileDiff
                  const showDiffStats = diff && (diff.added > 0 || diff.removed > 0)
                  const showDiffPreview = diff && (diff.firstAdded || diff.firstRemoved) && !isCollapsed
                  const targetPath = diff?.path
                    || (typeof entry.args?.path === 'string' ? entry.args.path : undefined)
                    || undefined
                  const showPathTag = targetPath && ['done', 'error', 'timed_out', 'cancelled'].includes(entry.status)
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
                      {(['done', 'error', 'timed_out', 'cancelled'].includes(entry.status)) && displayOutput && (
                        <>
                          {isCollapsed && (
                            hasKnowledgeHitTags(displayOutput) ? (
                              <KnowledgeHitTags output={displayOutput} className="kh-hit-tags--inline" maxTrails={2} />
                            ) : (
                              <span className="tool-line-preview" title={displayOutput}>
                                {extractPreview(entry.name, displayOutput, entry.args)}
                              </span>
                            )
                          )}
                          <span
                            className="tool-line-toggle"
                            onClick={() => toggleToolOutput(entry.id)}
                          >
                            {isCollapsed ? '展开 ▶' : '收起 ▲'}
                          </span>
                        </>
                      )}
                      {entry.status === 'running' && !isExploreTool(entry.name) && (
                        <span
                          className="tool-line-toggle mc-dim"
                          onClick={() => toggleToolOutput(entry.id)}
                        >
                          {isCollapsed ? '展开日志 ▶' : '收起 ▲'}
                        </span>
                      )}
                      {entry.status === 'running' && isExploreTool(entry.name) && isCollapsed && (
                        hasKnowledgeHitTags(displayOutput || '') ? (
                          <KnowledgeHitTags output={displayOutput || ''} className="kh-hit-tags--inline" maxTrails={2} />
                        ) : (
                          <span className="tool-line-preview" title={displayOutput || ''}>
                            {displayOutput
                              ? extractPreview(entry.name, displayOutput, entry.args)
                              : pathFileName || '…'}
                          </span>
                        )
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
                      {!isCollapsed && (displayOutput || entry.status === 'running' || entry.imageBase64) && (
                        <div
                          className="tool-line-output"
                          ref={(el) => {
                            if (el) toolOutputRefs.current.set(entry.id, el)
                            else toolOutputRefs.current.delete(entry.id)
                          }}
                        >
                          {displayOutput && hasKnowledgeHitTags(displayOutput) && (
                            <div className="kh-hit-tags-block">
                              <KnowledgeHitTags output={displayOutput} maxTrails={4} />
                            </div>
                          )}
                          {(displayOutput || entry.status === 'running') && (
                            <pre className={['error', 'timed_out'].includes(entry.status) ? 'is-error' : undefined}>
                              {displayOutput || '正在执行，等待实时日志…'}
                            </pre>
                          )}
                          {entry.imageBase64 && entry.status === 'done' && (
                            <div className="tool-screenshot-preview">
                              <button
                                type="button"
                                className="tool-screenshot-preview__btn"
                                title="点击放大预览"
                                onClick={() => setToolScreenshotLightbox({
                                  src: `data:${entry.imageMimeType || 'image/png'};base64,${entry.imageBase64}`,
                                  name: `${displayName || entry.name} 截图`
                                })}
                              >
                                <img
                                  src={`data:${entry.imageMimeType || 'image/png'};base64,${entry.imageBase64}`}
                                  alt="测试截图"
                                  className="tool-screenshot-preview__img"
                                />
                                <span className="tool-screenshot-preview__hint">点击放大</span>
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                }

                const entry = segment.entry
                const i = segment.index
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
                  case 'guiLayoutPreview': {
                    const layoutEntry = entry
                    return (
                      <div key={`gl-${i}`} className="chrono-entry-gui-layout">
                        <GuiLayoutPreviewPanel
                          entry={layoutEntry}
                          disabled={layoutEntry.status !== 'pending'}
                          onConfirm={(layoutJson) => handleGuiLayoutConfirm(layoutEntry.id, layoutJson)}
                          onCancel={() => handleGuiLayoutCancel(layoutEntry.id)}
                          onFeedback={(feedback) => handleGuiLayoutFeedback(layoutEntry.id, feedback)}
                        />
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
              {showActivity && (
                <div className="assistant-activity" role="status" aria-live="polite">
                  <span className="assistant-activity__dots" aria-hidden="true"><i /><i /><i /></span>
                  <span className="assistant-activity__label">{activityLabel}</span>
                  <span className="assistant-activity__elapsed">已进行 {activityElapsed}s</span>
                </div>
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
          onDelete={handleDeleteMessage}
          canRollback={displayMessages.indexOf(msg) < displayMessages.length - 1 && Boolean(msg.stateSnapshot)}
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
            title="导出诊断用 Markdown（勾选轮次，由近到远）"
            onClick={() => setShowExportPanel(true)}
          >导出</button>
          {completionFlash ? (
            <span className="chat-header-status chat-header-status--done">{completionFlash}</span>
          ) : agentStatus ? (
            <span className="chat-header-status">{agentStatus}</span>
          ) : null}
        </div>
      </div>
      <div className="chat-messages" ref={chatMessagesRef} onScroll={handleScroll}>
        {shouldShowPinnedPlan(activePlan, displayMessages, planReady) && activePlan && (
          <div className="chat-plan-sticky">
            <TaskPlan steps={activePlan.steps} variant="anchored" defaultCollapsed />
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
        {gameTestStatus && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginBottom: 8,
              padding: '9px 12px',
              borderRadius: 8,
              border: `1px solid ${gameTestStatus.state === 'terminal' ? 'var(--danger, #d55)' : 'var(--border, #3b4350)'}`,
              background: gameTestStatus.state === 'terminal' ? 'rgba(180, 56, 56, .12)' : 'rgba(75, 110, 160, .12)',
              color: 'var(--text-primary, #e8edf2)',
              fontSize: 12,
              lineHeight: 1.45
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {gameTestStatus.state === 'evidence_repair' ? '正在修订测试契约并生成新场景' :
                gameTestStatus.state === 'environment_recovery' ? 'Observer 环境恢复中' :
                gameTestStatus.code === 'REPLAY_REQUIRED' ? '首次 PASS，正在重启后独立复测' :
                  gameTestStatus.state === 'replay_cleanup' ? '客观断言首次失败，正在清理复测' :
                    gameTestStatus.state === 'product_repair' ? '断言确认失败，正在修复产品' :
                      gameTestStatus.state === 'visual_review' ? '等待专用视觉审核' : '测试环境不可用，已结束为 INCONCLUSIVE'}
            </div>
            <div>{gameTestStatus.message}</div>
            <div style={{ opacity: .72, marginTop: 2 }}>
              {gameTestStatus.currentCheckpoint ? ` · checkpoint ${gameTestStatus.currentCheckpoint}` : ''}
              {gameTestStatus.scenarioRevision ? ` · revision ${gameTestStatus.scenarioRevision}` : ''}
              {gameTestStatus.observerSessionId ? ` · Observer ${gameTestStatus.observerSessionId.slice(0, 8)}` : ''}
              {gameTestStatus.variantFingerprint ? ` · variant ${gameTestStatus.variantFingerprint.slice(0, 12)}` : ''}
              {gameTestStatus.code} · scenario {gameTestStatus.scenarioId || 'unknown'}
              {gameTestStatus.repairAttempt ? ` · 修订 ${gameTestStatus.repairAttempt}/3` : ''}
              {gameTestStatus.environmentAttempt ? ` · 恢复 ${gameTestStatus.environmentAttempt}/2` : ''}
              {gameTestStatus.passCount && gameTestStatus.requiredPassCount ? ` · PASS ${gameTestStatus.passCount}/${gameTestStatus.requiredPassCount}` : ''}
            </div>
            {gameTestStatus.state === 'visual_review' && gameTestStatus.reviewPrompt && (
              <div style={{ marginTop: 8, padding: '7px 8px', borderRadius: 6, background: 'rgba(0, 0, 0, .14)', whiteSpace: 'pre-wrap' }}>
                {gameTestStatus.reviewPrompt}
              </div>
            )}
            {gameTestStatus.state === 'visual_review' && gameTestStatus.reviewScreenshot && (
              <img
                src={`data:${gameTestStatus.reviewScreenshot.mimeType};base64,${gameTestStatus.reviewScreenshot.base64}`}
                alt="游戏测试视觉审核截图"
                style={{ display: 'block', width: '100%', maxHeight: 260, objectFit: 'contain', marginTop: 8, borderRadius: 6, background: '#101318' }}
              />
            )}
            {gameTestStatus.state === 'visual_review' && !gameTestStatus.reviewDecision && gameTestStatus.reviewId && (
              <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => { void automationRespond({ action: 'visual_review', requestId: gameTestStatus.reviewId, decision: 'accepted' }) }}
                  style={{ padding: '5px 13px', borderRadius: 6, border: '1px solid var(--accent, #4ea1ff)', background: 'var(--accent, #4ea1ff)', color: '#fff', cursor: isLoading ? 'default' : 'pointer' }}
                >接受</button>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => { void automationRespond({ action: 'visual_review', requestId: gameTestStatus.reviewId, decision: 'rejected' }) }}
                  style={{ padding: '5px 13px', borderRadius: 6, border: '1px solid var(--danger, #d55)', background: 'transparent', color: 'var(--danger, #d55)', cursor: isLoading ? 'default' : 'pointer' }}
                >拒绝并修复</button>
              </div>
            )}
          </div>
        )}
        {clarificationPending ? (
          <ClarificationOverlay
            question={clarificationQuestion}
            options={clarificationOptions}
            disabled={isLoading}
            onConfirm={(answer) => { void handleClarificationConfirm(answer) }}
          />
        ) : (
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
            providerId={apiConfig.providerId}
            modelId={apiConfig.model}
            onProviderModelChange={onProviderModelChange ?? (() => {})}
            onOpenApiSettings={onOpenApiSettings}
            onOpenAdvancedRouting={onOpenAdvancedRouting}
            savedProviderIds={savedProviderIds}
            routingConfig={routingConfig}
            routingSelection={routingSelection}
            onRoutingSelectionChange={onRoutingSelectionChange}
            onQuickTemplateSelect={handleTemplateSelect}
            attachments={attachments}
            onRemoveAttachment={handleRemoveAttachment}
            onAttachFiles={handleAttachFiles}
            onPasteFiles={handlePasteFiles}
            onDropFiles={handleDropFiles}
            chips={contextChips}
            onRemoveChip={handleRemoveContextChip}
          />
        )}
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
    {deletePending && (
      <DeleteMessagePanel
        role={deletePending.role}
        preview={deletePending.preview}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    )}
    {toolScreenshotLightbox && (
      <ImageLightbox
        src={toolScreenshotLightbox.src}
        path=""
        name={toolScreenshotLightbox.name}
        onClose={() => setToolScreenshotLightbox(null)}
      />
    )}
    {showExportPanel && (
      <SessionExportPanel
        turns={groupMessagesIntoTurns(displayMessages)}
        disabled={exportBusy}
        onCancel={() => {
          if (exportBusy) return
          setShowExportPanel(false)
        }}
        onConfirm={async (selectedTurnIds) => {
          setExportBusy(true)
          try {
            const allTurns = groupMessagesIntoTurns(displayMessages)
            const idSet = new Set(selectedTurnIds)
            const selectedTurns = allTurns.filter((t) => idSet.has(t.id))
            const goal =
              sessionGoalRef.current.trim() ||
              (activePlan?.steps?.length
                ? activePlan.steps.map((s) => s.description).join('；')
                : '')
            const ctrl = getActiveRuntime()?.controller
            const latestEmbeddedPlan = [...displayMessages]
              .reverse()
              .find((m) => m.role === 'assistant' && m.embeddedPlan && m.embeddedPlan.length > 0)
              ?.embeddedPlan
            const md = buildSessionMarkdown({
              messages: displayMessages,
              turns: selectedTurns,
              order: 'newest-first',
              sessionGoal: goal,
              projectPath,
              model: apiConfig.model,
              endpoint: apiConfig.endpoint,
              providerId: apiConfig.providerId,
              composerMode,
              phase: ctrl?.phase,
              activePlanSteps: activePlan?.steps?.length
                ? activePlan.steps
                : latestEmbeddedPlan,
              controllerMessages: ctrl?.getSnapshot().map((message) =>
                message.reasoningContent
                  ? { ...message, reasoningContent: `[reasoning ${message.reasoningContent.length} chars]` }
                  : message
              ),
              classifierDiagnostics: ctrl?.getClassifierDiagnosticsSnapshot(),
              providerProtocolDiagnostics: ctrl?.getProviderProtocolDiagnosticsSnapshot(),
            })
            const result = await window.api.sessionExport(md, 'mc-session-diag')
            if (result.cancelled) return
            if (result.success) {
              setShowExportPanel(false)
              setCompletionFlash(`已导出: ${result.name}`)
              if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
              completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
            } else {
              setCompletionFlash('导出失败')
              if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
              completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
            }
          } catch {
            setCompletionFlash('导出失败')
            if (completionFlashTimerRef.current) window.clearTimeout(completionFlashTimerRef.current)
            completionFlashTimerRef.current = window.setTimeout(() => setCompletionFlash(''), 3000)
          } finally {
            setExportBusy(false)
          }
        }}
      />
    )}
    {concurrentAgentModal.open && (
      <ConcurrentAgentConfirmModal
        runningSessionName={concurrentAgentModal.runningSessionName}
        onConfirm={concurrentAgentModal.onConfirm}
        onCancel={() => setConcurrentAgentModal({ open: false, runningSessionName: '', onConfirm: () => {} })}
      />
    )}
    </>
  )
})

export default ChatPanel
