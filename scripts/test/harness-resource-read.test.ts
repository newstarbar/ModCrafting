import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recipeWorkspace } from '../../packages/modcrafting-core/src/recipe-workspace.ts'
import { validateRecipeContent } from '../../packages/modcrafting-core/src/recipe-format.ts'
import { lookupMinecraftData, resolveKnowledgeIndex } from '../../packages/modcrafting-core/src/node.ts'
import { availableVisualVersions, resolveVisualVersion } from '../../packages/modcrafting-core/src/visual-assets.ts'
import { createRuntimePaths, ensureRuntimePaths } from '../../packages/modcrafting-core/src/node.ts'
import { projectRuntimePaths } from '../../packages/modcrafting-core/src/runtime.ts'
import type { RuntimePaths } from '../../packages/modcrafting-core/src/contracts.ts'

interface Fixture { root: string; project: string; paths: RuntimePaths }

async function fixture(t: { after: (fn: () => Promise<void>) => void }, minecraft: string, items: string[]): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = createRuntimePaths(path.join(root, 'data'))
  await ensureRuntimePaths(paths)
  const project = path.join(root, 'project')
  mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'read_test', version: '1', depends: { minecraft } }))
  writeFileSync(path.join(project, 'gradle.properties'), `minecraft_version=${minecraft}\n`)
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture')
  // Recipe reads resolve knowledge inside the project; direct lookups use the backend root.
  const index = JSON.stringify({ itemsById: Object.fromEntries(items.map((id) => [id, { id, name: id }])) })
  for (const knowledgeRoot of [projectRuntimePaths(paths, project).knowledgeRoot, paths.knowledgeRoot]) {
    const knowledge = path.join(knowledgeRoot, 'minecraft-data', minecraft)
    mkdirSync(knowledge, { recursive: true })
    writeFileSync(path.join(knowledge, 'index.json'), index)
  }
  return { root, project, paths }
}

const shaped = (resultField: 'id' | 'item', ingredient: 'string' | 'object') => JSON.stringify({
  type: 'minecraft:crafting_shaped',
  pattern: ['AA'],
  key: { A: ingredient === 'string' ? 'minecraft:iron_ingot' : { item: 'minecraft:iron_ingot' } },
  result: { [resultField]: 'read_test:gem', count: 1 }
}, null, 2) + '\n'

test('a 1.20.1 project saves recipes into the plural recipes directory', async (t) => {
  const f = await fixture(t, '1.20.1', ['minecraft:iron_ingot', 'read_test:gem'])
  const saved = recipeWorkspace(f.paths, { action: 'save', projectPath: f.project, recipeId: 'read_test:gem', expectedRevision: null, content: shaped('item', 'object') })
  const document = saved.document as { file: string; minecraft: string; editable: boolean }
  assert.equal(document.file, 'src/main/resources/data/read_test/recipes/gem.json')
  assert.equal(document.minecraft, '1.20.1')
  assert.equal(document.editable, true)
  assert.equal(existsSync(path.join(f.project, document.file)), true)

  const listed = recipeWorkspace(f.paths, { action: 'list', projectPath: f.project }).recipes as Array<{ recipeId: string; inTargetDialect?: boolean }>
  assert.deepEqual(listed.map((row) => row.recipeId), ['read_test:gem'])
  assert.equal(listed[0].inTargetDialect, true)
})

test('a 1.21.4 project saves recipes into the singular recipe directory', async (t) => {
  const f = await fixture(t, '1.21.4', ['minecraft:iron_ingot', 'read_test:gem'])
  const saved = recipeWorkspace(f.paths, { action: 'save', projectPath: f.project, recipeId: 'read_test:gem', expectedRevision: null, content: shaped('id', 'string') })
  assert.equal((saved.document as { file: string }).file, 'src/main/resources/data/read_test/recipe/gem.json')
})

test('legacy dialect content is valid for 1.20.1 and invalid for 1.21.4', () => {
  const legacy = shaped('item', 'object')
  assert.equal(validateRecipeContent(legacy, { mcVersion: '1.20.1' }).valid, true)
  const modern = validateRecipeContent(legacy, { mcVersion: '1.21.4' })
  assert.equal(modern.valid, false)
  assert.ok(modern.errors.some((error) => error.includes('result.id')), modern.errors.join('; '))
})

test('a recipe left in the wrong directory is readable, flagged, and moved only on save', async (t) => {
  const f = await fixture(t, '1.21.4', ['minecraft:iron_ingot', 'read_test:gem'])
  const legacyDir = path.join(f.project, 'src/main/resources/data/read_test/recipes')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(path.join(legacyDir, 'gem.json'), shaped('id', 'string'))

  const read = recipeWorkspace(f.paths, { action: 'read', projectPath: f.project, recipeId: 'read_test:gem' }).document as { revision: string; inTargetDialect: boolean; warnings: string[] }
  assert.equal(read.inTargetDialect, false)
  assert.ok(read.warnings.some((warning) => warning.includes('游戏不会加载')), read.warnings.join('; '))

  const saved = recipeWorkspace(f.paths, { action: 'save', projectPath: f.project, recipeId: 'read_test:gem', expectedRevision: read.revision, content: shaped('id', 'string') })
  assert.equal((saved.document as { file: string }).file, 'src/main/resources/data/read_test/recipe/gem.json')
  assert.equal(saved.migrationRequired, true)
  assert.equal(saved.legacyFile, 'src/main/resources/data/read_test/recipes/gem.json')
  // The legacy file stays until an explicit migration; nothing is deleted behind the user's back.
  assert.equal(existsSync(path.join(legacyDir, 'gem.json')), true)
})

test('knowledge resolution is exact, nearest, or an explicit refusal', async (t) => {
  const f = await fixture(t, '1.21.4', ['minecraft:stone'])
  const exact = resolveKnowledgeIndex(f.paths.knowledgeRoot, '1.21.4')
  assert.equal(exact?.exact, true)
  const nearest = resolveKnowledgeIndex(f.paths.knowledgeRoot, '1.20.1')
  assert.equal(nearest?.exact, false)
  assert.equal(nearest?.minecraft, '1.21.4')
  assert.equal(resolveKnowledgeIndex(f.paths.knowledgeRoot)?.exact, true, 'no requested version means the newest index satisfies it')

  const refused = lookupMinecraftData(f.paths, 'item', 'stone', { minecraft: '1.20.1' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'KNOWLEDGE_VERSION_UNAVAILABLE')
  assert.deepEqual(refused.availableVersions, ['1.21.4'])

  const fallback = lookupMinecraftData(f.paths, 'item', 'stone', { minecraft: '1.20.1', allowFallback: true })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.exact, false)
  assert.equal(fallback.dataVersion, '1.21.4')
})

test('visual assets ignore markers written by a different version', async (t) => {
  const f = await fixture(t, '1.21.4', ['minecraft:stone'])
  const base = path.join(f.paths.assetsRoot, 'minecraft-textures')
  for (const [dir, marker] of [['1.21.4', '1.21.4'], ['1.20.1', '1.21.4']] as const) {
    mkdirSync(path.join(base, dir), { recursive: true })
    writeFileSync(path.join(base, dir, '.visuals-ready.json'), JSON.stringify({ schema: 1, version: marker }))
  }
  assert.deepEqual(availableVisualVersions(f.paths), ['1.21.4'], 'a stale marker must not make 1.20.1 look ready')

  const exact = resolveVisualVersion(f.paths, '1.21.4')
  assert.equal(exact.exact, true)
  assert.equal(exact.version, '1.21.4')

  const fallback = resolveVisualVersion(f.paths, '1.20.1')
  assert.equal(fallback.exact, false)
  assert.equal(fallback.version, '1.21.4')
  assert.deepEqual(fallback.available, ['1.21.4'])
})
