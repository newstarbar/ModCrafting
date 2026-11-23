import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACK_MANIFEST_FILE, emptyPackLock, emptyPackManifest } from '../../packages/modcrafting-core/src/pack-model.ts'
import {
  addPackEntries,
  createPack,
  loadPackWorkspace,
  readPackLock,
  removePackEntries,
  savePackManifest,
  setPackEntryEnabled,
  writePackLock
} from '../../packages/modcrafting-core/src/pack/pack-workspace.ts'
import type { PackEntry } from '../../packages/modcrafting-core/src/workspace-model.ts'

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-pack-'))
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
    ...overrides
  }
}

test('create writes a validated pack.json once and load reports it', () => {
  withRoot((root) => {
    const created = createPack(root, { name: 'My Pack', targetId: 'fabric@1.21.4' })
    assert.equal(created.manifest.name, 'My Pack')
    assert.deepEqual(created.manifest.entries, [])
    assert.ok(existsSync(path.join(root, PACK_MANIFEST_FILE)))
    assert.equal(codeOf(() => createPack(root, { name: 'Again', targetId: 'fabric@1.21.4' })), 'PACK_EXISTS')

    const loaded = loadPackWorkspace(root)
    assert.equal(loaded.manifest.targetId, 'fabric@1.21.4')
    assert.equal(loaded.revision, created.revision)
    assert.equal(loaded.lock, null)
    assert.equal(loaded.drift, null)
  })
})

test('load on a directory without pack.json explains how to start', () => {
  withRoot((root) => {
    assert.equal(codeOf(() => loadPackWorkspace(root)), 'PACK_NOT_FOUND')
  })
})

test('saving an existing manifest requires the revision it was read from', () => {
  withRoot((root) => {
    const created = createPack(root, { name: 'Pack', targetId: 'fabric@1.21.4' })
    const next = { ...created.manifest, notes: 'edited' }

    assert.equal(codeOf(() => savePackManifest(root, { manifest: next, expectedRevision: undefined as unknown as string })), 'PACK_REVISION_REQUIRED')
    const stale = 'f'.repeat(64)
    assert.equal(codeOf(() => savePackManifest(root, { manifest: next, expectedRevision: stale })), 'PACK_REVISION_CONFLICT')

    const saved = savePackManifest(root, { manifest: next, expectedRevision: created.revision })
    assert.notEqual(saved.revision, created.revision)
    assert.equal(loadPackWorkspace(root).manifest.notes, 'edited')
  })
})

test('adding entries is idempotent by entryId and rejects a jar name collision', () => {
  withRoot((root) => {
    let workspace = createPack(root, { name: 'Pack', targetId: 'fabric@1.21.4' })

    const first = addPackEntries(root, { entries: [entry('moda')], expectedRevision: workspace.revision })
    assert.equal(first.added, 1)
    assert.equal(first.replaced, 0)
    workspace = first.workspace

    const again = addPackEntries(root, { entries: [entry('moda')], expectedRevision: workspace.revision })
    assert.equal(again.added, 0)
    assert.equal(again.replaced, 1)
    assert.equal(again.workspace.manifest.entries.length, 1)
    workspace = again.workspace

    // A different project whose author reused the same file name cannot be added:
    // the pack installer would overwrite a jar, so this is a hard stop.
    const collision = entry('other', { fileName: 'moda-1.0.jar' })
    assert.equal(codeOf(() => addPackEntries(root, { entries: [collision], expectedRevision: workspace.revision })), 'PACK_ENTRY_FILE_CONFLICT')
    assert.equal(loadPackWorkspace(root).manifest.entries.length, 1)
  })
})

test('removing and disabling entries both go through the revision check', () => {
  withRoot((root) => {
    let workspace = createPack(root, { name: 'Pack', targetId: 'fabric@1.21.4' })
    workspace = addPackEntries(root, { entries: [entry('moda'), entry('libx')], expectedRevision: workspace.revision }).workspace

    const disabled = setPackEntryEnabled(root, { entryId: 'libx', enabled: false, expectedRevision: workspace.revision })
    assert.equal(disabled.manifest.entries.find((row) => row.entryId === 'libx')?.enabled, false)
    workspace = disabled

    assert.equal(codeOf(() => setPackEntryEnabled(root, { entryId: 'nope', enabled: true, expectedRevision: workspace.revision })), 'PACK_ENTRY_NOT_FOUND')

    const removed = removePackEntries(root, { entryIds: ['libx'], expectedRevision: workspace.revision })
    assert.deepEqual(removed.removed, ['libx'])
    assert.deepEqual(removed.workspace.manifest.entries.map((row) => row.entryId), ['moda'])
  })
})

test('the lockfile round-trips and load reports drift against the manifest', () => {
  withRoot((root) => {
    const workspace = createPack(root, { name: 'Pack', targetId: 'fabric@1.21.4' })
    const lock = {
      ...emptyPackLock('fabric@1.21.4', '2026-11-23T00:00:00.000Z'),
      entries: [{
        entryId: 'moda',
        fileName: 'moda-1.0.jar',
        projectId: 'moda',
        versionId: 'moda-1',
        downloadUrl: 'https://cdn.modrinth.com/moda.jar',
        hashes: { sha1: 'a'.repeat(40) },
        license: { id: 'MIT', redistributable: true },
        dependencies: []
      }]
    }
    const written = writePackLock(root, lock)
    assert.deepEqual(written.lock, lock)
    assert.deepEqual(readPackLock(root), lock)

    const drifted = addPackEntries(root, { entries: [entry('libx')], expectedRevision: workspace.revision }).workspace
    assert.deepEqual(drifted.drift, { missingInLock: ['libx'], extraInLock: ['moda'] })
  })
})

test('an invalid manifest is rejected without overwriting the file', () => {
  withRoot((root) => {
    mkdirSync(root, { recursive: true })
    const invalid = { ...emptyPackManifest({ name: 'Broken', targetId: 'fabric@1.21.4' }), entries: [entry('moda'), entry('moda')] }
    const file = path.join(root, PACK_MANIFEST_FILE)
    writeFileSync(file, `${JSON.stringify(invalid, null, 2)}\n`, 'utf8')
    const before = readFileSync(file, 'utf8')

    assert.equal(codeOf(() => loadPackWorkspace(root)), 'PACK_INVALID')
    const fixed = { ...invalid, entries: [entry('moda')] }
    const current = readFileSync(file, 'utf8')
    assert.equal(before, current)
    assert.equal(codeOf(() => savePackManifest(root, { manifest: fixed, expectedRevision: '0'.repeat(64) })), 'PACK_REVISION_CONFLICT')
    assert.equal(readFileSync(file, 'utf8'), before)
  })
})
