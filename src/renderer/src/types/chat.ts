import type { PlanStep } from '../components/TaskPlan'
import type { UsageStats } from '../utils/usage'
import type { MessageAttachment } from '../context/context-ingress'
import type { GuiLayoutElement, GuiLayoutType } from '../harness/events'
import type { CollaborationTrace, RoutingSelection } from '../../../shared/model-routing.ts'

export interface PersistedChronoEntry {
  kind: 'reasoning' | 'text' | 'tool' | 'guiLayoutPreview'
  content?: string
  id?: string
  name?: string
  status?: 'pending' | 'running' | 'done' | 'error'
  output?: string
  durationMs?: number
  done?: boolean
  startMs?: number
  displayName?: string
  args?: Record<string, unknown>
  fileDiff?: {
    path: string
    added: number
    removed: number
    content?: string
    firstAdded?: string
    firstRemoved?: string
    oldContent?: string
    action?: 'create' | 'update' | 'delete'
  }
  // guiLayoutPreview fields
  title?: string
  layoutType?: GuiLayoutType
  html?: string
  elements?: GuiLayoutElement[]
  layoutJson?: string
}

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  entries?: PersistedChronoEntry[]
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'
  embeddedPlan?: PlanStep[]
  timestamp?: number
  displayId?: string
  stateSnapshot?: any
  attachments?: MessageAttachment[]
  /** assistant 消息实际使用的模型名称（跨会话持久化） */
  model?: string
  /** assistant 消息实际使用的 Provider ID */
  providerId?: string
  collaborationTrace?: CollaborationTrace[]
}

export interface ChatSession {
  id: string
  name: string
  messages: PersistedMessage[]
  createdAt: number
  updatedAt: number
  usage?: UsageStats
  composerMode?: 'agent' | 'plan' | 'ask'
  sessionGoal?: string
  routingSelection?: RoutingSelection
}
