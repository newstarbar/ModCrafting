import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyPackManifest, type PackManifest } from '../../packages/modcrafting-core/src/pack-model.ts'
import { solvePack, solvePackWithRegistry } from '../../packages/modcrafting-core/src/pack/pack-solver.ts'
import type { RegistryReader } from '../../packages/modcrafting-core/src/pack/registry-client.ts'
import type { RegistryDependency, RegistryVersion } from '../../packages/modcrafting-core/src/pack/registry-model.ts'
import type { PackEntry } from '../../packages/modcrafting-core/src/workspace-model.ts'

const target = { loader: 'fabric' as const, minecraft: '1.21.4' }
const generatedAt = '2026-11-23T00:00:00.000Z'

function entry(projectId: string, overrides: Partial<PackEntry> = {}): PackEntry {
  return {
    entryId: projectId,
    fileName: `${projectId}.jar`,
    source: 'modrinth',
    projectId,
    versionId: `${projectId}-1`,
    hashes: { sha1: 'a'.repeat(40) },
    license: { id: 'MIT', redistributable: true },
    enabled: true,
    ...overrides
  }
}

function manifest(entries: PackEntry[]): PackManifest {
  return { ...emptyPackManifest({ name: 'Test Pack', targetId: 'fabric@1.21.4' }), entries }
}

function version(projectId: string, dependencies: RegistryDependency[] = [], overrides: Partial<RegistryVersion> = {}): RegistryVersion {
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
      hashes: { sha1: 'b'.repeat(40), sha512: 'c'.repeat(128) },
      url: `https://cdn.modrinth.com/${projectId}.jar`
    }],
    dependencies,
    license: { id: 'MIT', redistributable: true },
    ...overrides
  }
}

const versions = (rows: RegistryVersion[]) => new Map(rows.map((row) => [row.projectId, [row]]))

test('required dependencies are closed into the lock; optional ones are skipped with a warning', () => {
  const result = solvePack({
    manifest: manifest([entry('moda')]),
    target,
    generatedAt,
    versions: versions([
      version('moda', [
        { projectId: 'libx', kind: 'required' },
        { projectId: 'opty', kind: 'optional' }
      ]),
      version('libx')
    ])
  })
  assert.equal(result.verdict, 'satisfied')
  assert.deepEqual(result.lock.entries.map((row) => row.entryId).sort(), ['libx', 'moda'])
  assert.ok(result.lock.entries.some((row) => row.entryId === 'libx' && row.downloadUrl === 'https://cdn.modrinth.com/libx.jar'))
  assert.ok(result.lock.warnings.some((warning) => /opty/.test(warning)), 'an optional dependency must be visible, not invisible')
  assert.equal(result.findings.filter((finding) => finding.verdict !== 'satisfied').length, 0)
})

test('a declared incompatible dependency is a conflict with an actionable message', () => {
  const result = solvePack({
    manifest: manifest([entry('moda'), entry('bad')]),
    target,
    generatedAt,
    versions: versions([
      version('moda', [{ projectId: 'bad', kind: 'incompatible' }]),
      version('bad')
    ])
  })
  assert.equal(result.verdict, 'conflict')
  const finding = result.findings.find((row) => row.code === 'DECLARED_INCOMPATIBLE')
  assert.ok(finding)
  assert.equal(finding.verdict, 'conflict')
  assert.match(finding.message, /bad/)
})

test('a missing required dependency is a gap and names the missing project', () => {
  const result = solvePack({
    manifest: manifest([entry('moda')]),
    target,
    generatedAt,
    versions: versions([version('moda', [{ projectId: 'libx', kind: 'required' }])])
  })
  assert.equal(result.verdict, 'gap')
  assert.deepEqual(result.missing, ['libx'])
  const finding = result.findings.find((row) => row.code === 'MISSING_DEPENDENCY')
  assert.ok(finding)
  assert.equal(finding.projectId, 'libx')
})

test('a pinned version that no longer exists is unsatisfiable instead of silently upgraded', () => {
  const result = solvePack({
    manifest: manifest([entry('moda', { versionId: 'moda-removed' })]),
    target,
    generatedAt,
    versions: versions([version('moda')])
  })
  assert.equal(result.verdict, 'unsatisfiable')
  assert.ok(result.findings.some((finding) => finding.code === 'PINNED_VERSION_UNAVAILABLE'))
})

test('a local entry is locked as local-only and cannot silently become reproducible', () => {
  const local: PackEntry = {
    entryId: 'mybridge',
    fileName: 'mybridge-1.0.jar',
    source: 'local',
    hashes: { sha1: 'd'.repeat(40) },
    license: { id: 'MIT', redistributable: true },
    enabled: true
  }
  const result = solvePack({ manifest: manifest([local]), target, generatedAt, versions: new Map() })
  const locked = result.lock.entries.find((row) => row.entryId === 'mybridge')
  assert.ok(locked)
  assert.equal(locked.downloadUrl, null)
  assert.ok(result.lock.warnings.some((warning) => /本地/.test(warning)))
})

test('the lock is deterministic for a fixed generatedAt', () => {
  const input = {
    manifest: manifest([entry('moda')]),
    target,
    generatedAt,
    versions: versions([version('moda', [{ projectId: 'libx', kind: 'required' }]), version('libx')])
  }
  assert.deepEqual(solvePack(input), solvePack(input))
})

test('solvePackWithRegistry fetches a dependency discovered in an earlier round', async () => {
  const calls: string[] = []
  const reader: RegistryReader = {
    search: async () => [],
    project: async ({ projectId }) => { throw new Error(`unexpected project ${projectId}`) },
    versions: async ({ projectId }) => {
      calls.push(projectId)
      if (projectId === 'moda') return [version('moda', [{ projectId: 'libx', kind: 'required' }])]
      if (projectId === 'libx') return [version('libx')]
      return []
    }
  }
  const result = await solvePackWithRegistry(reader, { manifest: manifest([entry('moda')]), target, generatedAt })
  assert.equal(result.verdict, 'satisfied')
  assert.ok(result.lock.entries.some((row) => row.entryId === 'libx'))
  assert.deepEqual(calls, ['moda', 'libx'])
})
