import type { PlanStep } from '../components/TaskPlan'
import type { ComposerMode } from '../harness/turn-intent'
import type { ChatMessage } from '../harness/chat-message'
import type { MessageAttachment } from '../context/context-ingress'
import type { GuiLayoutElement, GuiLayoutType } from '../harness/events'

export interface ActivePlan {
  steps: PlanStep[]
  anchorMsgId: string
  pinned: boolean
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  content?: string
  firstAdded?: string
  firstRemoved?: string
  oldContent?: string
  action?: 'create' | 'update' | 'delete'
}

export interface FileSnapshot {
  path: string
  content: string
  timestamp: number
}

export interface SessionStateSnapshot {
  messageIndex: number
  controllerMessages: ChatMessage[]
  planTrackerSteps?: PlanStep[]
  phase: 'plan' | 'execute'
  composerMode: ComposerMode
  sessionGoal: string
  activePlan?: ActivePlan
  fileSnapshots: FileSnapshot[]
}

export interface ChronoEntryTool {
  kind: 'tool'
  id: string
  name: string
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string
  liveOutput?: string
  durationMs?: number
  startMs?: number
  args?: Record<string, unknown>
  fileDiff?: FileDiff
  displayName?: string
  /** 截图图片数据（mc_screenshot 等工具返回；供 UI 展示） */
  imageBase64?: string
  imageMimeType?: string
}

export interface ChronoEntryGuiLayout {
  kind: 'guiLayoutPreview'
  id: string
  title: string
  layoutType: GuiLayoutType
  html: string
  elements: GuiLayoutElement[]
  status: 'pending' | 'confirmed' | 'cancelled'
  layoutJson?: string
}

export type ChronoEntry =
  | { kind: 'reasoning'; content: string; done?: boolean }
  | { kind: 'text'; content: string }
  | ChronoEntryTool
  | ChronoEntryGuiLayout

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  entries?: ChronoEntry[]
  isStreaming?: boolean
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'
  embeddedPlan?: PlanStep[]
  timestamp: number
  stateSnapshot?: SessionStateSnapshot
  attachments?: MessageAttachment[]
}
