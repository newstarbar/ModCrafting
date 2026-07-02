import type { PlanStep } from '../components/TaskPlan'

export type ChronoEntry =
  | { kind: 'reasoning'; content: string; done?: boolean }
  | { kind: 'text'; content: string }
  | {
      kind: 'tool'
      id: string
      name: string
      status: 'pending' | 'running' | 'done' | 'error'
      output?: string
      liveOutput?: string
      durationMs?: number
      startMs?: number
    }

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  entries?: ChronoEntry[]
  isStreaming?: boolean
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled'
  embeddedPlan?: PlanStep[]
  timestamp: number
}
