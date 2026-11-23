import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BASELINE_ALLOWED_CATEGORIES,
  BUILTIN_BASELINE,
  GAP_COVERAGE_THRESHOLD,
  baselineGroupsOf,
  baselineProfileSchema,
  baselineSlugs,
  checkBaselineEntry,
  emptyPackLock,
  emptyPackManifest,
  lockDrift,
  packIntentSchema,
  packLockSchema,
  packManifestSchema
} from '../../packages/modcrafting-core/src/pack-model.ts'

const entry = (overrides: Partial<{ entryId: string; fileName: string }> = {}) => ({
  entryId: overrides.entryId ?? 'sodium',
  fileName: overrides.fileName ?? 'sodium-0.6.0.jar',
  source: 'modrinth' as const,
  hashes: { sha512: 'a'.repeat(128) },
  license: { id: 'MIT', redistributable: true },
  enabled: true
})

test('a new manifest starts with the baseline selected but no entries', () => {
  const manifest = emptyPackManifest({ name: 'Sky Pack', targetId: 'fabric@1.21.4' })
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.version, '0.1.0')
  assert.deepEqual(manifest.baselineGroups, ['performance', 'qol'])
  assert.deepEqual(manifest.entries, [])
  assert.equal(packManifestSchema.safeParse(manifest).success, true)
})

test('manifest rejects duplicate entries and unstable version strings', () => {
  const base = emptyPackManifest({ name: 'P', targetId: 'fabric@1.21.4' })

  assert.equal(packManifestSchema.safeParse({ ...base, entries: [entry(), entry({ entryId: 'other' })] }).success, false)
  assert.equal(packManifestSchema.safeParse({ ...base, entries: [entry(), entry({ entryId: 'other', fileName: 'SODIUM-0.6.0.jar' })] }).success, false)
  assert.equal(packManifestSchema.safeParse({ ...base, version: 'latest' }).success, false)
  assert.equal(packManifestSchema.safeParse({ ...base, version: '1.0.0-beta.1' }).success, true)
  assert.equal(packManifestSchema.safeParse({ ...base, targetId: 'fabric' }).success, false)
  // An unknown key is a typo, not something to silently drop.
  assert.equal(packManifestSchema.safeParse({ ...base, extra: true }).success, false)
})

test('lockfile records enough to reproduce a pack offline', () => {
  const lock = emptyPackLock('fabric@1.21.4', '2026-11-19T00:00:00.000Z')
  assert.equal(packLockSchema.safeParse(lock).success, true)

  const pinned = {
    ...lock,
    entries: [{
      entryId: 'sodium',
      fileName: 'sodium-0.6.0.jar',
      downloadUrl: 'https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar',
      hashes: { sha1: 'b'.repeat(40), sha512: 'c'.repeat(128) },
      size: 1024,
      side: 'client',
      license: { id: 'LGPL-3.0-only', redistributable: false },
      dependencies: [{ projectId: 'P7dR8mSH', kind: 'required', versionId: 'abc' }]
    }]
  }
  assert.equal(packLockSchema.safeParse(pinned).success, true)
  // A local-only entry cannot be reproduced, and saying so is part of the contract.
  assert.equal(packLockSchema.safeParse({ ...lock, entries: [{ ...pinned.entries[0], downloadUrl: null }] }).success, true)
  assert.equal(packLockSchema.safeParse({ ...lock, entries: [{ ...pinned.entries[0], downloadUrl: 'not-a-url' }] }).success, false)
})

test('drift between manifest and lockfile is reported both ways', () => {
  const manifest = { ...emptyPackManifest({ name: 'P', targetId: 'fabric@1.21.4' }), entries: [entry(), entry({ entryId: 'lithium', fileName: 'lithium.jar' })] }
  const lock = { ...emptyPackLock('fabric@1.21.4', '2026-11-19T00:00:00.000Z'), entries: [{ ...entry(), downloadUrl: null, dependencies: [] } as never] }

  assert.deepEqual(lockDrift(manifest, lock), { missingInLock: ['lithium'], extraInLock: [] })
  assert.deepEqual(lockDrift({ ...manifest, entries: [] }, lock), { missingInLock: [], extraInLock: ['sodium'] })
  assert.deepEqual(lockDrift(manifest, lock).missingInLock.length + lockDrift(manifest, lock).extraInLock.length, 1)
})

test('the shipped baseline profile is valid and covers the three groups', () => {
  assert.equal(baselineProfileSchema.safeParse(BUILTIN_BASELINE).success, true)
  assert.deepEqual(BUILTIN_BASELINE.groups.map((group) => group.id), ['performance', 'visual', 'qol'])

  const selected = baselineGroupsOf(BUILTIN_BASELINE, ['qol', 'performance', 'missing'])
  assert.deepEqual(selected.map((group) => group.id), ['qol', 'performance'], 'unknown ids are skipped, not invented')

  const slugs = baselineSlugs(baselineGroupsOf(BUILTIN_BASELINE, ['performance', 'visual']))
  assert.equal(new Set(slugs.map((value) => value.slug)).size, slugs.length, 'a slug must not repeat across groups')
  assert.equal(slugs.find((value) => value.slug === 'sodium')?.required, true)
  assert.equal(slugs.find((value) => value.slug === 'iris')?.required, false)
})

test('baseline refuses gameplay mods, server-only mods and known conflicts', () => {
  const tech = checkBaselineEntry({ slug: 'create', categories: ['technology', 'decoration'], environment: 'client_and_server' })
  assert.equal(tech.ok, false)
  if (!tech.ok) {
    assert.equal(tech.code, 'BASELINE_OFF_GENRE')
    assert.match(tech.message, /technology/)
    assert.match(tech.message, /正式成员/, 'the message must say what to do instead')
  }

  const server = checkBaselineEntry({ slug: 'chunky', categories: ['optimization', 'utility'], environment: 'server_only' })
  assert.equal(server.ok, false)
  if (!server.ok) assert.equal(server.code, 'BASELINE_SIDE_UNSUPPORTED')

  const conflict = checkBaselineEntry({ slug: 'sodium', categories: ['optimization'], environment: 'client_only', present: ['optifine'] })
  assert.equal(conflict.ok, false)
  if (!conflict.ok) {
    assert.equal(conflict.code, 'BASELINE_CONFLICT')
    assert.match(conflict.message, /渲染管线/)
  }

  const missingRequirement = checkBaselineEntry({ slug: 'iris', categories: ['decoration'], environment: 'client_only', present: ['sodium', 'continuity'] })
  assert.equal(missingRequirement.ok, true, 'sodium is present, so iris is fine')

  const orphan = checkBaselineEntry({ slug: 'iris', categories: ['decoration'], environment: 'client_only', present: [] })
  assert.equal(orphan.ok, false)
  if (!orphan.ok) assert.equal(orphan.code, 'BASELINE_CONFLICT')
})

test('an unfamiliar mod is accepted with a warning instead of being blocked', () => {
  const unknownSide = checkBaselineEntry({ slug: 'mystery', categories: ['optimization'], environment: 'unknown' })
  assert.equal(unknownSide.ok, true)
  if (unknownSide.ok) assert.match(unknownSide.warning ?? '', /没有声明/)

  const oddCategory = checkBaselineEntry({ slug: 'mystery', categories: ['random'], environment: 'client_only' })
  assert.equal(oddCategory.ok, true)
  if (oddCategory.ok) assert.match(oddCategory.warning ?? '', /不在底座的推荐范围内/)

  const clean = checkBaselineEntry({ slug: 'sodium', categories: ['optimization'], environment: 'client_only' })
  assert.deepEqual(clean, { ok: true })
})

test('allowed and forbidden baseline categories do not overlap', () => {
  for (const category of BASELINE_ALLOWED_CATEGORIES) {
    assert.equal(
      (['adventure', 'technology', 'magic', 'worldgen', 'mobs', 'equipment', 'food', 'storage'] as readonly string[]).includes(category),
      false,
      `${category} cannot be both allowed and forbidden`
    )
  }
})

test('an intent requires a goal and keeps features bounded', () => {
  assert.equal(packIntentSchema.safeParse({ goal: '做一个轻量空岛包', features: ['任务引导'], mustHave: [], niceToHave: [] }).success, true)
  assert.equal(packIntentSchema.safeParse({ goal: '', features: [], mustHave: [], niceToHave: [] }).success, false)
  assert.equal(packIntentSchema.safeParse({ goal: 'x', features: [], mustHave: [], niceToHave: [] }).success, true)
  assert.equal(
    packIntentSchema.safeParse({ goal: 'x', features: Array.from({ length: 41 }, (_, index) => `f${index}`), mustHave: [], niceToHave: [] }).success,
    false,
    'a 41-feature intent is a sign the request was not decomposed'
  )
  assert.equal(GAP_COVERAGE_THRESHOLD > 0 && GAP_COVERAGE_THRESHOLD < 1, true)
})
