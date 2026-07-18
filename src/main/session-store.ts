import { app } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export interface StoredChatSession {
  id: string
  name: string
  messages: unknown[]
  createdAt: number
  updatedAt: number
  usage?: unknown
  composerMode?: string
  sessionGoal?: string
}

interface ProjectSessionFile {
  projectPath: string
  currentSessionId: string | null
  sessions: StoredChatSession[]
  updatedAt: string
}

interface SessionIndex {
  /** normalizedPath -> file basename (hash.json) */
  projects: Record<string, string>
}

/** Canonical project key so F:\a and F:/a map to the same store. */
export function normalizeProjectPathKey(projectPath: string | null | undefined): string {
  if (!projectPath) return '__no_project__'
  let p = projectPath.trim().replace(/\\/g, '/')
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (/^[A-Za-z]:\//.test(p)) {
    p = p[0].toLowerCase() + p.slice(1)
  }
  return p
}

function storeDir(): string {
  return path.join(app.getPath('userData'), 'chat-sessions')
}

function indexPath(): string {
  return path.join(storeDir(), 'index.json')
}

function ensureStoreDir(): void {
  fs.mkdirSync(storeDir(), { recursive: true })
}

function readIndex(): SessionIndex {
  try {
    const p = indexPath()
    if (!fs.existsSync(p)) return { projects: {} }
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SessionIndex
    return { projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {} }
  } catch {
    return { projects: {} }
  }
}

function writeIndex(index: SessionIndex): void {
  ensureStoreDir()
  fs.writeFileSync(indexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function hashForKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)
}

function filePathForKey(key: string, index: SessionIndex): string {
  let fileName = index.projects[key]
  if (!fileName) {
    fileName = `${hashForKey(key)}.json`
    index.projects[key] = fileName
    writeIndex(index)
  }
  return path.join(storeDir(), fileName)
}

function readProjectFile(filePath: string): ProjectSessionFile | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProjectSessionFile
    if (!raw || !Array.isArray(raw.sessions)) return null
    return {
      projectPath: typeof raw.projectPath === 'string' ? raw.projectPath : '',
      currentSessionId: raw.currentSessionId ?? null,
      sessions: raw.sessions,
      updatedAt: raw.updatedAt || new Date().toISOString()
    }
  } catch {
    return null
  }
}

/** Find an existing file whose projectPath normalizes to the same key (legacy variants). */
function findEquivalentFile(key: string, index: SessionIndex): string | null {
  for (const [storedKey, fileName] of Object.entries(index.projects)) {
    if (normalizeProjectPathKey(storedKey) === key && storedKey !== key) {
      return path.join(storeDir(), fileName)
    }
  }
  // Scan orphan files not in index
  try {
    ensureStoreDir()
    for (const name of fs.readdirSync(storeDir())) {
      if (!name.endsWith('.json') || name === 'index.json') continue
      const fp = path.join(storeDir(), name)
      const data = readProjectFile(fp)
      if (!data) continue
      if (normalizeProjectPathKey(data.projectPath) === key) {
        index.projects[key] = name
        writeIndex(index)
        return fp
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function loadProjectSessions(projectPath: string | null): {
  projectPath: string
  sessions: StoredChatSession[]
  currentSessionId: string | null
} {
  const key = normalizeProjectPathKey(projectPath)
  const index = readIndex()
  let fp = filePathForKey(key, index)
  let data = readProjectFile(fp)

  if ((!data || data.sessions.length === 0)) {
    const alt = findEquivalentFile(key, index)
    if (alt) {
      data = readProjectFile(alt)
      if (data?.sessions.length) {
        // Re-key under canonical path
        saveProjectSessions(projectPath, data.sessions, data.currentSessionId)
        return {
          projectPath: key,
          sessions: data.sessions,
          currentSessionId: data.currentSessionId
        }
      }
    }
  }

  return {
    projectPath: key,
    sessions: data?.sessions ?? [],
    currentSessionId: data?.currentSessionId ?? null
  }
}

export function saveProjectSessions(
  projectPath: string | null,
  sessions: StoredChatSession[],
  currentSessionId: string | null = null,
  options?: { allowEmptyOverwrite?: boolean }
): { success: boolean; error?: string; projectPath: string; skipped?: boolean } {
  try {
    const key = normalizeProjectPathKey(projectPath)
    ensureStoreDir()
    const index = readIndex()
    const fp = filePathForKey(key, index)

    // Guard: never clobber non-empty disk data with an empty in-memory list
    // (common during StrictMode remount / path flicker races).
    if (!options?.allowEmptyOverwrite && sessions.length === 0) {
      const existing = readProjectFile(fp)
      if (existing && existing.sessions.length > 0) {
        // Still update currentSessionId if provided and file exists
        if (currentSessionId !== existing.currentSessionId && currentSessionId != null) {
          const payload: ProjectSessionFile = {
            ...existing,
            currentSessionId,
            updatedAt: new Date().toISOString()
          }
          fs.writeFileSync(fp, JSON.stringify(payload), 'utf-8')
        }
        return { success: true, projectPath: key, skipped: true }
      }
    }

    const payload: ProjectSessionFile = {
      projectPath: key,
      currentSessionId,
      sessions,
      updatedAt: new Date().toISOString()
    }
    fs.writeFileSync(fp, JSON.stringify(payload), 'utf-8')
    return { success: true, projectPath: key }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      projectPath: normalizeProjectPathKey(projectPath)
    }
  }
}

export function saveCurrentSessionIdDisk(
  projectPath: string | null,
  currentSessionId: string | null
): { success: boolean; error?: string } {
  const loaded = loadProjectSessions(projectPath)
  return saveProjectSessions(projectPath, loaded.sessions, currentSessionId)
}
