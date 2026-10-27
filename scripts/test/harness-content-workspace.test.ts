import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRuntimePaths, ensureRuntimePaths, contentWorkspace, newContentObject, contentObjectSchema, contentKinds, type ContentRequest, type ContentDocument, type ContentObject } from '../../packages/modcrafting-core/src/index.ts'

function fixture() {
  mkdirSync('temp', { recursive: true }); const root = mkdtempSync(path.resolve('temp/content-unit-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths); mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'content_test', version: '1', depends: { minecraft: '1.21.4' }, entrypoints: { main: ['custom.Existing', { adapter: 'kotlin', value: 'custom.Kotlin' }] } }))
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture'); writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({ itemsById: Object.fromEntries(['iron_ingot', 'apple', 'iron_pickaxe', 'iron_chestplate', 'diamond_sword', 'diamond_pickaxe', 'diamond_chestplate'].map(id => ['minecraft:' + id, { id: 'minecraft:' + id, name: id }])), blocksById: { 'minecraft:stone': { id: 'minecraft:stone', hardness: 1.5 } }, entitiesById: { 'minecraft:pig': { id: 'minecraft:pig' }, 'minecraft:zombie': { id: 'minecraft:zombie' } } }))
  const call = (args: Record<string, unknown>) => contentWorkspace(paths, { projectPath: project, ...args } as ContentRequest)
  const preview = (value: ContentObject, expectedRevision: string | null = null) => call({ action: 'preview', value, expectedRevision })
  const save = (value: ContentObject, expectedRevision: string | null = null) => call({ action: 'save', value, expectedRevision, previewRevision: preview(value, expectedRevision).previewRevision }).document as ContentDocument
  return { root, project, paths, call, save, preview, value: newContentObject('item', 'content_test') }
}
test('Content templates expose all validated defaults without writing project files', () => {
  const f = fixture()
  for (const kind of contentKinds) {
    const template = f.call({ action: 'template', kind })
    assert.equal(contentObjectSchema.safeParse(template.value).success, true)
    assert.deepEqual(template.value, newContentObject(kind, 'content_test'))
    assert.ok(Array.isArray(template.fields) && template.fields.length > 0)
  }
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content')), false)
})

test('Six declarative types round-trip without replacing existing entrypoints, sources or other objects', () => {
  const f = fixture()
  for (const kind of contentKinds) {
    const value = newContentObject(kind, 'content_test'); value.id = 'content_test:r3_' + kind
    assert.ok(contentObjectSchema.safeParse(value).success, kind)
    const document = f.save(value); assert.equal(document.editable, true, document.reason); assert.deepEqual(document.value, value)
    assert.equal((f.call({ action: 'read', id: value.id }).document as ContentDocument).editable, true)
  }
  assert.equal((f.call({ action: 'list' }).documents as ContentDocument[]).length, 6)
  const metadata = JSON.parse(readFileSync(path.join(f.project, 'src/main/resources/fabric.mod.json'), 'utf8'))
  assert.equal(metadata.entrypoints.main[0], 'custom.Existing'); assert.deepEqual(metadata.entrypoints.main[1], { adapter: 'kotlin', value: 'custom.Kotlin' }); assert.equal(metadata.entrypoints.main.length, 8)
  const item = f.call({ action: 'read', id: 'content_test:r3_item' }).document as ContentDocument
  const changed = { ...item.value!, displayName: '调整名称', parameters: { ...item.value!.parameters, maxStackSize: 16 } }
  assert.deepEqual(f.save(changed, item.revision).value, changed)
  const lang = JSON.parse(readFileSync(path.join(f.project, 'src/main/resources/assets/content_test/lang/zh_cn.json'), 'utf8')); assert.equal(Object.keys(lang).length, 6)
})
test('Preview is read-only, mandatory on save, and detects changes in shared files after confirmation', () => {
  const f = fixture(), planned = f.preview(f.value)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content')), false)
  const file = path.join(f.project, 'src/main/resources/fabric.mod.json'), content = readFileSync(file, 'utf8'); writeFileSync(file, content + '\n')
  assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: null, previewRevision: planned.previewRevision }), /预览后/)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content/new_item.json')), false)
})
test('Externally edited generated Java becomes read-only and stale browser drafts cannot overwrite it', () => {
  const f = fixture(), first = f.save(f.value), file = first.files.find(file => file.endsWith('/ModItems.java'))!, target = path.join(f.project, file)
  const external = readFileSync(target, 'utf8') + '\n// Agent change\n'; writeFileSync(target, external)
  const read = f.call({ action: 'read', id: first.id }).document as ContentDocument; assert.equal(read.editable, false); assert.match(read.reason!, /外部修改/)
  assert.throws(() => f.preview(f.value, first.revision), /改变/)
  assert.throws(() => f.preview(f.value, read.revision), /外部修改/)
  assert.equal(readFileSync(target, 'utf8'), external)
})
test('Unsupported handwritten resources, invalid parameters and linked directories are preserved', () => {
  const f = fixture(), model = path.join(f.project, 'src/main/resources/assets/content_test/models/item/new_item.json'); mkdirSync(path.dirname(model), { recursive: true }); writeFileSync(model, '{"custom":"keep"}')
  assert.equal((f.call({ action: 'list' }).documents as ContentDocument[])[0].editable, false)
  assert.throws(() => f.preview(f.value), /不能覆盖/); assert.equal(readFileSync(model, 'utf8'), '{"custom":"keep"}')
  for (const parameters of [{ maxStackSize: 65, durability: 0 }, { maxStackSize: 2, durability: 300 }, { maxStackSize: 1, durability: 1.5 }]) assert.equal(contentObjectSchema.safeParse({ ...f.value, parameters }).success, false)
  const block = newContentObject('block', 'content_test'); block.parameters.hardness = -0.5
  assert.equal(contentObjectSchema.safeParse(block).success, false)
  assert.throws(() => f.preview({ ...f.value, id: 'content_test:../escape' }))
  const outside = path.join(f.root, 'outside'); mkdirSync(outside); rmSync(path.join(f.project, '.modcrafting'), { recursive: true, force: true }); symlinkSync(outside, path.join(f.project, '.modcrafting'), 'junction')
  assert.throws(() => f.call({ action: 'list' }), /链接|junction/)
})
test('A late hard-link conflict rolls back only newly written owned files and preserves user files', () => {
  const f = fixture(), metadata = path.join(f.project, 'src/main/resources/fabric.mod.json'), original = readFileSync(metadata, 'utf8')
  linkSync(metadata, path.join(f.root, 'linked-metadata.json'))
  assert.throws(() => f.save(f.value), /硬链接/)
  assert.equal(readFileSync(metadata, 'utf8'), original)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content/new_item.json')), false)
  assert.equal(existsSync(path.join(f.project, 'src/main/java/modcrafting/generated/content_test/o_new_item/content/ModItems.java')), false)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content.lock')), false)
})
test('Texture resources must exist and supported PNG bytes are returned as an authenticated-view payload', () => {
  const f = fixture(), value = { ...f.value, texture: 'content_test:item/custom' }
  assert.throws(() => f.preview(value), /PNG/)
  const file = path.join(f.project, 'src/main/resources/assets/content_test/textures/item/custom.png'); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'))
  const saved = f.save(value); assert.ok(saved.image?.startsWith('data:image/png;base64,')); assert.equal(saved.editable, true)
})
test('Vanilla appearance uses an optional local cache without copying textures into the mod', () => {
  const f = fixture(), file = path.join(f.paths.assetsRoot, 'minecraft-textures/1.21.4/assets/minecraft/textures/item/iron_ingot.png')
  mkdirSync(path.dirname(file), { recursive: true }); const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'); writeFileSync(file, png)
  assert.equal(f.preview(f.value).image, 'data:image/png;base64,' + png.toString('base64'))
  const saved = f.save(f.value); assert.ok(saved.image)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/assets/minecraft')), false)
})
