import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getRuntimeRoot } from './build-env'
import { createMdTreeStore, type MdTreeEntry, type MdTreeReadResult, type MdTreeWriteResult } from './md-tree-store'

const MAX_FETCH_CHARS = 12_000
const FETCH_TIMEOUT_MS = 12_000

function bundledKnowledgeRoot(): string {
  // 优先 runtime/knowledge/agent-knowledge（按需下载）
  const runtimePath = path.join(getRuntimeRoot(), 'knowledge', 'agent-knowledge')
  if (fs.existsSync(runtimePath)) return runtimePath
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-knowledge')
  }
  return path.join(app.getAppPath(), 'resources', 'agent-knowledge')
}

function knowledgeStore() {
  return createMdTreeStore({
    bundledRoot: bundledKnowledgeRoot(),
    overrideRoot: path.join(app.getPath('userData'), 'agent-knowledge-overrides')
  })
}

export function listKnowledgeFiles(): MdTreeEntry[] {
  return knowledgeStore().list()
}

export function readKnowledgeFile(relPath: string): MdTreeReadResult {
  return knowledgeStore().read(relPath)
}

export function saveKnowledgeFile(relPath: string, content: string): MdTreeWriteResult {
  return knowledgeStore().save(relPath, content)
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
