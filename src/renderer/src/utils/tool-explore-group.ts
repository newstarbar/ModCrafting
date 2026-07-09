import type { ChronoEntry, ChronoEntryTool } from '../types/display-message.ts'
import { extractPreview } from './tool-output-preview.ts'

export type ExploreGroupKind = 'project' | 'knowledge'

const PROJECT_TOOLS = new Set(['read_file', 'list_directory'])
const KNOWLEDGE_TOOLS = new Set(['fabric_docs_search', 'fabric_javadoc_lookup', 'vanilla_mc_wiki_query'])

export interface ExploreBurst {
  kind: ExploreGroupKind
  startIndex: number
  toolIndices: number[]
  absorbedReasoningIndices: number[]
}

export type RenderSegment =
  | { type: 'explore-group'; kind: ExploreGroupKind; key: string; tools: ChronoEntryTool[]; reasoningCount: number }
  | { type: 'tool'; entry: ChronoEntryTool }
  | { type: 'entry'; entry: ChronoEntry; index: number }

export function exploreGroupKindForTool(name: string): ExploreGroupKind | null {
  if (PROJECT_TOOLS.has(name)) return 'project'
  if (KNOWLEDGE_TOOLS.has(name)) return 'knowledge'
  return null
}

export function isExploreTool(name: string): boolean {
  return exploreGroupKindForTool(name) !== null
}

function isToolEntry(entry: ChronoEntry): entry is ChronoEntryTool {
  return entry.kind === 'tool'
}

/** Find soft-gap bursts: same-kind explore tools separated only by reasoning. */
export function findExploreBursts(entries: ChronoEntry[]): ExploreBurst[] {
  const bursts: ExploreBurst[] = []
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]
    if (!isToolEntry(entry)) {
      i++
      continue
    }

    const kind = exploreGroupKindForTool(entry.name)
    if (!kind) {
      i++
      continue
    }

    const toolIndices = [i]
    const absorbedReasoningIndices: number[] = []
    let j = i + 1

    while (j < entries.length) {
      const next = entries[j]
      if (next.kind === 'reasoning') {
        absorbedReasoningIndices.push(j)
        j++
        continue
      }
      if (isToolEntry(next) && exploreGroupKindForTool(next.name) === kind) {
        toolIndices.push(j)
        j++
        continue
      }
      break
    }

    if (toolIndices.length >= 2) {
      bursts.push({ kind, startIndex: i, toolIndices, absorbedReasoningIndices })
      i = j
    } else {
      i++
    }
  }

  return bursts
}

/** Indices absorbed into explore groups (tools + reasoning), for render skip checks. */
export function getAbsorbedEntryIndices(entries: ChronoEntry[] | undefined): Set<number> {
  const absorbed = new Set<number>()
  if (!entries?.length) return absorbed

  for (const burst of findExploreBursts(entries)) {
    for (const idx of burst.toolIndices) {
      if (idx !== burst.startIndex) absorbed.add(idx)
    }
    for (const idx of burst.absorbedReasoningIndices) {
      absorbed.add(idx)
    }
  }
  return absorbed
}

/** Split message entries into render segments; soft-gap explore bursts (≥2 tools) become one group. */
export function groupExploreToolRuns(msgId: string, entries: ChronoEntry[] | undefined): RenderSegment[] {
  if (!entries?.length) return []

  const bursts = findExploreBursts(entries)
  const consumed = getAbsorbedEntryIndices(entries)
  const burstAtStart = new Map<number, ExploreBurst>()
  for (const burst of bursts) {
    burstAtStart.set(burst.startIndex, burst)
  }

  const segments: RenderSegment[] = []

  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(i)) continue

    const burst = burstAtStart.get(i)
    if (burst) {
      segments.push({
        type: 'explore-group',
        kind: burst.kind,
        key: `${msgId}-${burst.startIndex}`,
        tools: burst.toolIndices.map((idx) => entries[idx] as ChronoEntryTool),
        reasoningCount: burst.absorbedReasoningIndices.length
      })
      continue
    }

    const entry = entries[i]
    if (isToolEntry(entry)) {
      segments.push({ type: 'tool', entry })
    } else {
      segments.push({ type: 'entry', entry, index: i })
    }
  }

  return segments
}

export function collectExploreGroupKeys(msgId: string, entries: ChronoEntry[] | undefined): string[] {
  const keys: string[] = []
  for (const seg of groupExploreToolRuns(msgId, entries)) {
    if (seg.type === 'explore-group') keys.push(seg.key)
  }
  return keys
}

export interface ExploreGroupSummary {
  title: string
  countLabel: string
  statsLine: string
  pathPreview: string
  thoughtHint: string | null
  hasRunning: boolean
  hasError: boolean
  aggregateStatus: 'running' | 'error' | 'done' | 'pending'
}

const GROUP_TITLES: Record<ExploreGroupKind, string> = {
  project: '项目探索',
  knowledge: '文档查询'
}

function pathChipFromTool(tool: ChronoEntryTool): string {
  const path = String(tool.args?.path || tool.args?.keyword || tool.args?.query || '')
  if (!path) return ''
  return path.split('/').pop() || path
}

export function summarizeExploreGroup(
  kind: ExploreGroupKind,
  tools: ChronoEntryTool[],
  reasoningCount = 0
): ExploreGroupSummary {
  const hasRunning = tools.some((t) => t.status === 'running' || t.status === 'pending')
  const hasError = tools.some((t) => t.status === 'error')
  const aggregateStatus: ExploreGroupSummary['aggregateStatus'] = hasError
    ? 'error'
    : hasRunning
      ? 'running'
      : tools.every((t) => t.status === 'done')
        ? 'done'
        : 'pending'

  const countLabel = hasRunning ? `探索中 · ${tools.length} 项` : `${tools.length} 项`
  const thoughtHint = reasoningCount > 0 ? '· 含思考' : null

  if (kind === 'project') {
    const reads = tools.filter((t) => t.name === 'read_file').length
    const lists = tools.filter((t) => t.name === 'list_directory').length
    const parts: string[] = []
    if (reads) parts.push(`${reads} 读取`)
    if (lists) parts.push(`${lists} 目录`)
    const statsLine = parts.join(' · ') || `${tools.length} 次`

    const chips = tools
      .map(pathChipFromTool)
      .filter(Boolean)
      .slice(0, 3)
    const runningTool = [...tools].reverse().find((t) => t.status === 'running')
    const runningChip = runningTool ? pathChipFromTool(runningTool) : ''
    let pathPreview = chips.join(', ')
    if (hasRunning && runningChip && !chips.includes(runningChip)) {
      pathPreview = pathPreview ? `${pathPreview} … ${runningChip}` : runningChip
    }

    return {
      title: GROUP_TITLES.project,
      countLabel,
      statsLine,
      pathPreview,
      thoughtHint,
      hasRunning,
      hasError,
      aggregateStatus
    }
  }

  const keywords = tools
    .map((t) => String(t.args?.keyword || t.args?.query || '').trim())
    .filter(Boolean)
    .slice(0, 3)
  const lastDone = [...tools].reverse().find((t) => t.status === 'done' && (t.output || t.liveOutput))
  const lastPreview = lastDone
    ? extractPreview(lastDone.name, lastDone.output || lastDone.liveOutput || '', lastDone.args)
    : ''

  return {
    title: GROUP_TITLES.knowledge,
    countLabel,
    statsLine: keywords.length ? keywords.join(', ') : `${tools.length} 次查询`,
    pathPreview: lastPreview,
    thoughtHint,
    hasRunning,
    hasError,
    aggregateStatus
  }
}
