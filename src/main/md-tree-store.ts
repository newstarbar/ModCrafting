import * as fs from 'fs'
import * as path from 'path'

export interface MdTreeEntry {
  /** POSIX-style relative path, e.g. 'fabric/docs/develop/x.md' */
  path: string
  bundled: boolean
  overridden: boolean
}

export interface MdTreeReadResult {
  success: boolean
  content?: string
  source?: 'override' | 'bundled'
  error?: string
}

export interface MdTreeWriteResult {
  success: boolean
  error?: string
}

export interface MdTreeStore {
  list(): MdTreeEntry[]
  read(relPath: string): MdTreeReadResult
  save(relPath: string, content: string): MdTreeWriteResult
  deleteOverride(relPath: string): MdTreeWriteResult
  hasOverride(relPath: string): boolean
}

/**
 * Normalizes a caller-supplied relative path and refuses anything that could escape
 * the store root ('..', NUL, absolute segments). Returns '' when the path is unsafe.
 */
export function sanitizeRelPath(relPath: string): string {
  const normalized = String(relPath ?? '').replace(/\\/g, '/').trim()
  if (!normalized) return ''
  const segments: string[] = []
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..' || segment.includes('\0')) return ''
    if (segment.includes(':')) return ''
    segments.push(segment)
  }
  return segments.join('/')
}

function walkMd(dir: string, prefix: string, out: Map<string, 'bundled' | 'override'>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkMd(full, rel, out)
    else if (entry.name.endsWith('.md')) out.set(rel.replace(/\\/g, '/'), 'bundled')
  }
}

/**
 * A markdown file tree with a user-writable override layer on top of a read-only
 * bundled tree. Both `agent-knowledge` and `skills` use it, so the walk/read/save
 * semantics stay in one place. Roots are injected (no electron dependency) so the
 * behaviour is unit-testable against a temp directory.
 */
export function createMdTreeStore(opts: { bundledRoot: string; overrideRoot: string }): MdTreeStore {
  const { bundledRoot, overrideRoot } = opts
  const overridePathOf = (safe: string): string => path.join(overrideRoot, safe)

  const list = (): MdTreeEntry[] => {
    const files = new Map<string, MdTreeEntry>()
    if (fs.existsSync(bundledRoot)) {
      const found = new Map<string, 'bundled'>()
      walkMd(bundledRoot, '', found)
      for (const rel of found.keys()) {
        files.set(rel, { path: rel, bundled: true, overridden: fs.existsSync(overridePathOf(rel)) })
      }
    }
    if (fs.existsSync(overrideRoot)) {
      const found = new Map<string, 'override'>()
      walkMd(overrideRoot, '', found)
      for (const rel of found.keys()) {
        if (files.has(rel)) continue
        files.set(rel, { path: rel, bundled: false, overridden: true })
      }
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  const read = (relPath: string): MdTreeReadResult => {
    const safe = sanitizeRelPath(relPath)
    if (!safe) return { success: false, error: `Invalid path: ${relPath}` }
    const override = overridePathOf(safe)
    if (fs.existsSync(override)) {
      try {
        return { success: true, content: fs.readFileSync(override, 'utf-8'), source: 'override' }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    }
    const bundled = path.join(bundledRoot, safe)
    if (!fs.existsSync(bundled)) return { success: false, error: `File not found: ${safe}` }
    try {
      return { success: true, content: fs.readFileSync(bundled, 'utf-8'), source: 'bundled' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  const save = (relPath: string, content: string): MdTreeWriteResult => {
    const safe = sanitizeRelPath(relPath)
    if (!safe) return { success: false, error: `Invalid path: ${relPath}` }
    const target = overridePathOf(safe)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  const deleteOverride = (relPath: string): MdTreeWriteResult => {
    const safe = sanitizeRelPath(relPath)
    if (!safe) return { success: false, error: `Invalid path: ${relPath}` }
    const target = overridePathOf(safe)
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  return { list, read, save, deleteOverride, hasOverride: (relPath: string) => fs.existsSync(overridePathOf(sanitizeRelPath(relPath))) }
}
