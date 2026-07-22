/** Structured knowledge-hit trails for UI tag hierarchy. */

export interface KnowledgeHitTrail {
  /** e.g. 文档 / 源码 / 未命中 */
  kind: string
  /** e.g. 物品 / 方块 / Yarn */
  category: string
  /** e.g. first-item / UseBlockCallback */
  doc: string
  /** e.g. 注册物品 — section inside the doc */
  section: string
}

const HIT_LINE_RE = /^::kh::([^|\n]*)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)$/gm

export function formatKnowledgeHitLine(trail: KnowledgeHitTrail): string {
  const clean = (s: string) => s.replace(/[|\n\r]/g, ' ').trim()
  return `::kh::${clean(trail.kind)}|${clean(trail.category)}|${clean(trail.doc)}|${clean(trail.section)}`
}

export function parseKnowledgeHitTrails(output: string): KnowledgeHitTrail[] {
  if (!output) return []
  const hits: KnowledgeHitTrail[] = []
  for (const match of output.matchAll(HIT_LINE_RE)) {
    hits.push({
      kind: match[1].trim(),
      category: match[2].trim(),
      doc: match[3].trim(),
      section: match[4].trim()
    })
  }
  return hits
}

export function knowledgeHitLevels(trail: KnowledgeHitTrail): string[] {
  return [trail.kind, trail.category, trail.doc, trail.section].filter(Boolean)
}

/** Flat text fallback when tags cannot render. */
export function formatKnowledgeHitPlain(trail: KnowledgeHitTrail): string {
  return knowledgeHitLevels(trail).join(' › ')
}
