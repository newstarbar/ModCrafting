import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { curseforgeFile, curseforgeSearch } from '../../packages/modcrafting-core/src/pack/adapters/curseforge.ts'
import { modrinthSearch, modrinthVersions } from '../../packages/modcrafting-core/src/pack/adapters/modrinth.ts'
import { licenseFor } from '../../packages/modcrafting-core/src/pack/license-policy.ts'
import { RegistryError, createRegistryClient, type RegistryReader } from '../../packages/modcrafting-core/src/pack/registry-client.ts'

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry')
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'))

test('permissive licenses are redistributable; unknown and reserved ones are not', () => {
  assert.deepEqual(licenseFor('MIT'), { id: 'MIT', redistributable: true })
  assert.deepEqual(licenseFor('LGPL-3.0-only'), { id: 'LGPL-3.0-only', redistributable: true })
  assert.deepEqual(licenseFor('Apache-2.0'), { id: 'Apache-2.0', redistributable: true })
  assert.deepEqual(licenseFor('All-Rights-Reserved'), { id: 'All-Rights-Reserved', redistributable: false })
  assert.deepEqual(licenseFor('Custom-EULA'), { id: 'Custom-EULA', redistributable: false })
  assert.deepEqual(licenseFor(''), { id: 'Unknown', redistributable: false })
})

test('Modrinth search hits normalize environment, loaders, versions and license', () => {
  const [sodium, quests] = modrinthSearch(fixture('modrinth-search.json'))
  assert.equal(sodium.registry, 'modrinth')
  assert.equal(sodium.projectId, 'AANobbMI')
  assert.equal(sodium.slug, 'sodium')
  assert.equal(sodium.environment, 'client_only')
  assert.deepEqual(sodium.loaders, ['fabric'])
  assert.deepEqual(sodium.gameVersions, ['1.21.4'])
  assert.deepEqual(sodium.categories, ['optimization'], 'loader tags are not gameplay categories')
  assert.deepEqual(sodium.license, { id: 'LGPL-3.0-only', redistributable: true })
  assert.equal(sodium.url, 'https://modrinth.com/mod/sodium')

  assert.equal(quests.environment, 'client_and_server')
  assert.deepEqual(quests.license, { id: 'All-Rights-Reserved', redistributable: false })
})

test('Modrinth versions normalize dependencies, files and channel', () => {
  const [sodium] = modrinthSearch(fixture('modrinth-search.json'))
  const [version] = modrinthVersions(fixture('modrinth-versions.json'), sodium)
  assert.equal(version.versionId, 'ver-sodium-060')
  assert.equal(version.versionNumber, '0.6.0')
  assert.deepEqual(version.loaders, ['fabric'])
  assert.deepEqual(version.gameVersions, ['1.21.4'])
  assert.equal(version.channel, 'release')
  assert.deepEqual(version.dependencies, [{ projectId: 'P7dR8mSH', versionId: 'ver-fabric-api', kind: 'required' }])
  assert.equal(version.files.length, 1)
  assert.equal(version.files[0].primary, true)
  assert.equal(version.files[0].fileName, 'sodium-0.6.0.jar')
  assert.match(version.files[0].hashes.sha1 ?? '', /^a{40}$/)
  assert.match(version.files[0].hashes.sha512 ?? '', /^b{128}$/)
  assert.equal(version.license.redistributable, true, 'the version inherits the project license')
})

test('CurseForge search hits normalize loaders, versions and distribution permission', () => {
  const [jei, closed] = curseforgeSearch(fixture('curseforge-search.json'))
  assert.equal(jei.registry, 'curseforge')
  assert.equal(jei.projectId, '238222')
  assert.deepEqual(jei.loaders, ['fabric'])
  assert.deepEqual(jei.gameVersions, ['1.21.4'])
  assert.deepEqual(jei.license, { id: 'CurseForge-Author-Allowed', redistributable: true })
  assert.equal(jei.environment, 'unknown', 'CurseForge does not declare a side')
  assert.equal(closed.license.redistributable, false)
  assert.deepEqual(closed.loaders, ['neoforge'])
})

test('CurseForge files map relations and keep a null download URL as local-only', () => {
  const [jei, closed] = curseforgeSearch(fixture('curseforge-search.json'))
  const files = fixture('curseforge-files.json') as { data: unknown[] }
  const jeiVersion = curseforgeFile(files.data[0], jei)
  assert.equal(jeiVersion.versionId, '7001')
  assert.deepEqual(jeiVersion.dependencies, [
    { projectId: '123456', kind: 'required' },
    { projectId: '654321', kind: 'optional' }
  ], 'relation type 4 is a tool, not a player-facing dependency')
  assert.equal(jeiVersion.files[0].url, 'https://edge.forgecdn.net/files/7001/jei-1.21.4.jar')
  assert.deepEqual(jeiVersion.loaders, ['fabric'])
  assert.deepEqual(jeiVersion.gameVersions, ['1.21.4'])

  const closedVersion = curseforgeFile(files.data[1], closed)
  assert.equal(closedVersion.files[0].url, null, 'the file may be installed locally but never exported by URL')
  assert.equal(closedVersion.license.redistributable, false)
})

test('the registry client caches a response and replays it offline', async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-registry-'))
  try {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify(fixture('modrinth-search.json')), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const options = { cacheRoot, fetchImpl, minIntervalMs: 0, now: () => 1_700_000_000_000 }
    const client = createRegistryClient(options)
    const first = await client.search({ registry: 'modrinth', query: 'optimization', loader: 'fabric', gameVersion: '1.21.4' })
    const second = await client.search({ registry: 'modrinth', query: 'optimization', loader: 'fabric', gameVersion: '1.21.4' })
    assert.equal(calls, 1, 'the second identical search must come from cache')
    assert.deepEqual(second, first)

    const offline = createRegistryClient({ ...options, offline: true, fetchImpl: (async () => { throw new Error('network disabled') }) as typeof fetch })
    const replay = await offline.search({ registry: 'modrinth', query: 'optimization', loader: 'fabric', gameVersion: '1.21.4' })
    assert.deepEqual(replay, first, 'offline mode must replay the cached response')
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('CurseForge without a key fails with an actionable error', async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-registry-'))
  try {
    const client = createRegistryClient({ cacheRoot, minIntervalMs: 0, fetchImpl: (async () => new Response('{}')) as typeof fetch })
    await assert.rejects(
      client.search({ registry: 'curseforge', query: 'jei' }),
      (error: unknown) => error instanceof RegistryError && error.code === 'REGISTRY_MISSING_KEY' && /MODCRAFTING_CURSEFORGE_API_KEY/.test(error.remediation)
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('a 429 from a registry becomes a rate-limit error, not a silent empty result', async () => {
  const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-registry-'))
  try {
    const client = createRegistryClient({
      cacheRoot,
      minIntervalMs: 0,
      curseforgeApiKey: 'test-key',
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'slow down' }), { status: 429 })) as typeof fetch
    })
    await assert.rejects(
      client.search({ registry: 'curseforge', query: 'jei' }),
      (error: unknown) => error instanceof RegistryError && error.code === 'REGISTRY_RATE_LIMITED'
    )
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true })
  }
})

test('the reader interface is what discovery consumes, not the HTTP client', () => {
  const reader: RegistryReader = {
    search: async () => [],
    versions: async () => [],
    project: async () => { throw new Error('unused') }
  }
  assert.equal(typeof reader.search, 'function')
})
