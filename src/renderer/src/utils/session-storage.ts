import type { ChatSession, PersistedMessage } from '../types/chat'
import { normalizeSessionUsage, type UsageStats } from './usage.ts'

const NO_PROJECT = '__no_project__'
const LEGACY_SESSIONS_KEY = 'modcrafting-sessions'
const LEGACY_CURRENT_KEY = 'modcrafting-current-session'

/** Keep in sync with main/session-store normalizeProjectPathKey */
export function normalizeProjectPathKey(projectPath: string | null | undefined): string {
  if (!projectPath) return NO_PROJECT
  let p = projectPath.trim().replace(/\\/g, '/')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1)
  }
  return p
}

function projectKey(projectPath: string | null): string {
  return normalizeProjectPathKey(projectPath)
}

function sessionsKey(projectPath: string | null): string {
  return `modcrafting-sessions::${projectKey(projectPath)}`
}

function currentSessionKey(projectPath: string | null): string {
  return `modcrafting-current-session::${projectKey(projectPath)}`
}

/** Alternate localStorage keys that may exist for the same project (pre-normalize era). */
function legacyLocalStorageSessionKeys(projectPath: string | null): string[] {
  const keys = new Set<string>()
  keys.add(sessionsKey(projectPath))
  if (!projectPath) {
    keys.add(LEGACY_SESSIONS_KEY)
    return [...keys]
  }
  const raw = projectPath.trim()
  const variants = [
    raw,
    raw.replace(/\\/g, '/'),
    raw.replace(/\//g, '\\'),
    raw.replace(/[\\/]+$/, ''),
  ]
  for (const v of variants) {
    keys.add(`modcrafting-sessions::${v}`)
    keys.add(`modcrafting-sessions::${v.replace(/\\/g, '/')}`)
  }
  return [...keys]
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
        displayId: msg.displayId,
        stateSnapshot: msg.stateSnapshot
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

function parseSessionsJson(raw: string | null): ChatSession[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown[]
    return parsed.map(normalizeSession).filter((s): s is ChatSession => s !== null)
  } catch {
    return []
  }
}

function loadSessionsFromLocalStorage(projectPath: string | null): {
  sessions: ChatSession[]
  currentSessionId: string | null
  sourceKey: string | null
} {
  for (const key of legacyLocalStorageSessionKeys(projectPath)) {
    const sessions = parseSessionsJson(localStorage.getItem(key))
    if (sessions.length > 0) {
      const currentKey = key.replace('modcrafting-sessions::', 'modcrafting-current-session::')
      const currentSessionId =
        localStorage.getItem(currentKey) ||
        localStorage.getItem(currentSessionKey(projectPath)) ||
        localStorage.getItem(LEGACY_CURRENT_KEY)
      return { sessions, currentSessionId, sourceKey: key }
    }
  }

  // Global legacy bucket
  const legacy = parseSessionsJson(localStorage.getItem(LEGACY_SESSIONS_KEY))
  if (legacy.length > 0) {
    return {
      sessions: legacy,
      currentSessionId: localStorage.getItem(LEGACY_CURRENT_KEY),
      sourceKey: LEGACY_SESSIONS_KEY
    }
  }

  return { sessions: [], currentSessionId: null, sourceKey: null }
}

function clearMigratedLocalStorage(projectPath: string | null, sourceKey: string | null): void {
  // Keep legacy localStorage as backup; only remove the exact key we migrated from.
  try {
    if (sourceKey) localStorage.removeItem(sourceKey)
    const currentKey = sourceKey?.replace('modcrafting-sessions::', 'modcrafting-current-session::')
    if (currentKey && currentKey !== sourceKey) localStorage.removeItem(currentKey)
  } catch {
    /* ignore */
  }
}

export async function loadSessions(projectPath: string | null): Promise<ChatSession[]> {
  const result = await loadSessionsWithMeta(projectPath)
  return result.sessions
}

export async function loadSessionsWithMeta(projectPath: string | null): Promise<{
  sessions: ChatSession[]
  currentSessionId: string | null
}> {
  try {
    if (typeof window !== 'undefined' && window.api?.sessionsLoad) {
      const disk = await window.api.sessionsLoad(projectPath)
      const diskSessions = (disk.sessions || [])
        .map(normalizeSession)
        .filter((s): s is ChatSession => s !== null)

      if (diskSessions.length > 0) {
        return {
          sessions: diskSessions,
          currentSessionId: disk.currentSessionId
        }
      }

      // One-time migrate from renderer localStorage (old port / origin buckets)
      const legacy = loadSessionsFromLocalStorage(projectPath)
      if (legacy.sessions.length > 0) {
        const saveResult = await window.api.sessionsSave(
          projectPath,
          legacy.sessions,
          legacy.currentSessionId
        )
        if (saveResult.success) {
          clearMigratedLocalStorage(projectPath, legacy.sourceKey)
        }
        return {
          sessions: legacy.sessions,
          currentSessionId: legacy.currentSessionId
        }
      }

      return { sessions: [], currentSessionId: disk.currentSessionId }
    }
  } catch {
    /* fall through to localStorage */
  }

  const legacy = loadSessionsFromLocalStorage(projectPath)
  return {
    sessions: legacy.sessions,
    currentSessionId: legacy.currentSessionId
  }
}

export async function saveSessions(
  projectPath: string | null,
  sessions: ChatSession[],
  currentSessionId?: string | null,
  options?: { allowEmptyOverwrite?: boolean }
): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.api?.sessionsSave) {
      const result = await window.api.sessionsSave(
        projectPath,
        sessions,
        currentSessionId ?? null,
        options
      )
      if (!result.success) {
        console.warn('[session-storage] disk save failed:', result.error)
      }
      return
    }
  } catch (err) {
    console.warn('[session-storage] disk save error:', err)
  }

  // Fallback: localStorage (dev without preload)
  try {
    localStorage.setItem(sessionsKey(projectPath), JSON.stringify(sessions))
  } catch {
    /* ignore quota errors */
  }
}

export async function loadCurrentSessionId(projectPath: string | null): Promise<string | null> {
  const meta = await loadSessionsWithMeta(projectPath)
  return meta.currentSessionId
}

export async function saveCurrentSessionId(
  projectPath: string | null,
  id: string | null
): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.api?.sessionsSaveCurrent) {
      await window.api.sessionsSaveCurrent(projectPath, id)
      return
    }
  } catch {
    /* fall through */
  }
  try {
    const key = currentSessionKey(projectPath)
    if (id) localStorage.setItem(key, id)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}
