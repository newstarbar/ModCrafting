import type { ChatSession, PersistedMessage } from '../types/chat'
import { normalizeSessionUsage, type UsageStats } from './usage.ts'

const NO_PROJECT = '__no_project__'
const LEGACY_SESSIONS_KEY = 'modcrafting-sessions'
const LEGACY_CURRENT_KEY = 'modcrafting-current-session'

function projectKey(projectPath: string | null): string {
  return projectPath || NO_PROJECT
}

function sessionsKey(projectPath: string | null): string {
  return `modcrafting-sessions::${projectKey(projectPath)}`
}

function currentSessionKey(projectPath: string | null): string {
  return `modcrafting-current-session::${projectKey(projectPath)}`
}

function normalizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Partial<ChatSession>
  if (!s.id || !s.name || !Array.isArray(s.messages)) return null
  return {
    id: s.id,
    name: s.name,
    messages: s.messages.map((m) => {
      const msg = m as ChatSession['messages'][number]
      return {
        role: (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system'
          ? msg.role
          : 'assistant') as PersistedMessage['role'],
        content: String(msg.content ?? ''),
        entries: msg.entries,
        turnStatus: msg.turnStatus,
        embeddedPlan: msg.embeddedPlan,
        timestamp: msg.timestamp,
        displayId: msg.displayId
      }
    }),
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? Date.now(),
    usage: s.usage && typeof s.usage === 'object'
      ? normalizeSessionUsage(s.usage as Partial<UsageStats>)
      : undefined,
    composerMode: s.composerMode === 'agent' || s.composerMode === 'plan' || s.composerMode === 'ask'
      ? s.composerMode
      : undefined,
    sessionGoal: typeof s.sessionGoal === 'string' ? s.sessionGoal : undefined
  }
}

export function loadSessions(projectPath: string | null): ChatSession[] {
  try {
    const raw = localStorage.getItem(sessionsKey(projectPath))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown[]
      return parsed.map(normalizeSession).filter((s): s is ChatSession => s !== null)
    }
    // One-time migration from legacy global key
    const legacy = localStorage.getItem(LEGACY_SESSIONS_KEY)
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown[]
      const sessions = parsed.map(normalizeSession).filter((s): s is ChatSession => s !== null)
      if (sessions.length > 0) {
        saveSessions(projectPath, sessions)
        localStorage.removeItem(LEGACY_SESSIONS_KEY)
        const legacyCurrent = localStorage.getItem(LEGACY_CURRENT_KEY)
        if (legacyCurrent) {
          saveCurrentSessionId(projectPath, legacyCurrent)
          localStorage.removeItem(LEGACY_CURRENT_KEY)
        }
        return sessions
      }
    }
    return []
  } catch {
    return []
  }
}

export function saveSessions(projectPath: string | null, sessions: ChatSession[]): void {
  try {
    localStorage.setItem(sessionsKey(projectPath), JSON.stringify(sessions))
  } catch {
    /* ignore quota errors */
  }
}

export function loadCurrentSessionId(projectPath: string | null): string | null {
  try {
    const id = localStorage.getItem(currentSessionKey(projectPath))
    if (id) return id
    const legacy = localStorage.getItem(LEGACY_CURRENT_KEY)
    if (legacy) return legacy
    return null
  } catch {
    return null
  }
}

export function saveCurrentSessionId(projectPath: string | null, id: string | null): void {
  try {
    const key = currentSessionKey(projectPath)
    if (id) localStorage.setItem(key, id)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
