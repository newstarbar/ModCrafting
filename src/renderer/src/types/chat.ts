import type { PlanStep } from '../components/TaskPlan'
import type { UsageStats } from '../utils/usage'

export interface PersistedChronoEntry {
  kind: 'reasoning' | 'text' | 'tool'
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
}
