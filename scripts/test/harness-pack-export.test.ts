import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyPackLock, type LockedEntry } from '../../packages/modcrafting-core/src/pack-model.ts'
import { addPackEntries, createPack, writePackLock } from '../../packages/modcrafting-core/src/pack/pack-workspace.ts'
import { createZip, readZip } from '../../packages/modcrafting-core/src/pack/zip.ts'
import { exportPack } from '../../packages/modcrafting-core/src/pack/pack-export.ts'
import type { PackEntry } from '../../packages/modcrafting-core/src/workspace-model.ts'

const generatedAt = '2026-11-23T00:00:00.000Z'

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-export-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (cause) {
    return (cause as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_ERROR'
}

function entry(projectId: string, overrides: Partial<PackEntry> = {}): PackEntry {
  return {
    entryId: projectId,
    fileName: `${projectId}-1.0.jar`,
    source: 'modrinth',
    projectId,
    versionId: `${projectId}-1`,
    hashes: { sha1: 'a'.repeat(40) },
    license: { id: 'MIT', redistributable: true },
    enabled: true,
    side: 'client',
    ...overrides
  }
}

function locked(entryId: string, overrides: Partial<LockedEntry> = {}): LockedEntry {
  return {
    entryId,
    fileName: `${entryId}-1.0.jar`,
    projectId: entryId,
    versionId: `${entryId}-1`,
    downloadUrl: `https://cdn.modrinth.com/${entryId}.jar`,
    hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
    size: 2048,
    side: 'client',
    license: { id: 'MIT', redistributable: true },
    dependencies: [],
    ...overrides
  }
}

function setupPack(root: string): void {
  let workspace = createPack(root, { name: 'Sample Pack', version: '1.2.3', targetId: 'fabric@1.21.4' })
  workspace = addPackEntries(root, {
    entries: [
      entry('sodium'),
      entry('custom', {
        source: 'local',
        projectId: undefined,
        versionId: undefined,
        license: { id: 'All-Rights-Reserved', redistributable: false }
      })
    ],
    expectedRevision: workspace.revision
  }).workspace
  writePackLock(root, {
    ...emptyPackLock(workspace.manifest.targetId, generatedAt),
    entries: [
      locked('sodium'),
      locked('custom', { projectId: undefined, versionId: undefined, downloadUrl: null, license: { id: 'All-Rights-Reserved', redistributable: false } })
    ]
  })
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'config', 'example.json'), '{"enabled":true}\n', 'utf8')
  mkdirSync(path.join(root, 'defaultconfigs'), { recursive: true })
  writeFileSync(path.join(root, 'defaultconfigs', 'example.toml'), 'key = "value"\n', 'utf8')
  mkdirSync(path.join(root, 'mods'), { recursive: true })
  writeFileSync(path.join(root, 'mods', 'sodium-1.0.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  writeFileSync(path.join(root, 'mods', 'custom-1.0.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
}

test('the zip writer round-trips UTF-8 paths and bytes and is deterministic', () => {
  const entries = [
    { path: 'a.txt', data: 'hello' },
    { path: '目录/b.json', data: Buffer.from('{"x":1}') }
  ]
  const first = createZip(entries)
  const second = createZip(entries)
  assert.deepEqual(first, second)
  const read = readZip(first)
  assert.deepEqual(read.map((row) => row.path), ['a.txt', '目录/b.json'])
  assert.equal(read[0].data.toString('utf8'), 'hello')
  assert.equal(read[1].data.toString('utf8'), '{"x":1}')
})

test('the zip writer refuses traversal paths and the reader refuses garbage', () => {
  assert.equal(codeOf(() => createZip([{ path: '../evil.txt', data: 'x' }])), 'ZIP_PATH_UNSAFE')
  assert.equal(codeOf(() => createZip([{ path: '/abs.txt', data: 'x' }])), 'ZIP_PATH_UNSAFE')
  assert.equal(codeOf(() => createZip([{ path: 'a.txt', data: 'x' }, { path: 'a.txt', data: 'y' }])), 'ZIP_DUPLICATE_PATH')
  assert.equal(codeOf(() => readZip(Buffer.from('not a zip'))), 'ZIP_INVALID')
})

test('mrpack export writes a Valid index, overrides, and warns about non-downloadable entries', () => {
  withRoot((root) => {
    setupPack(root)
    const result = exportPack({ root, kind: 'mrpack', generatedAt })
    assert.equal(result.kind, 'mrpack')
    assert.ok(result.file.endsWith('.mrpack'))
    const zip = readZip(readFileSync(result.file))
    const paths = zip.map((row) => row.path)
    assert.ok(paths.includes('modrinth.index.json'))
    assert.ok(paths.includes('overrides/config/example.json'))
    assert.ok(paths.includes('overrides/defaultconfigs/example.toml'))

    const index = JSON.parse(zip.find((row) => row.path === 'modrinth.index.json')!.data.toString('utf8'))
    assert.equal(index.formatVersion, 1)
    assert.equal(index.game, 'minecraft')
    assert.equal(index.name, 'Sample Pack')
    assert.equal(index.versionId, '1.2.3')
    assert.equal(index.dependencies.minecraft, '1.21.4')
    assert.equal(index.dependencies['fabric-loader'], '0.20.1')
    assert.deepEqual(index.files.map((file: { path: string }) => file.path), ['mods/sodium-1.0.jar'])
    assert.deepEqual(index.files[0].downloads, ['https://cdn.modrinth.com/sodium.jar'])
    assert.deepEqual(index.files[0].env, { client: 'required', server: 'unsupported' })
    assert.ok(result.warnings.some((warning) => /custom/.test(warning)))
    assert.ok(!paths.some((value) => value.includes('custom')))
  })
})

test('prism export produces a recognizable instance and never copies non-redistributable bytes', () => {
  withRoot((root) => {
    setupPack(root)
    const result = exportPack({ root, kind: 'prism', generatedAt })
    assert.equal(path.basename(result.file), 'sample-pack-1.2.3')
    const mmc = JSON.parse(readFileSync(path.join(result.file, 'mmc-pack.json'), 'utf8'))
    assert.deepEqual(mmc.components.map((row: { uid: string }) => row.uid), ['net.minecraft', 'net.fabricmc.fabric-loader'])
    assert.equal(mmc.components[0].version, '1.21.4')
    assert.equal(mmc.components[1].version, '0.20.1')
    assert.match(readFileSync(path.join(result.file, 'instance.cfg'), 'utf8'), /name=Sample Pack/)
    assert.equal(readFileSync(path.join(result.file, 'minecraft', 'config', 'example.json'), 'utf8'), '{"enabled":true}\n')
    assert.ok(existsSync(path.join(result.file, 'minecraft', 'mods', 'sodium-1.0.jar')))
    assert.ok(!existsSync(path.join(result.file, 'minecraft', 'mods', 'custom-1.0.jar')))
    assert.ok(result.warnings.some((warning) => /custom/.test(warning)))
  })
})

test('export refuses a stale or missing lock and refuses to overwrite by default', () => {
  withRoot((root) => {
    let workspace = createPack(root, { name: 'Sample Pack', version: '1.2.3', targetId: 'fabric@1.21.4' })
    workspace = addPackEntries(root, { entries: [entry('sodium')], expectedRevision: workspace.revision }).workspace
    assert.equal(codeOf(() => exportPack({ root, kind: 'mrpack', generatedAt })), 'PACK_LOCK_MISSING')

    writePackLock(root, { ...emptyPackLock(workspace.manifest.targetId, generatedAt), entries: [locked('sodium')] })
    const first = exportPack({ root, kind: 'mrpack', generatedAt })
    assert.ok(existsSync(first.file))
    assert.equal(codeOf(() => exportPack({ root, kind: 'mrpack', generatedAt })), 'EXPORT_EXISTS')
    assert.ok(exportPack({ root, kind: 'mrpack', generatedAt, overwrite: true }).bytes > 0)

    addPackEntries(root, { entries: [entry('libx')], expectedRevision: workspace.revision })
    assert.equal(codeOf(() => exportPack({ root, kind: 'mrpack', generatedAt, overwrite: true })), 'PACK_LOCK_STALE')
  })
})

test('export keeps output inside the pack and can be told the loader version explicitly', () => {
  withRoot((root) => {
    setupPack(root)
    assert.equal(codeOf(() => exportPack({ root, kind: 'mrpack', outputDir: os.tmpdir(), generatedAt })), 'EXPORT_PATH_FORBIDDEN')
  })

  withRoot((root) => {
    let workspace = createPack(root, { name: 'Edge', version: '0.1.0', targetId: 'fabric@1.99.9' })
    workspace = addPackEntries(root, { entries: [entry('sodium')], expectedRevision: workspace.revision }).workspace
    writePackLock(root, { ...emptyPackLock(workspace.manifest.targetId, generatedAt), entries: [locked('sodium')] })
    assert.equal(codeOf(() => exportPack({ root, kind: 'mrpack', generatedAt })), 'EXPORT_LOADER_VERSION_REQUIRED')
    const result = exportPack({ root, kind: 'mrpack', generatedAt, loaderVersion: '0.16.9' })
    const index = JSON.parse(readZip(readFileSync(result.file)).find((row) => row.path === 'modrinth.index.json')!.data.toString('utf8'))
    assert.equal(index.dependencies['fabric-loader'], '0.16.9')
  })
})
