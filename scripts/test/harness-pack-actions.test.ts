import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACK_LOCK_FILE } from '../../packages/modcrafting-core/src/pack-model.ts'
import { readPackLock, loadPackWorkspace } from '../../packages/modcrafting-core/src/pack/pack-workspace.ts'
import { packWorkspaceAction } from '../../packages/modcrafting-core/src/pack/pack-actions.ts'
import type { RegistryReader } from '../../packages/modcrafting-core/src/pack/registry-client.ts'
import type { RegistryDependency, RegistryProject, RegistryVersion } from '../../packages/modcrafting-core/src/pack/registry-model.ts'

const generatedAt = '2026-11-23T00:00:00.000Z'

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-actions-'))
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return (cause as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_ERROR'
}

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
      hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
      url: `https://cdn.modrinth.com/${projectId}.jar`
    }],
    dependencies,
    license: { id: 'MIT', redistributable: true },
    ...overrides
  }
}

function readerFor(projects: RegistryProject[], versions: RegistryVersion[]): RegistryReader {
  return {
    search: async () => projects,
    project: async ({ projectId }) => {
      const found = projects.find((entry) => entry.projectId === projectId)
      if (!found) throw new Error(`PROJECT_NOT_FOUND: ${projectId}`)
      return found
    },
    versions: async ({ projectId, loader, gameVersion }) => versions.filter((entry) =>
      entry.projectId === projectId &&
      (!loader || entry.loaders.includes(loader)) &&
      (!gameVersion || entry.gameVersions.includes(gameVersion))
    )
  }
}

test('the action layer creates, loads and revision-checks a pack', async () => {
  await withRoot(async (root) => {
    const reader = readerFor([], [])
    const created = await packWorkspaceAction(reader, { action: 'create', workspacePath: root, name: 'Action Pack', targetId: 'fabric@1.21.4' }) as { revision: string; manifest: { name: string } }
    assert.equal(created.manifest.name, 'Action Pack')

    const loaded = await packWorkspaceAction(reader, { action: 'load', workspacePath: root }) as { revision: string }
    assert.equal(loaded.revision, created.revision)

    assert.equal(await codeOf(() => packWorkspaceAction(reader, {
      action: 'remove_entries', workspacePath: root, entryIds: [], expectedRevision: '0'.repeat(64)
    })), 'PACK_REVISION_CONFLICT')
  })
})

test('adding a candidate resolves its version, then solve writes a lock and export produces a package', async () => {
  await withRoot(async (root) => {
    const reader = readerFor([project('moda')], [version('moda')])
    const created = await packWorkspaceAction(reader, { action: 'create', workspacePath: root, name: 'Action Pack', targetId: 'fabric@1.21.4' }) as { revision: string }

    const added = await packWorkspaceAction(reader, {
      action: 'add_candidate', workspacePath: root, registry: 'modrinth', projectId: 'moda', expectedRevision: created.revision
    }) as { revision: string; entry: { entryId: string; side: string; license: { id: string }; hashes: { sha512?: string } } }
    assert.equal(added.entry.entryId, 'moda')
    assert.equal(added.entry.side, 'client')
    assert.equal(added.entry.license.id, 'MIT')
    assert.equal(added.entry.hashes.sha512, 'b'.repeat(128))

    const solved = await packWorkspaceAction(reader, { action: 'solve', workspacePath: root, generatedAt }) as { verdict: string; wrote: boolean; lock: { entries: Array<{ entryId: string }> } }
    assert.equal(solved.verdict, 'satisfied')
    assert.equal(solved.wrote, true)
    assert.deepEqual(solved.lock.entries.map((entry) => entry.entryId), ['moda'])
    assert.ok(existsSync(path.join(root, PACK_LOCK_FILE)))

    const exported = await packWorkspaceAction(reader, { action: 'export', workspacePath: root, kind: 'mrpack', generatedAt }) as { file: string; bytes: number }
    assert.ok(exported.bytes > 0)
    assert.ok(existsSync(exported.file))
  })
})

test('a conflict is reported but never written as a lockfile', async () => {
  await withRoot(async (root) => {
    const reader = readerFor([], [version('moda', [{ projectId: 'bad', kind: 'incompatible' }]), version('bad')])
    const created = await packWorkspaceAction(reader, { action: 'create', workspacePath: root, name: 'Action Pack', targetId: 'fabric@1.21.4' }) as { revision: string }
    const entries = [
      { entryId: 'moda', fileName: 'moda-1.0.jar', source: 'modrinth', projectId: 'moda', versionId: 'moda-1', hashes: { sha1: 'a'.repeat(40) }, license: { id: 'MIT', redistributable: true }, enabled: true },
      { entryId: 'bad', fileName: 'bad-1.0.jar', source: 'modrinth', projectId: 'bad', versionId: 'bad-1', hashes: { sha1: 'a'.repeat(40) }, license: { id: 'MIT', redistributable: true }, enabled: true }
    ]
    const added = await packWorkspaceAction(reader, { action: 'add_entries', workspacePath: root, entries, expectedRevision: created.revision }) as { revision: string }

    const solved = await packWorkspaceAction(reader, { action: 'solve', workspacePath: root, generatedAt }) as { verdict: string; wrote: boolean }
    assert.equal(solved.verdict, 'conflict')
    assert.equal(solved.wrote, false)
    assert.equal(readPackLock(root), undefined)
    assert.equal(loadPackWorkspace(root).revision, added.revision)
  })
})

test('a gap still writes a lock so the resolved part stays reproducible', async () => {
  await withRoot(async (root) => {
    const reader = readerFor([], [version('moda', [{ projectId: 'libx', kind: 'required' }])])
    const created = await packWorkspaceAction(reader, { action: 'create', workspacePath: root, name: 'Action Pack', targetId: 'fabric@1.21.4' }) as { revision: string }
    const entries = [{ entryId: 'moda', fileName: 'moda-1.0.jar', source: 'modrinth', projectId: 'moda', versionId: 'moda-1', hashes: { sha1: 'a'.repeat(40) }, license: { id: 'MIT', redistributable: true }, enabled: true }]
    await packWorkspaceAction(reader, { action: 'add_entries', workspacePath: root, entries, expectedRevision: created.revision })

    const solved = await packWorkspaceAction(reader, { action: 'solve', workspacePath: root, generatedAt }) as { verdict: string; wrote: boolean; missing: string[] }
    assert.equal(solved.verdict, 'gap')
    assert.equal(solved.wrote, true)
    assert.deepEqual(solved.missing, ['libx'])
    assert.ok(readPackLock(root))
  })
})

test('adding an unknown project or one with no compatible build gives an actionable code', async () => {
  await withRoot(async (root) => {
    const reader = readerFor([project('nope', { gameVersions: ['1.20.1'] })], [version('nope', [], { gameVersions: ['1.20.1'] })])
    const created = await packWorkspaceAction(reader, { action: 'create', workspacePath: root, name: 'Action Pack', targetId: 'fabric@1.21.4' }) as { revision: string }
    assert.equal(await codeOf(() => packWorkspaceAction(reader, {
      action: 'add_candidate', workspacePath: root, registry: 'modrinth', projectId: 'missing', expectedRevision: created.revision
    })), 'PROJECT_NOT_FOUND')
    assert.equal(await codeOf(() => packWorkspaceAction(reader, {
      action: 'add_candidate', workspacePath: root, registry: 'modrinth', projectId: 'nope', expectedRevision: created.revision
    })), 'NO_COMPATIBLE_VERSION')
  })
})
