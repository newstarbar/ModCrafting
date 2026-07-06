import type { PlanStep } from '../components/TaskPlan'
import type { PersistedChronoEntry, PersistedMessage } from '../types/chat'

export interface SerializableChronoEntry {
  kind: 'reasoning' | 'text' | 'tool'
  content?: string
  id?: string
  name?: string
  status?: 'pending' | 'running' | 'done' | 'error'
  output?: string
  liveOutput?: string
  durationMs?: number
  done?: boolean
  startMs?: number
}

export interface SerializableDisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  entries?: SerializableChronoEntry[]
  isStreaming?: boolean
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'
  embeddedPlan?: PlanStep[]
  timestamp: number
}

export interface ActivePlanSnapshot {
  steps: PlanStep[]
  anchorMsgId: string
  pinned: boolean
}

function entriesToContent(entries: PersistedChronoEntry[]): string {
  return entries
    .filter((e) => e.kind === 'text' || e.kind === 'reasoning')
    .map((e) => e.content ?? '')
    .join('\n')
}

export function serializeDisplayMessages(
  messages: SerializableDisplayMessage[],
  activePlan: ActivePlanSnapshot | null
): PersistedMessage[] {
  return messages.map((m) => {
    const persisted: PersistedMessage = {
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      displayId: m.id,
      turnStatus: m.turnStatus,
      embeddedPlan: m.embeddedPlan
    }

    if (m.entries && m.entries.length > 0) {
      persisted.entries = m.entries.map((e): PersistedChronoEntry => {
        if (e.kind === 'tool') {
          const status = e.status === 'running' ? 'done' : e.status
          return {
            kind: 'tool',
            id: e.id,
            name: e.name,
            status,
            output: e.output || e.liveOutput,
            durationMs: e.durationMs
          }
        }
        if (e.kind === 'reasoning') {
          return { kind: 'reasoning', content: e.content, done: e.done ?? true }
        }
        return { kind: 'text', content: e.content }
      })
      const fromEntries = entriesToContent(persisted.entries)
      if (fromEntries.trim()) persisted.content = fromEntries
    }

    if (activePlan?.pinned && activePlan.anchorMsgId === m.id && activePlan.steps.length > 0) {
      persisted.embeddedPlan = activePlan.steps
    }

    return persisted
  })
}

export function deserializeToDisplay(
  messages: PersistedMessage[],
  newId: () => string
): SerializableDisplayMessage[] {
  const seen = new Set<string>()
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      let id = m.displayId || newId()
      if (seen.has(id)) id = newId()
      seen.add(id)
      return {
        id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        entries: m.entries as SerializableChronoEntry[] | undefined,
        turnStatus: m.turnStatus,
        embeddedPlan: m.embeddedPlan,
        timestamp: m.timestamp ?? Date.now(),
        isStreaming: false
      }
    })
}

export function buildRestoredCollapseState(
  messages: SerializableDisplayMessage[]
): { toolIds: Set<string>; reasoningKeys: Set<string> } {
  const toolIds = new Set<string>()
  const reasoningKeys = new Set<string>()
  for (const msg of messages) {
    if (!msg.entries?.length) continue
    msg.entries.forEach((entry, i) => {
      if (entry.kind === 'tool' && entry.id) {
        toolIds.add(entry.id)
      } else if (entry.kind === 'reasoning') {
        reasoningKeys.add(`${msg.id}-${i}`)
      }
    })
  }
  return { toolIds, reasoningKeys }
}

export function restoreActivePlan(
  display: SerializableDisplayMessage[],
  persisted: PersistedMessage[]
): ActivePlanSnapshot | null {
  for (let i = persisted.length - 1; i >= 0; i--) {
    const p = persisted[i]
    if (p.role !== 'assistant' || !p.embeddedPlan?.length || p.turnStatus) continue
    const hasIncomplete = p.embeddedPlan.some((s) => s.status !== 'completed')
    if (!hasIncomplete) continue
    const displayId = p.displayId
      ?? display.find((d) => d.role === 'assistant' && d.content === p.content)?.id
    if (displayId) {
      return { steps: p.embeddedPlan, anchorMsgId: displayId, pinned: true }
    }
  }
  return null
}

export function toControllerMessages(messages: PersistedMessage[]): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = []
  for (const m of messages) {
    if (m.role === 'system') {
      result.push({ role: 'system', content: m.content })
      continue
    }
    if (m.entries && m.entries.length > 0) {
      const text = entriesToContent(m.entries)
      result.push({ role: m.role, content: text.trim() || m.content })
    } else {
      result.push({ role: m.role, content: m.content })
    }
  }
  return result
}
