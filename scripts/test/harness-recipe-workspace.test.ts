import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { createRuntimePaths, ensureRuntimePaths, FabricRuntime, recipeWorkspace, newRecipeDraft, recipeContentFromDraft, recipeDraftFromContent, type RecipeDocument, type RecipeRequest } from '../../packages/modcrafting-core/src/index.ts'
import { startBrowserView } from '../../plugins/modcrafting-fabric/src/browser-server.ts'

function fixture() {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/recipe-unit-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths); mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'recipe_test', version: '1', depends: { minecraft: '1.21.4' } }))
  writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture')
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({ itemsById: { 'minecraft:iron_ingot': { name: 'Iron Ingot', stackSize: 64 }, 'minecraft:gold_ingot': { name: 'Gold Ingot', stackSize: 64 }, 'minecraft:air': { name: 'Air', stackSize: 64 } } }))
  const call = (request: Record<string, unknown>) => recipeWorkspace(paths, { ...request, projectPath: project } as RecipeRequest)
  const draft = newRecipeDraft(); draft.grid[0][0] = { itemId: 'minecraft:iron_ingot', count: 1 }; draft.outputItem = 'minecraft:gold_ingot'; draft.outputCount = 2
  return { root, project, paths, call, draft, content: recipeContentFromDraft(draft) }
}
test('Recipe round-trip preserves metadata and rejects stale Agent/browser revisions', () => {
  const f = fixture(), first = f.call({ action: 'save', recipeId: 'recipe_test:exchange', expectedRevision: null, content: f.content }).document as RecipeDocument
  assert.equal(first.file, 'src/main/resources/data/recipe_test/recipe/exchange.json')
  assert.equal((f.call({ action: 'list' }).recipes as RecipeDocument[]).length, 1)
  const base = JSON.parse(first.content); base.group = 'custom'; base.category = 'equipment'; base.show_notification = false; base.result.components = { 'minecraft:custom_name': '"Token"' }
  const second = f.call({ action: 'save', recipeId: first.recipeId, expectedRevision: first.revision, content: JSON.stringify(base) }).document as RecipeDocument
  const draft = recipeDraftFromContent(second.content); draft.outputCount = 3
  const third = f.call({ action: 'save', recipeId: first.recipeId, expectedRevision: second.revision, content: recipeContentFromDraft(draft, second.content) }).document as RecipeDocument
  assert.equal(JSON.parse(third.content).result.count, 3); assert.equal(JSON.parse(third.content).show_notification, false); assert.equal(JSON.parse(third.content).group, 'custom'); assert.deepEqual(JSON.parse(third.content).result.components, base.result.components)
  assert.equal(JSON.parse(third.content).category, 'equipment')
  assert.throws(() => f.call({ action: 'save', recipeId: first.recipeId, expectedRevision: second.revision, content: first.content }), /外部修改/)
  assert.equal(readFileSync(path.join(f.project, third.file), 'utf8'), third.content)
  assert.throws(() => f.call({ action: 'save', recipeId: first.recipeId, expectedRevision: null, content: first.content }), /外部修改/)
})
test('Five existing recipe formats and tag ingredients retain 1.21.4 semantics', () => {
  const f = fixture()
  for (const type of ['shaped', 'shapeless', 'smelting', 'blasting', 'stonecutting'] as const) {
    const content = recipeContentFromDraft({ ...f.draft, type, outputCount: type === 'smelting' || type === 'blasting' ? 1 : 2 })
    const document = f.call({ action: 'save', recipeId: `recipe_test:${type}`, expectedRevision: null, content }).document as RecipeDocument
    assert.ok(document.editable); assert.equal(recipeDraftFromContent(document.content).type, type); assert.equal(recipeDraftFromContent(document.content).grid[0][0].itemId, 'minecraft:iron_ingot')
  }
  const tag = structuredClone(f.draft); tag.grid[0][0].itemId = '#minecraft:planks'
  const saved = f.call({ action: 'save', recipeId: 'recipe_test:tagged', expectedRevision: null, content: recipeContentFromDraft(tag) }).document as RecipeDocument
  assert.equal(recipeDraftFromContent(saved.content).grid[0][0].itemId, '#minecraft:planks')
})
test('Unknown recipe serializers stay read-only and cannot be overwritten', () => {
  const f = fixture(), directory = path.join(f.project, 'src/main/resources/data/recipe_test/recipe'); mkdirSync(directory, { recursive: true })
  const content = JSON.stringify({ type: 'othermod:special', ingredient: ['minecraft:iron_ingot'], custom: 'preserve' }); writeFileSync(path.join(directory, 'custom.json'), content)
  const document = f.call({ action: 'read', recipeId: 'recipe_test:custom' }).document as RecipeDocument
  assert.equal(document.editable, false)
  assert.throws(() => f.call({ action: 'save', recipeId: document.recipeId, expectedRevision: document.revision, content: f.content }), /只读/)
  assert.equal(readFileSync(path.join(directory, 'custom.json'), 'utf8'), content)
})
test('Recipe writes reject traversals, linked paths, air, unknown items and excessive output', () => {
  const f = fixture()
  for (const id of ['recipe_test:../../escape', 'recipe_test:a/../b', 'recipe_test:/b', 'recipe_test:a//b']) assert.throws(() => f.call({ action: 'read', recipeId: id }), /路径穿越/)
  for (const change of [{ key: { A: 'minecraft:air' } }, { key: { A: 'minecraft:missing_item' } }, { result: { id: 'minecraft:gold_ingot', count: 65 } }]) {
    assert.throws(() => f.call({ action: 'save', recipeId: 'recipe_test:bad', expectedRevision: null, content: JSON.stringify({ ...JSON.parse(f.content), ...change }) }))
  }
  const outside = path.join(f.root, 'outside'); mkdirSync(outside)
  mkdirSync(path.join(f.project, 'src/main/resources/data'), { recursive: true }); symlinkSync(outside, path.join(f.project, 'src/main/resources/data/linked'), 'junction')
  assert.throws(() => f.call({ action: 'save', recipeId: 'linked:escape', expectedRevision: null, content: f.content }), /链接|junction/)
})
test('Browser save and Core Agent read use the same versioned file; revision is mandatory', async t => {
  const f = fixture(), runtime = new FabricRuntime({ paths: f.paths, version: 'recipe-test' }), view = await startBrowserView(runtime, { html: '', js: '', css: '' })
  t.after(async () => { runtime.close(); await view.close() })
  const sessionId = runtime.createSession({ name: 'recipe browser fixture', projectPath: f.project }).sessionId
  const url = new URL(view.url), headers = { authorization: 'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('token'), 'content-type': 'application/json', 'x-modcrafting-session': sessionId, 'x-modcrafting-backend': runtime.backendId }
  const response = await fetch(url.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ operation: 'recipe', request: { action: 'save', projectPath: f.project, recipeId: 'recipe_test:browser', expectedRevision: null, content: f.content } }) })
  const saved = await response.json() as { ok: boolean; document: RecipeDocument }; assert.ok(saved.ok)
  assert.deepEqual(f.call({ action: 'read', recipeId: 'recipe_test:browser' }).document, saved.document)
  const bad = await fetch(url.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ operation: 'recipe', request: { action: 'save', projectPath: f.project, recipeId: 'recipe_test:browser', content: f.content } }) })
  assert.equal(bad.status, 400)
})
