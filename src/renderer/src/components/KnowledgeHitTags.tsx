import React from 'react'
import {
  formatKnowledgeHitPlain,
  knowledgeHitLevels,
  parseKnowledgeHitTrails,
  type KnowledgeHitTrail
} from '../utils/knowledge-hit-tags.ts'

export function KnowledgeHitTagRow({ trail }: { trail: KnowledgeHitTrail }) {
  const levels = knowledgeHitLevels(trail)
  if (levels.length === 0) return null
  return (
    <span className="kh-hit-trail" title={formatKnowledgeHitPlain(trail)}>
      {levels.map((level, i) => (
        <React.Fragment key={`${i}-${level}`}>
          {i > 0 && <span className="kh-hit-sep" aria-hidden>›</span>}
          <span className={`kh-hit-tag kh-hit-tag--l${Math.min(i, 3)}`}>{level}</span>
        </React.Fragment>
      ))}
    </span>
  )
}

export function KnowledgeHitTags({
  output,
  className,
  maxTrails = 3
}: {
  output: string
  className?: string
  maxTrails?: number
}) {
  const trails = parseKnowledgeHitTrails(output).slice(0, maxTrails)
  if (trails.length === 0) return null
  return (
    <span className={`kh-hit-tags${className ? ` ${className}` : ''}`}>
      {trails.map((trail, i) => (
        <KnowledgeHitTagRow key={i} trail={trail} />
      ))}
    </span>
  )
}

export function hasKnowledgeHitTags(output: string): boolean {
  return parseKnowledgeHitTrails(output).length > 0
}
