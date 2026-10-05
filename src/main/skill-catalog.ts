import * as path from 'path'
import type { MdTreeStore } from './md-tree-store'
import type { SkillDescriptor, SkillReadResult } from '../shared/skills'

export interface SkillFrontmatter {
  name: string
  description: string
  body: string
}

const SKILL_FILE = 'SKILL.md'
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isSkillId(value: string): boolean {
  return typeof value === 'string' && SKILL_ID_PATTERN.test(value)
}

export function skillRelPath(id: string): string {
  return `${id}/${SKILL_FILE}`
}

/**
 * Minimal frontmatter reader: a leading `---` block of `key: value` lines.
 * Deliberately not YAML — skills carry only name/description, and a YAML dependency
 * for two fields is not worth the bundle cost.
 */
export function parseSkillMarkdown(text: string, fallbackName: string): SkillFrontmatter {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/^﻿/, '')
  const lines = normalized.split('\n')
  let name = fallbackName
  let description = ''
  let body = normalized
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      for (const raw of lines.slice(1, end)) {
        const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(raw.trim())
        if (!match) continue
        const key = match[1].toLowerCase()
        const value = match[2].trim().replace(/^(["'])(.*)\1$/, '$2')
        if (!value) continue
        if (key === 'name') name = value
        else if (key === 'description') description = value
      }
      body = lines.slice(end + 1).join('\n')
    }
  }
  if (!description) {
    const firstProse = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    description = firstProse ? firstProse.slice(0, 120) : ''
  }
  return { name, description, body }
}

function skillIdFromRelPath(relPath: string): string | null {
  if (path.posix.basename(relPath) !== SKILL_FILE) return null
  const dir = path.posix.dirname(relPath)
  if (!dir || dir === '.' || dir.includes('/')) return null
  return isSkillId(dir) ? dir : null
}

/** Electron-free core: takes an injected tree so unit tests can run against a temp dir. */
export function listSkillsFromTree(tree: MdTreeStore, disabledIds: string[]): SkillDescriptor[] {
  const disabled = new Set(disabledIds || [])
  const out: SkillDescriptor[] = []
  for (const entry of tree.list()) {
    const id = skillIdFromRelPath(entry.path)
    if (!id) continue
    const parsed = parseSkillMarkdown(tree.read(entry.path).content ?? '', id)
    out.push({
      id,
      name: parsed.name,
      description: parsed.description,
      relPath: entry.path,
      bundled: entry.bundled,
      overridden: entry.overridden,
      enabled: !disabled.has(id)
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function loadSkillFromTree(tree: MdTreeStore, id: string, disabledIds: string[]): SkillReadResult {
  if (!isSkillId(id)) return { success: false, error: `非法技能 id：${id}` }
  const relPath = skillRelPath(id)
  const read = tree.read(relPath)
  if (!read.success || read.content === undefined) {
    return { success: false, error: read.error || `技能不存在：${id}` }
  }
  const parsed = parseSkillMarkdown(read.content, id)
  return {
    success: true,
    id,
    name: parsed.name,
    description: parsed.description,
    content: parsed.body,
    raw: read.content,
    source: read.source,
    enabled: !new Set(disabledIds || []).has(id)
  }
}
