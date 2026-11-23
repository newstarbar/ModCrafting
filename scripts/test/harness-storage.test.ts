import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cacheRootForDrive,
  cleanStorage,
  configureStorage,
  ensureStorageDirs,
  gradleHomeFor,
  isStorageCacheRoot,
  migrateStorage,
  parseWindowsDriveList,
  readStorageConfig,
  resolveStorage,
  storageFilePath,
  storageUsage,
  temporaryDirectoryFor,
  visualGradleHomes,
  writeStorageConfig,
  STORAGE_MARKER,
  type StorageStatus
} from '../../packages/modcrafting-core/src/storage.ts'
import { FabricRuntime, FABRIC_TARGET, createRuntimePaths, SystemToolchainProvider } from '../../packages/modcrafting-core/src/index.ts'

const GB = 1024 ** 3

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-storage-'))
  const c = path.join(root, 'drive-c'), e = path.join(root, 'drive-e'), f = path.join(root, 'drive-f')
  for (const drive of [c, e, f]) mkdirSync(drive, { recursive: true })
  const driveOf = (value: string): string => {
    const resolved = path.resolve(value).toLowerCase()
    for (const drive of [c, e, f]) if (resolved === drive.toLowerCase() || resolved.startsWith(drive.toLowerCase() + path.sep)) return drive
    return c
  }
  return { root, c, e, f, driveOf, dataRoot: path.join(c, 'data'), project: path.join(e, 'project') }
}

function freeMap(entries: Record<string, number>) {
  return async (root: string): Promise<number | undefined> => {
    const key = path.resolve(root).toLowerCase()
    for (const [name, value] of Object.entries(entries)) if (path.resolve(name).toLowerCase() === key) return value
    return undefined
  }
}

test('MODCRAFTING_CACHE is an absolute storage root and outranks every other setting', async () => {
  const f = fixture(), target = path.join(f.root, 'explicit-cache')
  const status = await resolveStorage({
    dataRoot: f.dataRoot, projectPath: f.project, env: { MODCRAFTING_CACHE: target },
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 4 * GB })
  })
  assert.equal(status.cacheRoot, path.resolve(target))
  assert.equal(status.gradleUserHome, gradleHomeFor(path.resolve(target)))
  assert.equal(status.temporaryDirectory, temporaryDirectoryFor(path.resolve(target)))
  assert.equal(status.source, 'env')
  assert.equal(status.managed, true)
  assert.equal(existsSync(status.cacheRoot), false, 'inspection must not create directories')
})

test('a relative MODCRAFTING_CACHE is ignored with a warning instead of failing the plugin', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: { MODCRAFTING_CACHE: 'relative/cache' },
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.source, 'default')
  assert.match(status.warning || '', /MODCRAFTING_CACHE.*绝对路径/)
})

test('GRADLE_USER_HOME is respected as an unmanaged Gradle home and keeps the plugin temp directory', async () => {
  const f = fixture(), gradle = path.join(f.root, 'custom-gradle')
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: { GRADLE_USER_HOME: gradle },
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.source, 'gradle-env')
  assert.equal(status.gradleUserHome, gradle)
  assert.equal(status.cacheRoot, gradle)
  assert.equal(status.temporaryDirectory, path.join(f.dataRoot, 'cache', 'tmp'))
  assert.equal(status.managed, false)
})

test('a GRADLE_USER_HOME that points inside a Gradle installation is reported in plain language', async () => {
  const f = fixture(), gradle = path.join(f.root, 'gradle-8.0.2', 'jars')
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: { GRADLE_USER_HOME: gradle },
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.match(status.warning || '', /Gradle 安装目录/)
})

test('a saved storage.json wins over legacy detection and can be read back', async () => {
  const f = fixture(), target = path.join(f.root, 'configured')
  mkdirSync(path.join(f.dataRoot, 'cache', 'gradle'), { recursive: true })
  writeFileSync(path.join(f.dataRoot, 'cache', 'gradle', 'stale.txt'), 'x')
  await configureStorage({
    dataRoot: f.dataRoot, env: {}, cacheRoot: target,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(readStorageConfig(f.dataRoot)?.cacheRoot, path.resolve(target))
  assert.equal(isStorageCacheRoot(target), true)
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.source, 'configured')
  assert.equal(status.cacheRoot, path.resolve(target))
})

test('an existing data/cache/gradle is reused so upgrades never force a re-download', async () => {
  const f = fixture()
  mkdirSync(path.join(f.dataRoot, 'cache', 'gradle', 'caches'), { recursive: true })
  writeFileSync(path.join(f.dataRoot, 'cache', 'gradle', 'caches', 'kept.bin'), 'x')
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.source, 'existing')
  assert.equal(status.cacheRoot, path.join(f.dataRoot, 'cache'))
  assert.equal(status.gradleUserHome, path.join(f.dataRoot, 'cache', 'gradle'))
})

test('when the data root already lives on a non-system drive, its cache directory is kept', async () => {
  const f = fixture(), dataRoot = path.join(f.e, 'data')
  const status = await resolveStorage({
    dataRoot, projectPath: f.project, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [], freeBytes: freeMap({ [f.e]: 100 * GB })
  })
  assert.equal(status.cacheRoot, path.join(dataRoot, 'cache'))
  assert.equal(status.source, 'default')
})

test('when the data root is on the system drive, a project on another drive gets the cache', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, projectPath: f.project, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 12 * GB, totalBytes: 250 * GB }, { root: f.e, freeBytes: 200 * GB, totalBytes: 500 * GB }],
    freeBytes: freeMap({ [f.c]: 12 * GB, [f.e]: 200 * GB })
  })
  assert.equal(status.cacheRoot, cacheRootForDrive(f.e))
  assert.equal(status.source, 'auto')
  assert.equal(existsSync(status.cacheRoot), false)
})

test('a cache root already marked by another host is shared instead of duplicated', async () => {
  const f = fixture(), marked = cacheRootForDrive(f.f)
  mkdirSync(marked, { recursive: true }); writeFileSync(path.join(marked, STORAGE_MARKER), '{}')
  const status = await resolveStorage({
    dataRoot: f.dataRoot, projectPath: f.project, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 10 * GB, totalBytes: 250 * GB }, { root: f.e, freeBytes: 100 * GB, totalBytes: 500 * GB }, { root: f.f, freeBytes: 400 * GB, totalBytes: 900 * GB }],
    freeBytes: freeMap({ [f.c]: 10 * GB, [f.e]: 100 * GB, [f.f]: 400 * GB })
  })
  assert.equal(status.cacheRoot, marked)
  assert.equal(status.source, 'auto')
})

test('a full system drive with no project moves the cache to the roomiest fixed drive', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 8 * GB, totalBytes: 250 * GB }, { root: f.e, freeBytes: 100 * GB, totalBytes: 500 * GB }, { root: f.f, freeBytes: 400 * GB, totalBytes: 900 * GB }],
    freeBytes: freeMap({ [f.c]: 8 * GB, [f.e]: 100 * GB, [f.f]: 400 * GB })
  })
  assert.equal(status.cacheRoot, cacheRootForDrive(f.f))
  assert.equal(status.source, 'auto')
})

test('a roomy system drive keeps the default cache without a migration warning', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.cacheRoot, path.join(f.dataRoot, 'cache'))
  assert.equal(status.source, 'default')
  assert.doesNotMatch(status.warning || '', /系统盘/)
})

test('without another usable drive the resolver falls back to the data directory and warns', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 8 * GB, totalBytes: 250 * GB }],
    freeBytes: freeMap({ [f.c]: 8 * GB })
  })
  assert.equal(status.cacheRoot, path.join(f.dataRoot, 'cache'))
  assert.equal(status.source, 'default')
  assert.match(status.warning || '', /系统盘|空间不足/)
})

test('building creates the cache, writes the share marker and persists the auto choice', async () => {
  const f = fixture()
  const status = await resolveStorage({
    dataRoot: f.dataRoot, projectPath: f.project, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 12 * GB, totalBytes: 250 * GB }, { root: f.e, freeBytes: 200 * GB, totalBytes: 500 * GB }],
    freeBytes: freeMap({ [f.c]: 12 * GB, [f.e]: 200 * GB })
  })
  assert.equal(status.source, 'auto')
  assert.equal(existsSync(status.cacheRoot), false)
  ensureStorageDirs(status)
  assert.ok(existsSync(status.gradleUserHome))
  assert.ok(existsSync(status.temporaryDirectory))
  assert.ok(existsSync(path.join(status.cacheRoot, STORAGE_MARKER)))
  const config = readStorageConfig(f.dataRoot)
  assert.equal(config?.source, 'auto'); assert.equal(config?.cacheRoot, status.cacheRoot)
  const again = await resolveStorage({
    dataRoot: f.dataRoot, projectPath: f.project, env: {}, systemDrive: f.c, driveOf: f.driveOf,
    listDrives: async () => [{ root: f.c, freeBytes: 12 * GB, totalBytes: 250 * GB }, { root: f.e, freeBytes: 200 * GB, totalBytes: 500 * GB }],
    freeBytes: freeMap({ [f.c]: 12 * GB, [f.e]: 200 * GB })
  })
  assert.equal(again.cacheRoot, status.cacheRoot)
  assert.equal(again.source, 'auto')
})

test('a saved cache root reports when an explicit environment variable still wins', async () => {
  const f = fixture(), envRoot = path.join(f.root, 'env-cache'), configured = path.join(f.root, 'configured-cache')
  const status = await configureStorage({
    dataRoot: f.dataRoot, env: { MODCRAFTING_CACHE: envRoot }, cacheRoot: configured,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(status.cacheRoot, path.resolve(envRoot))
  assert.match(status.warning || '', /MODCRAFTING_CACHE.*优先|环境变量/)
})

test('explicit cache configuration rejects relative paths and drive roots', async () => {
  const f = fixture()
  const base = { dataRoot: f.dataRoot, env: {}, systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB }) }
  await assert.rejects(configureStorage({ ...base, cacheRoot: 'relative/cache' }), /绝对路径/)
  await assert.rejects(configureStorage({ ...base, cacheRoot: path.parse(f.root).root }), /根目录/)
})

test('migration copies the active Gradle home, keeps the old directory and switches the config', async () => {
  const f = fixture(), legacy = path.join(f.dataRoot, 'cache', 'gradle'), sourceFile = path.join(legacy, 'caches', 'fixture.bin')
  mkdirSync(path.dirname(sourceFile), { recursive: true }); writeFileSync(sourceFile, Buffer.alloc(2048, 1))
  const target = path.join(f.root, 'migrated')
  const result = await migrateStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: target,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(result.from, legacy)
  assert.equal(result.to, gradleHomeFor(target))
  assert.equal(readFileSync(path.join(result.to, 'caches', 'fixture.bin')).length, 2048)
  assert.ok(existsSync(sourceFile), 'migration must keep the old cache for the user to confirm')
  assert.equal(isStorageCacheRoot(target), true)
  assert.equal(readStorageConfig(f.dataRoot)?.cacheRoot, path.resolve(target))
  assert.ok(result.bytes >= 2048)
})

test('migration refuses a target that already contains a Gradle cache', async () => {
  const f = fixture(), legacy = path.join(f.dataRoot, 'cache', 'gradle')
  mkdirSync(path.join(legacy, 'caches'), { recursive: true }); writeFileSync(path.join(legacy, 'caches', 'a.bin'), 'a')
  const target = path.join(f.root, 'occupied'); mkdirSync(gradleHomeFor(target), { recursive: true }); writeFileSync(path.join(gradleHomeFor(target), 'existing.bin'), 'x')
  await assert.rejects(migrateStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: target,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  }), /非空/)
})

test('cleanup only removes plugin-owned inactive caches and never the active one', async () => {
  const f = fixture(), active = path.join(f.root, 'active')
  await configureStorage({
    dataRoot: f.dataRoot, env: {}, cacheRoot: active,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  const marked = path.join(f.root, 'old-marked'), markedFile = path.join(marked, 'gradle', 'caches', 'old.bin')
  mkdirSync(path.dirname(markedFile), { recursive: true }); writeFileSync(markedFile, Buffer.alloc(512, 2)); writeFileSync(path.join(marked, STORAGE_MARKER), '{}')
  const cleaned = await cleanStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: marked,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.ok(cleaned.freedBytes >= 512)
  assert.equal(existsSync(markedFile), false)

  await assert.rejects(cleanStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: active,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  }), /当前活动/)

  const arbitrary = path.join(f.root, 'not-a-cache'); mkdirSync(arbitrary, { recursive: true }); writeFileSync(path.join(arbitrary, 'keep.txt'), 'keep')
  await assert.rejects(cleanStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: arbitrary,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  }), /插件缓存/)
  assert.ok(existsSync(path.join(arbitrary, 'keep.txt')))
})

test('the legacy data cache is cleanable once the active cache moved elsewhere', async () => {
  const f = fixture(), active = path.join(f.root, 'active')
  await configureStorage({
    dataRoot: f.dataRoot, env: {}, cacheRoot: active,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  const legacyFile = path.join(f.dataRoot, 'cache', 'gradle', 'caches', 'old.bin')
  mkdirSync(path.dirname(legacyFile), { recursive: true }); writeFileSync(legacyFile, Buffer.alloc(1024, 3))
  const result = await cleanStorage({
    dataRoot: f.dataRoot, env: {}, targetRoot: path.join(f.dataRoot, 'cache'),
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  assert.equal(result.freedBytes >= 1024, true)
  assert.equal(existsSync(legacyFile), false)
  assert.ok(existsSync(active), 'cleaning must not touch the active cache')
})

test('storage usage counts ordinary files and skips linked directories', async () => {
  const f = fixture(), directory = path.join(f.root, 'usage')
  mkdirSync(path.join(directory, 'nested'), { recursive: true })
  writeFileSync(path.join(directory, 'a.bin'), Buffer.alloc(100))
  writeFileSync(path.join(directory, 'nested', 'b.bin'), Buffer.alloc(200))
  const usage = await storageUsage(directory)
  assert.equal(usage.files, 2)
  assert.equal(usage.bytes, 300)
  assert.equal(usage.truncated, false)
  const linked = path.join(directory, 'linked')
  try {
    symlinkSync(path.dirname(directory), linked, 'junction')
    const guarded = await storageUsage(directory)
    assert.equal(guarded.files, 2, 'linked directories are not followed')
  } catch { /* junction creation may be unavailable; the plain case above still counts */ }
})

test('Windows drive JSON accepts arrays, single objects and malformed output', () => {
  assert.deepEqual(parseWindowsDriveList('[{"DeviceID":"C:","FreeSpace":1,"Size":2}]'), [{ root: 'C:\\', freeBytes: 1, totalBytes: 2 }])
  assert.deepEqual(parseWindowsDriveList('{"DeviceID":"E:","FreeSpace":5,"Size":9}'), [{ root: 'E:\\', freeBytes: 5, totalBytes: 9 }])
  assert.deepEqual(parseWindowsDriveList('[]'), [])
  assert.deepEqual(parseWindowsDriveList('not json'), [])
})

test('visual asset lookup follows the plugin cache, the stored choice and GRADLE_USER_HOME', async () => {
  const f = fixture(), configured = path.join(f.root, 'shared')
  await configureStorage({
    dataRoot: f.dataRoot, env: {}, cacheRoot: configured,
    systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  const homes = visualGradleHomes(f.dataRoot, { GRADLE_USER_HOME: path.join(f.root, 'host-gradle') })
  assert.equal(homes[0], gradleHomeFor(path.resolve(configured)))
  assert.ok(homes.includes(path.join(f.root, 'host-gradle')))
  assert.ok(homes.includes(path.join(f.dataRoot, 'cache', 'gradle')))
})

test('storage config writes are atomic and survive malformed files', async () => {
  const f = fixture()
  mkdirSync(f.dataRoot, { recursive: true })
  writeFileSync(storageFilePath(f.dataRoot), '{not json')
  assert.equal(readStorageConfig(f.dataRoot), undefined)
  writeStorageConfig(f.dataRoot, { schema: 1, cacheRoot: path.join(f.root, 'cache'), source: 'configured', chosenAt: new Date().toISOString() })
  assert.ok(existsSync(storageFilePath(f.dataRoot)))
  assert.equal(readdirSync(f.dataRoot).some((name) => name.endsWith('.tmp')), false)
  assert.equal(readStorageConfig(f.dataRoot)?.cacheRoot, path.resolve(path.join(f.root, 'cache')))
  rmSync(f.root, { recursive: true, force: true })
})

test('SystemToolchainProvider exposes report, write, migrate and clean storage actions', async () => {
  const f = fixture(), legacyFile = path.join(f.dataRoot, 'cache', 'gradle', 'caches', 'legacy.bin')
  mkdirSync(path.dirname(legacyFile), { recursive: true }); writeFileSync(legacyFile, Buffer.alloc(1024, 1))
  const provider = new SystemToolchainProvider(f.dataRoot, {
    env: {}, systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  const report = await provider.storageReport()
  assert.equal(report.storage.source, 'existing')
  assert.ok(report.usage.bytes >= 1024)
  const target = path.join(f.root, 'provider-target')
  const migrated = await provider.storageMigrate(target)
  assert.equal(migrated.to, gradleHomeFor(path.resolve(target)))
  const after = await provider.storageReport()
  assert.equal(after.storage.cacheRoot, path.resolve(target))
  assert.ok((after.legacy?.usage.bytes ?? 0) >= 1024, 'the old cache stays visible for confirmation')
  const cleaned = await provider.storageClean(path.join(f.dataRoot, 'cache'))
  assert.ok(cleaned.freedBytes >= 1024)
  assert.equal(existsSync(path.join(f.dataRoot, 'cache', 'gradle')), false)
  const written = await provider.storageWrite(path.join(f.root, 'written-target'))
  assert.equal(written.storage.cacheRoot, path.resolve(path.join(f.root, 'written-target')))
})

test('migration says plainly when GRADLE_USER_HOME still wins over the saved cache', async () => {
  const f = fixture(), gradleEnv = path.join(f.root, 'host-gradle')
  mkdirSync(path.join(gradleEnv, 'caches'), { recursive: true })
  writeFileSync(path.join(gradleEnv, 'caches', 'host.bin'), Buffer.alloc(256, 3))
  const provider = new SystemToolchainProvider(f.dataRoot, {
    env: { GRADLE_USER_HOME: gradleEnv }, systemDrive: f.c, driveOf: f.driveOf, listDrives: async () => [], freeBytes: freeMap({ [f.c]: 100 * GB })
  })
  const target = path.join(f.root, 'migrated-under-env')
  const migrated = await provider.storageMigrate(target)
  assert.equal(migrated.storage.source, 'gradle-env')
  assert.match(migrated.storage.warning || '', /GRADLE_USER_HOME.*优先/)
  assert.ok(existsSync(path.join(gradleHomeFor(target), 'caches', 'host.bin')))
})

test('runtime toolchain actions gate destructive storage work behind explicit confirmation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-storage-runtime-')), calls: string[] = []
  const storage: StorageStatus = {
    dataRoot: path.join(root, 'data'), cacheRoot: path.join(root, 'cache'), source: 'configured',
    gradleUserHome: gradleHomeFor(path.join(root, 'cache')), temporaryDirectory: temporaryDirectoryFor(path.join(root, 'cache')),
    managed: true, configPath: storageFilePath(path.join(root, 'data'))
  }
  const runtime = new FabricRuntime({
    paths: createRuntimePaths(storage.dataRoot), version: 'storage-fixture', toolchain: {
      status: async () => ({ ok: true, platform: process.platform, node: process.version, java: { ok: true }, gradleWrapper: true, target: FABRIC_TARGET, remediation: [], storage }),
      startGradle: async () => { throw new Error('not used') },
      storageReport: async () => { calls.push('report'); return { storage, usage: { bytes: 0, files: 0, truncated: false } } },
      storageWrite: async (cacheRoot) => { calls.push(`write:${cacheRoot}`); return { storage } },
      storageMigrate: async (cacheRoot) => { calls.push(`migrate:${cacheRoot}`); return { storage, from: 'old', to: 'new', bytes: 0, files: 0 } },
      storageClean: async (cacheRoot) => { calls.push(`clean:${cacheRoot ?? ''}`); return { storage, removed: [], freedBytes: 0 } }
    }
  })
  try {
    assert.equal((await runtime.toolchain({ action: 'storage' })).ok, true)
    await assert.rejects(runtime.toolchain({ action: 'migrate', cacheRoot: path.join(root, 'target') }), /confirm/)
    await assert.rejects(runtime.toolchain({ action: 'clean' }), /confirm/)
    await assert.rejects(runtime.toolchain({ action: 'storage-write' }), /cacheRoot/)
    assert.deepEqual(calls, ['report'])
    assert.equal((await runtime.toolchain({ action: 'storage-write', cacheRoot: path.join(root, 'target') })).ok, true)
    assert.equal((await runtime.toolchain({ action: 'migrate', cacheRoot: path.join(root, 'target'), confirm: true })).ok, true)
    assert.equal((await runtime.toolchain({ action: 'clean', cacheRoot: path.join(root, 'old'), confirm: true })).ok, true)
    assert.deepEqual(calls, ['report', `write:${path.join(root, 'target')}`, `migrate:${path.join(root, 'target')}`, `clean:${path.join(root, 'old')}`])
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }) }
})
