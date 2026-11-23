/**
 * Intent -> queries -> ranked candidates -> gap report.
 *
 * Everything here is deterministic: the same intent and the same candidate set
 * produce byte-identical scores, regardless of the order the registries answered
 * in. That is what lets a pack review be reproducible and lets a test assert on
 * a score instead of a snapshot of a live API.
 */

import { z } from 'zod'
import type { Candidate, GapReport, PackIntent, ScoreEvidence } from '../pack-model.ts'
import { GAP_COVERAGE_THRESHOLD, packIntentSchema } from '../pack-model.ts'
import type { RegistryId } from '../workspace-model.ts'
import { registryIds, targetIdSchema } from '../workspace-model.ts'
import type { LoaderId } from '../version/schema.ts'
import { parseTargetId } from '../version/targets.ts'
import type { RegistryReader } from './registry-client.ts'
import { registryKey, type RegistryProject } from './registry-model.ts'

export interface DiscoverTarget {
  loader: LoaderId
  minecraft: string
}

export interface DiscoverResult {
  candidates: Candidate[]
  gap: GapReport
  warnings: string[]
  queries: string[]
}

const MAX_QUERIES = 8
const MAX_NEAR_MISS = 10
const DAY_MS = 86_400_000

/** Latin words plus CJK bigrams; bigrams are what make Chinese feature matching work without a dictionary. */
function tokens(value: string): string[] {
  const text = value.toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, ' ').trim()
  if (!text) return []
  const latin = text.match(/[a-z0-9]{2,}/g) ?? []
  const cjk: string[] = []
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) cjk.push(run)
    else for (let index = 0; index < run.length - 1; index++) cjk.push(run.slice(index, index + 2))
  }
  return [...new Set([...latin, ...cjk])]
}

/** A plural or inflection should still match; two-character CJK bigrams stay exact. */
function tokenMatch(left: string, right: string): boolean {
  if (left === right) return true
  if (left.length < 4 || right.length < 4) return false
  return left.startsWith(right) || right.startsWith(left)
}

function requiredFeatures(intent: PackIntent): string[] {
  return [...new Set([...intent.features, ...intent.mustHave].map((value) => value.trim()).filter(Boolean))]
}

function candidateQueryValues(intent: PackIntent): string[] {
  const shortGoal = intent.goal.trim().length <= 60 ? [intent.goal.trim()] : []
  return [
    ...intent.features,
    ...intent.mustHave,
    ...intent.niceToHave,
    ...(intent.keywords ?? []),
    ...(intent.domain ? [intent.domain] : []),
    ...shortGoal
  ]
}

/** Stable, de-duplicated queries. The order follows the intent's own priority. */
export function buildSearchQueries(intent: PackIntent, _target: DiscoverTarget): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const value of candidateQueryValues(intent)) {
    const query = value.trim().replace(/\s+/g, ' ')
    const key = query.toLowerCase()
    if (query.length < 2 || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length >= MAX_QUERIES) break
  }
  return queries
}

function corpusOf(project: RegistryProject): Set<string> {
  return new Set(tokens(`${project.title} ${project.slug} ${project.description} ${project.categories.join(' ')}`))
}

function covers(corpus: ReadonlySet<string>, feature: string): boolean {
  const featureTokens = tokens(feature)
  if (featureTokens.length === 0) return false
  const hits = featureTokens.filter((token) => [...corpus].some((value) => tokenMatch(token, value))).length
  return hits >= Math.max(1, Math.ceil(featureTokens.length * 0.5))
}

function freshness(updatedAt: string, nowMs: number): number {
  const time = Date.parse(updatedAt)
  if (!Number.isFinite(time)) return 0
  const days = (nowMs - time) / DAY_MS
  if (days <= 180) return 1
  if (days <= 365) return 0.6
  if (days <= 730) return 0.3
  return 0
}

function popularity(downloads: number): number {
  return Math.min(1, Math.max(0, Math.log10(downloads + 1) / 7))
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function scoreProject(project: RegistryProject, intent: PackIntent, target: DiscoverTarget | undefined, nowMs: number): Candidate {
  const required = requiredFeatures(intent)
  const corpus = corpusOf(project)
  const covered = required.filter((feature) => covers(corpus, feature))
  const missing = required.filter((feature) => !covered.includes(feature))
  const coverage = required.length > 0 ? covered.length / required.length : 1

  const titleCorpus = new Set(tokens(`${project.title} ${project.slug}`))
  const titleHits = required.filter((feature) => tokens(feature).some((token) => [...titleCorpus].some((value) => tokenMatch(token, value)))).length
  const keywordScore = required.length > 0 ? titleHits / required.length : 0
  const popularityScore = popularity(project.downloads)
  const freshnessScore = freshness(project.updatedAt, nowMs)
  const compatibility = target
    ? project.loaders.includes(target.loader) && project.gameVersions.includes(target.minecraft)
      ? 1
      : project.gameVersions.length === 0
        ? 0.5
        : 0
    : 0.5

  const score = round4(clampUnit(
    0.45 * coverage +
    0.20 * keywordScore +
    0.15 * popularityScore +
    0.10 * freshnessScore +
    0.10 * compatibility
  ))

  const categoryHits = project.categories.filter((category) =>
    required.some((feature) => tokens(feature).some((token) => tokenMatch(token, category.toLowerCase())))
  )
  const evidence: ScoreEvidence[] = []
  if (covered.length > 0) evidence.push({ kind: 'keyword', detail: `命中 ${covered.join('、')}`, weight: round4(coverage) })
  if (titleHits > 0) evidence.push({ kind: 'description', detail: `标题/标识命中 ${titleHits}/${required.length}`, weight: round4(keywordScore) })
  if (categoryHits.length > 0) evidence.push({ kind: 'category', detail: `分类命中 ${categoryHits.join('、')}`, weight: round4(Math.min(1, categoryHits.length)) })
  if (popularityScore > 0) evidence.push({ kind: 'popularity', detail: `下载量 ${project.downloads}`, weight: round4(popularityScore) })
  evidence.push({ kind: 'freshness', detail: `更新于 ${project.updatedAt}`, weight: round4(freshnessScore) })
  if (target) {
    evidence.push({
      kind: 'compatibility',
      detail: compatibility === 1
        ? `支持 ${target.loader} ${target.minecraft}`
        : `未确认支持 ${target.loader} ${target.minecraft}`,
      weight: compatibility
    })
  }

  return {
    registry: project.registry,
    projectId: project.projectId,
    slug: project.slug,
    title: project.title,
    description: project.description,
    categories: project.categories,
    downloads: project.downloads,
    updatedAt: project.updatedAt,
    license: project.license,
    environment: project.environment,
    score,
    covered,
    missing,
    coverage: round4(coverage),
    evidence
  }
}

function preferProject(left: RegistryProject, right: RegistryProject): RegistryProject {
  if (left.description.length !== right.description.length) return left.description.length > right.description.length ? left : right
  if (left.downloads !== right.downloads) return left.downloads > right.downloads ? left : right
  return left.registry <= right.registry ? left : right
}

/** Deterministic rank: score, then downloads, then registry key. */
export function rankCandidates(intent: PackIntent, projects: readonly RegistryProject[], target?: DiscoverTarget, options: { now?: number } = {}): Candidate[] {
  const nowMs = options.now ?? Date.now()
  const unique = new Map<string, RegistryProject>()
  for (const project of projects) {
    const key = registryKey(project.registry, project.projectId)
    const existing = unique.get(key)
    unique.set(key, existing ? preferProject(existing, project) : project)
  }
  return [...unique.values()]
    .map((project) => scoreProject(project, intent, target, nowMs))
    .sort((left, right) =>
      right.score - left.score ||
      right.downloads - left.downloads ||
      left.registry.localeCompare(right.registry) ||
      left.projectId.localeCompare(right.projectId)
    )
}

/**
 * What the pack still lacks after `accepted`.
 *
 * `nearMiss` is any candidate that covers *some* required feature but not all,
 * because that is exactly the input the transform pipeline needs. A candidate
 * that fully covers the intent is not a near miss even if it has not been
 * accepted yet; it is a normal selection candidate.
 */
export function buildGapReport(intent: PackIntent, accepted: readonly Candidate[], ranked: readonly Candidate[] = []): GapReport {
  const required = requiredFeatures(intent)
  const acceptedKeys = new Set(accepted.map((candidate) => registryKey(candidate.registry, candidate.projectId)))
  const covered = new Set(accepted.flatMap((candidate) => candidate.covered))
  const missing = required.filter((feature) => !covered.has(feature))
  const coverage = required.length > 0 ? (required.length - missing.length) / required.length : 1

  const nearMiss = ranked
    .filter((candidate) => !acceptedKeys.has(registryKey(candidate.registry, candidate.projectId)))
    .filter((candidate) => candidate.coverage > 0 && candidate.coverage < 1)
    .sort((left, right) =>
      right.coverage - left.coverage ||
      right.score - left.score ||
      left.registry.localeCompare(right.registry) ||
      left.projectId.localeCompare(right.projectId)
    )
    .slice(0, MAX_NEAR_MISS)
    .map((candidate) => ({
      registry: candidate.registry,
      projectId: candidate.projectId,
      slug: candidate.slug,
      title: candidate.title,
      coverage: candidate.coverage,
      missing: candidate.missing
    }))

  const plausible = ranked.some((candidate) => candidate.coverage >= GAP_COVERAGE_THRESHOLD)
  return {
    coverage: round4(coverage),
    missing,
    nearMiss,
    authorFromScratch: coverage < GAP_COVERAGE_THRESHOLD && nearMiss.length === 0 && !plausible
  }
}

export interface RunDiscoveryInput {
  intent: PackIntent
  target: DiscoverTarget
  registries?: readonly RegistryId[]
  limit?: number
  /** Candidates already in the pack, for the gap report. Accepts `id` or `registry:id`. */
  acceptedProjectIds?: readonly string[]
}

/**
 * Query every selected registry, merge by project key, then rank once.
 *
 * A registry failure is a warning, never an exception: one missing CurseForge
 * key must not make Modrinth results unreachable.
 */
export async function runDiscovery(reader: RegistryReader, input: RunDiscoveryInput): Promise<DiscoverResult> {
  const registries = input.registries ?? ['modrinth', 'curseforge']
  const queries = buildSearchQueries(input.intent, input.target)
  const projects = new Map<string, RegistryProject>()
  const failures = new Map<RegistryId, string>()
  const succeeded = new Set<RegistryId>()

  for (const query of queries) {
    for (const registry of registries) {
      try {
        const found = await reader.search({
          registry,
          query,
          loader: input.target.loader,
          gameVersion: input.target.minecraft,
          limit: input.limit ?? 10
        })
        succeeded.add(registry)
        for (const project of found) projects.set(registryKey(project.registry, project.projectId), project)
      } catch (cause) {
        if (!failures.has(registry)) failures.set(registry, cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  const warnings = [...failures.entries()]
    .filter(([registry]) => !succeeded.has(registry))
    .map(([registry, message]) => `${registry}: ${message}；已继续使用其他数据源。`)

  const ranked = rankCandidates(input.intent, [...projects.values()], input.target)
  const acceptedKeys = new Set(input.acceptedProjectIds ?? [])
  const accepted = ranked.filter((candidate) => acceptedKeys.has(candidate.projectId) || acceptedKeys.has(registryKey(candidate.registry, candidate.projectId)))
  return {
    candidates: ranked.slice(0, Math.max(1, input.limit ?? 20)),
    gap: buildGapReport(input.intent, accepted, ranked),
    warnings,
    queries
  }
}

export const packDiscoverRequestSchema = z.object({
  intent: packIntentSchema,
  targetId: targetIdSchema,
  registries: z.array(z.enum(registryIds)).min(1).max(2).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /** Candidates already accepted into the pack, for the gap report. */
  acceptedProjectIds: z.array(z.string().min(1).max(128)).max(256).optional()
}).strict()
export type PackDiscoverRequest = z.infer<typeof packDiscoverRequestSchema>

/** The one entry point both the MCP tool and the browser operation call. */
export async function discoverPack(reader: RegistryReader, request: PackDiscoverRequest): Promise<DiscoverResult & { targetId: string }> {
  const { loader, minecraft } = parseTargetId(request.targetId)
  const result = await runDiscovery(reader, {
    intent: request.intent,
    target: { loader, minecraft },
    registries: request.registries,
    limit: request.limit,
    acceptedProjectIds: request.acceptedProjectIds
  })
  return { ...result, targetId: request.targetId }
}
