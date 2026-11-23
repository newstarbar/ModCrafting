import test from 'node:test'
import assert from 'node:assert/strict'
import { GAP_COVERAGE_THRESHOLD, packIntentSchema } from '../../packages/modcrafting-core/src/pack-model.ts'
import {
  buildGapReport,
  buildSearchQueries,
  rankCandidates,
  runDiscovery
} from '../../packages/modcrafting-core/src/pack/pack-discover.ts'
import type { RegistryProject } from '../../packages/modcrafting-core/src/pack/registry-model.ts'
import type { RegistryReader } from '../../packages/modcrafting-core/src/pack/registry-client.ts'

const intent = packIntentSchema.parse({
  goal: '一个以任务书驱动的空岛整合包',
  features: ['quest book', 'rewards'],
  mustHave: ['skyblock'],
  niceToHave: ['map'],
  keywords: ['ftb quests', '任务书']
})

const target = { loader: 'fabric' as const, minecraft: '1.21.4' }

function project(overrides: Partial<RegistryProject> & Pick<RegistryProject, 'projectId' | 'slug' | 'title'>): RegistryProject {
  return {
    registry: 'modrinth',
    projectId: overrides.projectId,
    slug: overrides.slug,
    title: overrides.title,
    description: '',
    categories: [],
    downloads: 0,
    updatedAt: '2025-01-01T00:00:00Z',
    license: { id: 'MIT', redistributable: true },
    environment: 'client_and_server',
    loaders: ['fabric'],
    gameVersions: ['1.21.4'],
    url: `https://modrinth.com/mod/${overrides.slug}`,
    ...overrides
  }
}

const quests = project({
  projectId: 'ftbq0001',
  slug: 'ftb-quests',
  title: 'FTB Quests',
  description: 'A team-based quest book with chapters, rewards and a visual editor.',
  categories: ['adventure', 'utility'],
  downloads: 900_000,
  updatedAt: '2026-10-01T00:00:00Z'
})

const questHelper = project({
  registry: 'curseforge',
  projectId: '2001',
  slug: 'quest-helper',
  title: 'Quest Helper',
  description: 'Adds a small quest book to the game.',
  categories: ['adventure'],
  downloads: 5_000_000,
  updatedAt: '2023-01-01T00:00:00Z',
  loaders: ['forge'],
  gameVersions: ['1.20.1'],
  url: 'https://www.curseforge.com/minecraft/mc-mods/quest-helper'
})

const sodium = project({
  projectId: 'AANobbMI',
  slug: 'sodium',
  title: 'Sodium',
  description: 'Modern rendering engine and client-side optimization mod.',
  categories: ['optimization'],
  downloads: 12_000_000,
  updatedAt: '2026-11-01T00:00:00Z'
})

test('query building dedupes and caps without losing explicit keywords', () => {
  const queries = buildSearchQueries(intent, target)
  assert.ok(queries.includes('ftb quests'))
  assert.ok(queries.includes('任务书'))
  assert.ok(queries.includes('quest book'))
  assert.equal(new Set(queries).size, queries.length, 'a query must not be sent twice')
  assert.ok(queries.length <= 8, 'a noisy intent must not fan out without bound')
})

test('candidate ranking is deterministic and relevance beats raw downloads', () => {
  const first = rankCandidates(intent, [sodium, questHelper, quests])
  const second = rankCandidates(intent, [quests, sodium, questHelper])
  assert.deepEqual(first, second, 'input order must not change the result')
  assert.equal(first[0].projectId, 'ftbq0001', 'the on-target quest mod must beat a more downloaded off-target one')
  assert.ok(first[0].covered.includes('quest book'))
  assert.ok(first[0].covered.includes('rewards'))
  assert.ok(first[0].missing.includes('skyblock'))
  assert.equal(first[0].registry, 'modrinth')
  assert.ok(first[0].score >= first[1].score)
})

test('the gap report names missing features and offers concrete near misses', () => {
  const ranked = rankCandidates(intent, [sodium, questHelper, quests])
  const empty = buildGapReport(intent, [], ranked)
  assert.equal(empty.coverage, 0)
  assert.deepEqual(new Set(empty.missing), new Set(['quest book', 'rewards', 'skyblock']))
  assert.ok(empty.nearMiss.some((candidate) => candidate.projectId === 'ftbq0001' && candidate.missing.includes('skyblock')))
  assert.equal(empty.authorFromScratch, false, 'a close mod exists, so the answer is adapt rather than author from scratch')

  const accepted = buildGapReport(intent, [ranked[0]], ranked)
  assert.ok(accepted.coverage > 0 && accepted.coverage < 1)
  assert.equal(accepted.missing.includes('skyblock'), true)

  const nothing = buildGapReport(intent, [], rankCandidates(intent, [sodium]))
  assert.equal(nothing.authorFromScratch, true, 'no plausible candidate means authoring is the real next step')
})

test('the coverage threshold is the boundary between accepted and gap', () => {
  assert.equal(GAP_COVERAGE_THRESHOLD > 0 && GAP_COVERAGE_THRESHOLD < 1, true)
  const full = buildGapReport(packIntentSchema.parse({ goal: 'x', features: ['quest book'], mustHave: [], niceToHave: [] }), [], rankCandidates(packIntentSchema.parse({ goal: 'x', features: ['quest book'], mustHave: [], niceToHave: [] }), [quests]))
  assert.equal(full.nearMiss.length, 0, 'a candidate covering everything is not a near miss')
  assert.equal(full.authorFromScratch, false)
})

test('runDiscovery merges both registries, dedupes queries and degrades per registry', async () => {
  let searches = 0
  const reader: RegistryReader = {
    search: async ({ registry }) => {
      searches++
      if (registry === 'curseforge') throw new Error('no key')
      return [quests]
    },
    versions: async () => [],
    project: async () => { throw new Error('unused') }
  }
  const result = await runDiscovery(reader, { intent, target, registries: ['modrinth', 'curseforge'], limit: 5 })
  assert.equal(result.candidates.length, 1, 'the same project found by several queries is one candidate')
  assert.equal(result.candidates[0].registry, 'modrinth')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /curseforge/i)
  assert.ok(result.queries.length > 1)
  assert.ok(searches > result.queries.length, 'each query is sent to each selected registry')
})

test('an empty intent still produces a usable report instead of dividing by zero', () => {
  const empty = packIntentSchema.parse({ goal: 'just a vibe', features: [], mustHave: [], niceToHave: [] })
  const report = buildGapReport(empty, [], rankCandidates(empty, [sodium]))
  assert.equal(report.coverage, 1)
  assert.deepEqual(report.missing, [])
  assert.equal(report.authorFromScratch, false)
})
