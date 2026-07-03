import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

const MAX_FETCH_CHARS = 12_000
const FETCH_TIMEOUT_MS = 12_000

function bundledKnowledgeRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-knowledge')
  }
  return path.join(app.getAppPath(), 'resources', 'agent-knowledge')
}

function userKnowledgeOverridePath(relPath: string): string {
  const safe = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return path.join(app.getPath('userData'), 'agent-knowledge-overrides', safe)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export function listKnowledgeFiles(): { path: string; bundled: boolean; overridden: boolean }[] {
  const root = bundledKnowledgeRoot()
  const results: { path: string; bundled: boolean; overridden: boolean }[] = []
  if (!fs.existsSync(root)) return results

  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.name.endsWith('.md')) {
        results.push({
          path: rel.replace(/\\/g, '/'),
          bundled: true,
          overridden: fs.existsSync(userKnowledgeOverridePath(rel))
        })
      }
    }
  }
  walk(root, '')

  const overrideRoot = path.join(app.getPath('userData'), 'agent-knowledge-overrides')
  if (fs.existsSync(overrideRoot)) {
    const walkOverrides = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walkOverrides(full, rel)
        else if (entry.name.endsWith('.md') && !results.some((r) => r.path === rel.replace(/\\/g, '/'))) {
          results.push({ path: rel.replace(/\\/g, '/'), bundled: false, overridden: true })
        }
      }
    }
    walkOverrides(overrideRoot, '')
  }

  return results.sort((a, b) => a.path.localeCompare(b.path))
}

export function readKnowledgeFile(relPath: string): { success: boolean; content?: string; source?: 'override' | 'bundled'; error?: string } {
  const safe = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const override = userKnowledgeOverridePath(safe)
  if (fs.existsSync(override)) {
    try {
      return { success: true, content: fs.readFileSync(override, 'utf-8'), source: 'override' }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }
  const bundled = path.join(bundledKnowledgeRoot(), safe)
  if (!fs.existsSync(bundled)) {
    return { success: false, error: `Knowledge file not found: ${safe}` }
  }
  try {
    return { success: true, content: fs.readFileSync(bundled, 'utf-8'), source: 'bundled' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export function saveKnowledgeFile(relPath: string, content: string): { success: boolean; error?: string } {
  const safe = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const target = userKnowledgeOverridePath(safe)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function fetchUrlText(url: string, maxChars = MAX_FETCH_CHARS): Promise<{
  success: boolean
  text?: string
  url: string
  truncated?: boolean
  error?: string
}> {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return { success: false, url: trimmed, error: 'Only http/https URLs are supported' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(trimmed, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ModCrafting/1.0 (+https://github.com/modcrafting)',
        Accept: 'text/html,application/json,text/plain,*/*'
      }
    })
    if (!response.ok) {
      return { success: false, url: trimmed, error: `HTTP ${response.status}` }
    }
    const raw = await response.text()
    const contentType = response.headers.get('content-type') || ''
    const text = /json/i.test(contentType)
      ? raw.slice(0, maxChars)
      : stripHtml(raw).slice(0, maxChars)
    return {
      success: true,
      url: trimmed,
      text,
      truncated: raw.length > maxChars
    }
  } catch (err) {
    return { success: false, url: trimmed, error: String(err) }
  } finally {
    clearTimeout(timer)
  }
}
