import type { PlanStep } from '../components/TaskPlan'

export interface PersistedChronoEntry {
  kind: 'reasoning' | 'text' | 'tool'
  content?: string
  id?: string
  name?: string
  status?: 'pending' | 'running' | 'done' | 'error'
  output?: string
  durationMs?: number
  done?: boolean
}

export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  entries?: PersistedChronoEntry[]
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled'
  embeddedPlan?: PlanStep[]
  timestamp?: number
  displayId?: string
}

export interface ChatSession {
  id: string
  name: string
  messages: PersistedMessage[]
  createdAt: number
  updatedAt: number
}
