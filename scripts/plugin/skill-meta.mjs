/**
 * WorkBuddy-only frontmatter for the skills that are shared with Codex / Claude / Qoder.
 * The shared SKILL.md bodies stay untouched so the three already-validated hosts cannot regress;
 * only missing keys are appended, never existing ones.
 */
export const WORKBUDDY_SKILL_META = {
  'modcrafting-start': { 'allowed-tools': 'mcp__modcrafting-fabric__*', 'user-invocable': 'true' },
  'fabric-mod-development': { 'allowed-tools': 'mcp__modcrafting-fabric__*', 'user-invocable': 'true' },
  'fabric-game-validation': { 'allowed-tools': 'mcp__modcrafting-fabric__*', 'user-invocable': 'false' }
}

/** Appends keys that are not already present; preserves the original body byte for byte. */
export function injectFrontmatter(markdown, extra) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(markdown)
  if (!match) throw new Error('SKILL.md has no YAML frontmatter')
  const present = new Set(match[1].split(/\r?\n/).map((line) => line.split(':')[0].trim()))
  const added = Object.entries(extra).filter(([key]) => !present.has(key)).map(([key, value]) => `${key}: ${value}`)
  if (!added.length) return markdown
  return `---\n${match[1]}\n${added.join('\n')}\n---\n${markdown.slice(match[0].length)}`
}
