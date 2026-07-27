import type { PlanStep } from '../components/TaskPlan'
import type { PersistedChronoEntry, PersistedMessage } from '../types/chat'
import type { ChronoEntry } from '../types/display-message.ts'
import type { ChatContentPart } from '../harness/chat-message.ts'
import type { GuiLayoutElement, GuiLayoutType } from '../harness/events'
import { collectExploreGroupKeys } from './tool-explore-group.ts'
import { buildUserContent } from '../context/user-content.ts'

export interface SerializableChronoEntry {
  kind: 'reasoning' | 'text' | 'tool' | 'guiLayoutPreview'
  content?: string
  id?: string
  name?: string
  status?: 'pending' | 'running' | 'done' | 'error'
  output?: string
  liveOutput?: string
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

export interface SerializableDisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  entries?: SerializableChronoEntry[]
  isStreaming?: boolean
  turnStatus?: 'completed' | 'partial' | 'error' | 'cancelled' | 'answered' | 'planned'
  embeddedPlan?: PlanStep[]
  timestamp: number
  stateSnapshot?: any
  attachments?: PersistedMessage['attachments']
}

export interface ActivePlanSnapshot {
  steps: PlanStep[]
  anchorMsgId: string
  pinned: boolean
}

function entriesToContent(entries: PersistedChronoEntry[]): string {
  return entries
    .filter((e) => e.kind === 'text')
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
      embeddedPlan: m.embeddedPlan,
      stateSnapshot: m.stateSnapshot,
      // Clone so later UI mutations cannot drop persisted attachment metadata.
      attachments: m.attachments?.length
        ? m.attachments.map((a) => ({ ...a }))
        : undefined
    }

    if (m.entries && m.entries.length > 0) {
      persisted.entries = m.entries.map((e): PersistedChronoEntry => {
        if (e.kind === 'tool') {
          const status = e.status === 'running' ? 'done' : e.status
          const fileDiff = e.fileDiff
            ? {
                path: e.fileDiff.path,
                added: e.fileDiff.added,
                removed: e.fileDiff.removed,
                action: e.fileDiff.action,
                firstAdded: e.fileDiff.firstAdded,
                firstRemoved: e.fileDiff.firstRemoved,
                // Keep enough for diagnostics after reload; clip huge payloads
                content: e.fileDiff.content
                  ? e.fileDiff.content.length > 24_000
                    ? `${e.fileDiff.content.slice(0, 24_000)}\n… [截断]`
                    : e.fileDiff.content
                  : undefined,
                oldContent: e.fileDiff.oldContent
                  ? e.fileDiff.oldContent.length > 12_000
                    ? `${e.fileDiff.oldContent.slice(0, 12_000)}\n… [截断]`
                    : e.fileDiff.oldContent
                  : undefined,
              }
            : undefined
          const outputRaw = e.output || e.liveOutput
          const output = outputRaw && outputRaw.length > 48_000
            ? `${outputRaw.slice(0, 48_000)}\n… [截断：原始 ${outputRaw.length} 字符]`
            : outputRaw
          return {
            kind: 'tool',
            id: e.id,
            name: e.name,
            status,
            output,
            durationMs: e.durationMs,
            startMs: e.startMs,
            displayName: e.displayName,
            args: e.args,
            fileDiff,
          }
        }
        if (e.kind === 'reasoning') {
          return { kind: 'reasoning', content: e.content, done: e.done ?? true }
        }
        if (e.kind === 'guiLayoutPreview') {
          return {
            kind: 'guiLayoutPreview',
            id: e.id,
            title: e.title,
            layoutType: e.layoutType,
            html: e.html.length > 48_000 ? `${e.html.slice(0, 48_000)}\n… [截断]` : e.html,
            elements: e.elements,
            status: e.status,
            layoutJson: e.layoutJson
          }
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
        isStreaming: false,
        stateSnapshot: (m as any).stateSnapshot,
        attachments: m.attachments?.length
          ? m.attachments.map((a) => ({ ...a }))
          : undefined
      }
    })
}

export function buildRestoredCollapseState(
  messages: SerializableDisplayMessage[]
): { toolIds: Set<string>; reasoningKeys: Set<string>; exploreGroupKeys: Set<string> } {
  const toolIds = new Set<string>()
  const reasoningKeys = new Set<string>()
  const exploreGroupKeys = new Set<string>()
  for (const msg of messages) {
    if (!msg.entries?.length) continue
    collectExploreGroupKeys(msg.id, msg.entries as ChronoEntry[]).forEach((k) => {
      exploreGroupKeys.add(k)
    })
    msg.entries.forEach((entry, i) => {
      if (entry.kind === 'tool' && entry.id) {
        toolIds.add(entry.id)
      } else if (entry.kind === 'reasoning') {
        reasoningKeys.add(`${msg.id}-${i}`)
      }
    })
  }
  return { toolIds, reasoningKeys, exploreGroupKeys }
}

/** Turn statuses that still leave an incomplete plan worth resuming. */
const RESUMABLE_TURN_STATUSES = new Set(['partial', 'error', 'cancelled', 'planned'])

export function restoreActivePlan(
  display: SerializableDisplayMessage[],
  persisted: PersistedMessage[]
): ActivePlanSnapshot | null {
  for (let i = persisted.length - 1; i >= 0; i--) {
    const p = persisted[i]
    if (p.role !== 'assistant' || !p.embeddedPlan?.length) continue
    // Streaming/in-progress (no turnStatus) OR partial/error after a stop — both are resumable.
    // Skip completed/answered so finished turns do not resurrect a dead plan.
    if (p.turnStatus && !RESUMABLE_TURN_STATUSES.has(p.turnStatus)) continue
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

export async function toControllerMessagesWithAttachments(
  messages: PersistedMessage[],
  readDataUrl: (filePath: string) => Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>
): Promise<Array<{ role: string; content: string | ChatContentPart[] }>> {
  const result: Array<{ role: string; content: string | ChatContentPart[] }> = []
  for (const m of messages) {
    if (m.role === 'system') {
      result.push({ role: 'system', content: m.content })
      continue
    }
    if (m.entries && m.entries.length > 0) {
      const text = entriesToContent(m.entries)
      result.push({ role: m.role, content: text.trim() || m.content })
      continue
    }
    if (m.role === 'user' && m.attachments?.some((a) => a.kind === 'image')) {
      const imageDataUrls = new Map<string, string>()
      for (const att of m.attachments) {
        if (att.kind !== 'image') continue
        const loaded = await readDataUrl(att.path)
        if (loaded.ok) imageDataUrls.set(att.path, loaded.dataUrl)
      }
      result.push({
        role: 'user',
        content: buildUserContent(m.content, m.attachments, imageDataUrls)
      })
      continue
    }
    if (m.role === 'user' && m.attachments?.length) {
      result.push({
        role: 'user',
        content: buildUserContent(m.content, m.attachments, new Map())
      })
      continue
    }
    result.push({ role: m.role, content: m.content })
  }
  return result
}
