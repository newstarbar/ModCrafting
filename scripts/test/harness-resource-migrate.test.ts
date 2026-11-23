import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { contentWorkspace, contentRequestSchema } from '../../packages/modcrafting-core/src/content-workspace.ts'
import { recipeWorkspace } from '../../packages/modcrafting-core/src/recipe-workspace.ts'
import { newContentObject, type ContentDocument, type ContentObject } from '../../packages/modcrafting-core/src/content-model.ts'
import type { ContentRequest } from '../../packages/modcrafting-core/src/content-workspace.ts'
import { createRuntimePaths, ensureRuntimePaths } from '../../packages/modcrafting-core/src/node.ts'
import type { RuntimePaths } from '../../packages/modcrafting-core/src/contracts.ts'

interface Fixture {
  project: string
  paths: RuntimePaths
  call: (args: Record<string, unknown>) => Record<string, unknown>
  save: (value: ContentObject) => ContentDocument
  setMinecraft: (minecraft: string) => void
}

function fixture(minecraft: string): Fixture {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/migrate-unit-'))
  const project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths)
  mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'migrate_test', version: '1', depends: { minecraft }, entrypoints: { main: [] } }))
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture')
  writeFileSync(path.join(project, 'gradle.properties'), `minecraft_version=${minecraft}\n`)
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data', minecraft), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data', minecraft, 'index.json'), JSON.stringify({
    itemsById: { 'minecraft:iron_ingot': { id: 'minecraft:iron_ingot', name: 'iron_ingot' } },
    blocksById: { 'minecraft:stone': { id: 'minecraft:stone', hardness: 1.5 } }
  }))
  const call = (args: Record<string, unknown>) => contentWorkspace(paths, { projectPath: project, ...args } as ContentRequest)
  const preview = (value: ContentObject) => call({ action: 'preview', value, expectedRevision: null })
  const save = (value: ContentObject) => call({ action: 'save', value, expectedRevision: null, previewRevision: preview(value).previewRevision }).document as ContentDocument
  const setMinecraft = (next: string) => {
    writeFileSync(path.join(project, 'gradle.properties'), `minecraft_version=${next}\n`)
    // Only the version changes; rewriting the whole metadata would drop the generated entrypoint.
    const metadataFile = path.join(project, 'src/main/resources/fabric.mod.json')
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
    metadata.depends = { ...metadata.depends, minecraft: next }
    writeFileSync(metadataFile, JSON.stringify(metadata))
  }
  return { project, paths, call, save, setMinecraft }
}

const block = (name: string): ContentObject => {
  const value = newContentObject('block', 'migrate_test')
  value.id = `migrate_test:${name}`
  value.displayName = name
  return value
}

test('a saved object requests migration instead of turning read-only when the target changes', () => {
  const f = fixture('1.21.4')
  const value = block('ruby_block')
  const saved = f.save(value)
  assert.equal(saved.editable, true, saved.reason)
  assert.equal(saved.target?.minecraft, '1.21.4')
  const itemsPath = 'src/main/resources/assets/migrate_test/items/ruby_block.json'
  assert.equal(existsSync(path.join(f.project, itemsPath)), true)

  f.setMinecraft('1.20.1')
  const afterSwitch = f.call({ action: 'read', id: value.id }).document as ContentDocument
  assert.equal(afterSwitch.editable, false)
  assert.equal(afterSwitch.requiresMigration, true)
  assert.match(String(afterSwitch.reason), /migrate/)

  const result = f.call({ action: 'migrate', id: value.id, expectedRevision: afterSwitch.revision, confirm: true })
  assert.equal(result.migrated, true)
  assert.equal(result.from, '1.21.4')
  assert.equal(result.to, '1.20.1')
  const deleted = result.deleted as string[]
  assert.ok(deleted.includes(itemsPath), `1.20.1 has no item model definitions: ${JSON.stringify(deleted)}`)
  assert.ok(deleted.includes('src/main/resources/data/migrate_test/loot_table/blocks/ruby_block.json'), JSON.stringify(deleted))
  assert.equal(existsSync(path.join(f.project, itemsPath)), false)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/data/migrate_test/loot_tables/blocks/ruby_block.json')), true)

  const reread = f.call({ action: 'read', id: value.id }).document as ContentDocument
  assert.equal(reread.editable, true, reread.reason)
  assert.equal(reread.target?.minecraft, '1.20.1')
})

test('migration refuses to run when a tracked file was edited outside the editor', () => {
  const f = fixture('1.21.4')
  const value = block('tampered_block')
  f.save(value)
  f.setMinecraft('1.20.1')
  const document = f.call({ action: 'read', id: value.id }).document as ContentDocument
  writeFileSync(path.join(f.project, 'src/main/resources/assets/migrate_test/models/block/tampered_block.json'), '{"parent":"minecraft:block/cube_all"}\n')
  assert.throws(() => f.call({ action: 'migrate', id: value.id, expectedRevision: document.revision, confirm: true }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'MIGRATION_BLOCKED')
    return true
  })
})

test('a recipe in the wrong directory migrates by rewriting its dialect, not by moving bytes', () => {
  const f = fixture('1.20.1')
  const legacy = path.join(f.project, 'src/main/resources/data/migrate_test/recipe/gem.json')
  mkdirSync(path.dirname(legacy), { recursive: true })
  writeFileSync(legacy, JSON.stringify({
    type: 'minecraft:crafting_shaped',
    pattern: ['AA'],
    key: { A: { item: 'minecraft:iron_ingot' } },
    result: { item: 'migrate_test:gem', count: 1 }
  }, null, 2) + '\n')

  const read = recipeWorkspace(f.paths, { action: 'read', projectPath: f.project, recipeId: 'migrate_test:gem' }).document as { revision: string; inTargetDialect: boolean }
  assert.equal(read.inTargetDialect, false)

  const result = recipeWorkspace(f.paths, { action: 'migrate', projectPath: f.project, recipeId: 'migrate_test:gem', expectedRevision: read.revision, confirm: true })
  assert.equal(result.migrated, true)
  assert.equal(result.to, 'src/main/resources/data/migrate_test/recipes/gem.json')
  assert.equal(existsSync(legacy), false)
  const migrated = JSON.parse(readFileSync(path.join(f.project, String(result.to)), 'utf8'))
  assert.equal(typeof migrated.result.item, 'string', '1.20.1 keeps result.item')
  assert.equal(migrated.result.id, undefined)
  assert.equal(migrated.key.A.item, 'minecraft:iron_ingot', '1.20.1 keeps object ingredients')
})

test('migrate is an explicit, confirmed action', () => {
  assert.equal(contentRequestSchema.safeParse({ action: 'migrate', projectPath: '/x', id: 'a:b', expectedRevision: 'a'.repeat(64) }).success, false, 'confirm is required')
  assert.equal(contentRequestSchema.safeParse({ action: 'migrate', projectPath: '/x', id: 'a:b', expectedRevision: 'a'.repeat(64), confirm: false }).success, false)
  assert.equal(contentRequestSchema.safeParse({ action: 'migrate', projectPath: '/x', id: 'a:b', expectedRevision: 'a'.repeat(64), confirm: true }).success, true)
})
