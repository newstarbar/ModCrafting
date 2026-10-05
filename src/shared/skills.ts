/**
 * Shared shape of a skill descriptor, as returned by `skills:list`.
 * `relPath` is always `<id>/SKILL.md` inside the skill tree.
 */
export interface SkillDescriptor {
  id: string
  name: string
  description: string
  relPath: string
  bundled: boolean
  overridden: boolean
  enabled: boolean
}

export interface SkillReadResult {
  success: boolean
  id?: string
  name?: string
  description?: string
  /** Markdown body with the frontmatter block stripped. */
  content?: string
  /** Verbatim file text, so an editor round-trip keeps unknown frontmatter keys. */
  raw?: string
  source?: 'bundled' | 'override'
  enabled?: boolean
  error?: string
}

export interface SkillWriteResult {
  success: boolean
  error?: string
}
