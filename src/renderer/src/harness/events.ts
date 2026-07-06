// ======== Event System ========
// Ported from Reasonix internal/event/event.go

import { logger } from '../utils/logger.ts'

// Event kinds
export const EventKind = {
  TurnStarted: 'TurnStarted',
  Reasoning: 'Reasoning',
  Text: 'Text',
  Message: 'Message',
  ToolDispatch: 'ToolDispatch',
  ToolProgress: 'ToolProgress',
  ToolResult: 'ToolResult',
  Usage: 'Usage',
  Notice: 'Notice',
  Phase: 'Phase',
  PlanState: 'PlanState',
  ApprovalRequest: 'ApprovalRequest',
  AskRequest: 'AskRequest',
  TurnDone: 'TurnDone',
  CompactionStarted: 'CompactionStarted',
  CompactionDone: 'CompactionDone',
  Retrying: 'Retrying',
  Steer: 'Steer'
} as const

export type EventKind = (typeof EventKind)[keyof typeof EventKind]

// Tool event payload
export interface ToolEvent {
  id: string
  name: string
  args: string // raw JSON string
  partial?: boolean
  readOnly?: boolean
  output?: string
  error?: string
  truncated?: boolean
  durationMs?: number
  fileDiff?: FileDiff
}

export interface FileDiff {
  path: string
  added: number
  removed: number
  content?: string
  firstAdded?: string
  firstRemoved?: string
}

// Approval payload
export interface Approval {
  id: string
  tool: string
  subject: string
}

// Ask payload
export interface Ask {
  id: string
  questions: AskQuestion[]
}

export interface AskQuestion {
  header: string
  question: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface AskAnswer {
  label: string
}

// Usage payload
export interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  finishReason?: string
}

// Compaction payload
export interface Compaction {
  trigger: string
  messagesBefore: number
  messagesAfter: number
}

// Notice
export type NoticeLevel = 'info' | 'warn' | 'error'

// Full event
export interface Event {
  kind: EventKind
  text?: string
  reasoning?: string
  tool?: ToolEvent
  usage?: Usage
  approval?: Approval
  ask?: Ask
  notice?: { level: NoticeLevel; text: string }
  error?: string
  compaction?: Compaction
  retryAttempt?: number
  retryMax?: number
  phase?: string
  planSteps?: Array<{ id: string; description: string; status: string }>
  turnMode?: 'chat' | 'develop' | 'plan_only' | 'resume'
  composerMode?: 'agent' | 'plan' | 'ask'
}

// Sink interface — same contract as Reasonix event.Sink
export interface Sink {
  emit(event: Event): void
}

// FuncSink adapter: wraps a function as a Sink
export class FuncSink implements Sink {
  private fn: (event: Event) => void

  constructor(fn: (event: Event) => void) {
    this.fn = fn
  }

  emit(event: Event): void {
    this.fn(event)
  }
}

// DiscardSink: drops all events
export const DiscardSink: Sink = { emit: () => {} }

// AccumulatorSink: collects events for testing
export class AccumulatorSink implements Sink {
  events: Event[] = []
  emit(event: Event): void {
    this.events.push(event)
  }
  clear(): void { this.events = [] }
}

// LoggerSink: wraps a Sink with console logging
export class LoggerSink implements Sink {
  private inner: Sink

  constructor(inner: Sink) {
    this.inner = inner
  }

  emit(event: Event): void {
    const skipKinds: EventKind[] = [EventKind.Reasoning, EventKind.Text]
    if (!skipKinds.includes(event.kind)) {
      const detail =
        event.text?.slice(0, 120) ||
        event.tool?.name ||
        event.approval?.tool ||
        event.phase ||
        event.notice?.text ||
        ''
      const toolArgs = event.tool?.args?.trim()
      let parsedArgs: unknown
      if (toolArgs) {
        try { parsedArgs = JSON.parse(toolArgs) } catch { parsedArgs = toolArgs }
      }
      logger.stream(`[${event.kind}] ${detail}`, parsedArgs)
    }
    this.inner.emit(event)
  }
}
