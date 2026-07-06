import type { PlanStep } from '../components/TaskPlan'

export interface FileDiff {
  path: string
  added: number
  removed: number
  content?: string
  firstAdded?: string
  firstRemoved?: string
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
}

export type ChronoEntry =
  | { kind: 'reasoning'; content: string; done?: boolean }
  | { kind: 'text'; content: string }
  | ChronoEntryTool

export interface DisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  entries?: ChronoEntry[]
  isStreaming?: boolean
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'
  embeddedPlan?: PlanStep[]
  timestamp: number
}
