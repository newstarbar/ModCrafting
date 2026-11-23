import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_BASELINE, baselineProfileSchema } from '../../packages/modcrafting-core/src/pack-model.ts'
import { BASELINE_FILE, baselineEntries, readBaselineProfile, resolveBaseline, writeBaselineProfile } from '../../packages/modcrafting-core/src/pack/pack-baseline.ts'
import type { RegistryReader } from '../../packages/modcrafting-core/src/pack/registry-client.ts'
import type { RegistryProject, RegistryVersion } from '../../packages/modcrafting-core/src/pack/registry-model.ts'

const target = { loader: 'fabric' as const, minecraft: '1.21.4' }

function project(projectId: string, overrides: Partial<RegistryProject> = {}): RegistryProject {
  return {
    registry: 'modrinth',
    projectId,
    slug: projectId,
    title: projectId,
    description: '',
    categories: ['optimization'],
    downloads: 1000,
    updatedAt: '2026-01-01T00:00:00Z',
    license: { id: 'MIT', redistributable: true },
    environment: 'client_only',
    loaders: ['fabric'],
    gameVersions: ['1.21.4'],
    url: `https://modrinth.com/mod/${projectId}`,
    ...overrides
  }
}

function version(projectId: string, overrides: Partial<RegistryVersion> = {}): RegistryVersion {
  return {
    registry: 'modrinth',
    projectId,
    versionId: `${projectId}-1`,
    name: `${projectId} 1.0`,
    versionNumber: '1.0',
    gameVersions: ['1.21.4'],
    loaders: ['fabric'],
    channel: 'release',
    publishedAt: '2026-01-01T00:00:00Z',
    files: [{
      fileName: `${projectId}-1.0.jar`,
      primary: true,
      size: 1024,
      hashes: { sha512: 'a'.repeat(128) },
      url: `https://cdn.modrinth.com/${projectId}.jar`
    }],
    dependencies: [],
    license: { id: 'MIT', redistributable: true },
    ...overrides
  }
}

function readerFor(projects: RegistryProject[], versions: RegistryVersion[]): RegistryReader {
  return {
    project: async ({ projectId }) => {
      const found = projects.find((entry) => entry.projectId === projectId)
      if (!found) throw new Error(`PROJECT_NOT_FOUND: ${projectId}`)
      return found
    },
    versions: async ({ projectId, loader, gameVersion }) => versions.filter((entry) =>
      entry.projectId === projectId &&
      (!loader || entry.loaders.includes(loader)) &&
      (!gameVersion || entry.gameVersions.includes(gameVersion))
    ),
    search: async () => projects
  }
}

test('the baseline profile falls back to the shipped groups and persists a validated override', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-baseline-'))
  try {
    assert.deepEqual(readBaselineProfile(root), BUILTIN_BASELINE)
    const custom = baselineProfileSchema.parse({
      schemaVersion: 1,
      groups: [{ id: 'performance', label: '性能', description: '', entries: [{ slug: 'sodium', required: true, reason: '测试' }] }]
    })
    writeBaselineProfile(root, custom)
    assert.deepEqual(readBaselineProfile(root), custom)
    assert.equal(BASELINE_FILE.endsWith('baseline.json'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a required entry with no build is reported as missing, not silently dropped', async () => {
  const profile = baselineProfileSchema.parse({
    schemaVersion: 1,
    groups: [{
      id: 'performance', label: '性能', description: '',
      entries: [
        { slug: 'sodium', required: true, reason: '渲染' },
        { slug: 'lithium', required: true, reason: '逻辑' },
        { slug: 'ferrite-core', required: true, reason: '内存' }
      ]
    }]
  })
  const reader = readerFor(
    [project('sodium'), project('lithium')],
    [version('sodium'), version('lithium')]
  )
  const result = await resolveBaseline(reader, { profile, groupIds: ['performance'], target })
  assert.deepEqual(result.picks.map((pick) => pick.slug), ['sodium', 'lithium'])
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].slug, 'ferrite-core')
  assert.equal(result.missing[0].required, true)
  assert.match(result.missing[0].reason, /没有找到/)
  assert.equal(result.entries.length, 2)
  assert.equal(result.entries[0].source, 'baseline')
  assert.equal(result.entries[0].license.id, 'MIT')
})

test('a loader-specific replacement is used when the Fabric slug has no NeoForge build', async () => {
  const profile = baselineProfileSchema.parse({
    schemaVersion: 1,
    groups: [{ id: 'performance', label: '性能', description: '', entries: [{ slug: 'sodium', required: true, reason: '渲染' }] }]
  })
  const neoforgeTarget = { loader: 'neoforge' as const, minecraft: '1.21.4' }
  const embeddium = project('embeddium', { slug: 'embeddium', loaders: ['neoforge'] })
  const reader = readerFor([embeddium], [version('embeddium', { loaders: ['neoforge'] })])
  const result = await resolveBaseline(reader, { profile, groupIds: ['performance'], target: neoforgeTarget })
  assert.equal(result.picks.length, 1)
  assert.equal(result.picks[0].requestedSlug, 'sodium')
  assert.equal(result.picks[0].slug, 'embeddium')
  assert.equal(result.picks[0].alternative, true)
  assert.equal(result.entries[0].fileName, 'embeddium-1.0.jar')
})

test('a mutex pair is rejected with the reason, and an optional blocked entry is a warning', async () => {
  const profile = baselineProfileSchema.parse({
    schemaVersion: 1,
    groups: [{
      id: 'performance', label: '性能', description: '',
      entries: [
        { slug: 'sodium', required: true, reason: '渲染' },
        { slug: 'optifine', required: false, reason: '旧渲染' }
      ]
    }]
  })
  const reader = readerFor(
    [project('sodium'), project('optifine', { title: 'OptiFine' })],
    [version('sodium'), version('optifine')]
  )
  const result = await resolveBaseline(reader, { profile, groupIds: ['performance'], target })
  assert.deepEqual(result.picks.map((pick) => pick.slug), ['sodium'])
  assert.equal(result.missing.length, 0, 'an optional entry is not a required gap')
  assert.ok(result.warnings.some((warning) => /渲染管线/.test(warning)))
})

test('entries keep hashes, licence and the client side from the registry data', () => {
  const entries = baselineEntries([{
    slug: 'sodium',
    requestedSlug: 'sodium',
    group: 'performance',
    required: true,
    alternative: false,
    projectId: 'AANobbMI',
    project: project('AANobbMI'),
    version: version('AANobbMI'),
    file: version('AANobbMI').files[0],
    reason: '渲染'
  }])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].entryId, 'sodium')
  assert.equal(entries[0].source, 'baseline')
  assert.equal(entries[0].side, 'client')
  assert.equal(entries[0].hashes.sha512, 'a'.repeat(128))
  assert.equal(entries[0].enabled, true)
})

test('a profile with duplicate group ids is rejected before anything is written', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-baseline-'))
  try {
    const duplicate = { schemaVersion: 1 as const, groups: [BUILTIN_BASELINE.groups[0], BUILTIN_BASELINE.groups[0]] }
    assert.throws(() => writeBaselineProfile(root, duplicate as never), /不能重复/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
