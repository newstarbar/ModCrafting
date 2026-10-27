import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync, linkSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { createRuntimePaths, ensureRuntimePaths, contentWorkspace, newContentObject, contentObjectSchema, contentKinds, customTextureSize, defaultEntityBox, layoutEntityBoxes, type ContentRequest, type ContentDocument, type ContentObject, type ContentFile } from '../../packages/modcrafting-core/src/index.ts'
import { generateContent } from '../../packages/modcrafting-core/src/content-codegen.ts'

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
test('Texture resources must exist and supported PNG bytes are returned as an authenticated-view payload', async () => {
  const f = fixture(), value = { ...f.value, texture: 'content_test:item/custom' }
  assert.throws(() => f.preview(value), /PNG/)
  const file = path.join(f.project, 'src/main/resources/assets/content_test/textures/item/custom.png'); mkdirSync(path.dirname(file), { recursive: true })
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } } }).png().toBuffer()
  writeFileSync(file, png)
  const saved = f.save(value); assert.ok(saved.image?.startsWith('data:image/png;base64,')); assert.equal(saved.editable, true)
})
test('Painted item/food/block textures save PNG bytes and update the generated model reference', async () => {
  const f = fixture(), png = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 30, g: 180, b: 90, alpha: 1 } } }).png().toBuffer(), texturePng = 'data:image/png;base64,' + png.toString('base64')
  for (const [kind, category] of [['item', 'item'], ['food', 'item'], ['block', 'block'], ['tool', 'item'], ['armor', 'item']] as const) {
    const value = { ...newContentObject(kind, 'content_test'), id: `content_test:painted_${kind}`, texture: `content_test:${category}/painted_${kind}` }
    const preview = f.call({ action: 'preview', value, expectedRevision: null, texturePng }) as Record<string, any>
    const saved = f.call({ action: 'save', value, expectedRevision: null, previewRevision: preview.previewRevision, texturePng }).document as ContentDocument
    assert.equal(saved.editable, true, saved.reason)
    const file = path.join(f.project, `src/main/resources/assets/content_test/textures/${category}/painted_${kind}.png`)
    assert.deepEqual(readFileSync(file), png)
    assert.ok(saved.image?.startsWith('data:image/png;base64,'))
  }
  const model = readFileSync(path.join(f.project, 'src/main/resources/assets/content_test/models/item/painted_item.json'), 'utf8')
  assert.match(model, /content_test:item\/painted_item/)
  const block = readFileSync(path.join(f.project, 'src/main/resources/assets/content_test/models/block/painted_block.json'), 'utf8')
  assert.match(block, /content_test:block\/painted_block/)
})

test('Vanilla appearance uses an optional local cache without copying textures into the mod', () => {
  const f = fixture(), file = path.join(f.paths.assetsRoot, 'minecraft-textures/1.21.4/assets/minecraft/textures/item/iron_ingot.png')
  mkdirSync(path.dirname(file), { recursive: true }); const png = Buffer.from('89504e470d0a1a0a00000000', 'hex'); writeFileSync(file, png)
  assert.equal(f.preview(f.value).image, 'data:image/png;base64,' + png.toString('base64'))
  const saved = f.save(f.value); assert.ok(saved.image)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/assets/minecraft')), false)
})
test('Custom creature appearance saves a PNG atomically and generates model/renderer files', async () => {
  const f = fixture(), boxes = [defaultEntityBox(0), { ...defaultEntityBox(1), id: 'head', name: '头', origin: [-4, 16, -4] as [number, number, number], pivot: [0, 20, 0] as [number, number, number] }]
  const layout = layoutEntityBoxes(boxes, customTextureSize())
  const value: ContentObject = { ...newContentObject('entity', 'content_test'), id: 'content_test:custom_creature', texture: 'content_test:entity/custom_creature', appearance: { version: 1, mode: 'custom', textureSize: layout.textureSize, boxes } }
  const png = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 1 } } }).png().toBuffer()
  const texturePng = 'data:image/png;base64,' + png.toString('base64')
  const preview = f.call({ action: 'preview', value, expectedRevision: null, texturePng }) as Record<string, any>
  assert.equal(preview.ok, true)
  assert.equal(preview.texture.path, 'src/main/resources/assets/content_test/textures/entity/custom_creature.png')
  assert.equal(preview.texture.width, 256)
  const saved = f.call({ action: 'save', value, expectedRevision: null, previewRevision: preview.previewRevision, texturePng }).document as ContentDocument
  assert.equal(saved.editable, true, saved.reason)
  assert.ok(saved.files.some(file => file.endsWith('ContentEntityModel.java')))
  assert.ok(saved.files.some(file => file.endsWith('ContentEntityRenderer.java')))
  assert.deepEqual(readFileSync(path.join(f.project, preview.texture.path)), png)
  assert.match(readFileSync(path.join(f.project, saved.files.find(file => file.endsWith('ContentEntityModel.java'))!), 'utf8'), /TexturedModelData|EntityModel/)
  const read = f.call({ action: 'read', id: value.id }).document as ContentDocument
  assert.equal(read.editable, true)
  assert.ok(read.image?.startsWith('data:image/png;base64,'))
  writeFileSync(path.join(f.project, preview.texture.path), Buffer.concat([png, Buffer.from([0])]))
  const stale = f.call({ action: 'read', id: value.id }).document as ContentDocument
  assert.equal(stale.editable, false)
  assert.match(stale.reason!, /纹理|外部修改/)
  assert.throws(() => f.preview(value, saved.revision), /改变|纹理/)
})

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function snapshotFiles(root: string) {
  return readdirSync(root, { recursive: true }).map(file => path.join(root, String(file))).sort()
    .filter(file => statSync(file).isFile()).map(file => [file, readFileSync(file), statSync(file, { bigint: true }).mtimeNs])
}
async function legacyCreatureFixture(splitClient = false) {
  const f = fixture()
  if (splitClient) writeFileSync(path.join(f.project, 'build.gradle'), 'loom { splitEnvironmentSourceSets() }\n')
  const value: ContentObject = { ...newContentObject('entity', 'content_test'), id: 'content_test:legacy_creature', texture: 'content_test:entity/legacy_creature', appearance: { version: 1, mode: 'custom', textureSize: customTextureSize(), boxes: [defaultEntityBox(0)] } }
  const [width, height] = customTextureSize()
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 1 } } }).png().toBuffer()
  const texturePng = png.toString('base64'), planned = f.call({ action: 'preview', value, expectedRevision: null, texturePng })
  const saved = f.call({ action: 'save', value, expectedRevision: null, previewRevision: planned.previewRevision, texturePng }).document as ContentDocument
  assert.equal(saved.editable, true, saved.reason)
  const generated = generateContent(saved.value!, splitClient), model = generated.files.find(file => file.path.endsWith('/ContentEntityModel.java'))!
  const manifestFile = path.join(f.project, '.modcrafting/content/legacy_creature.json'), stored = JSON.parse(readFileSync(manifestFile, 'utf8'))
  // Simulate earlier generator bytes with their saved hash, rather than an untracked source edit.
  const legacySource = model.content + '\n// Previous creature generator output.\n'
  writeFileSync(path.join(f.project, model.path), legacySource)
  stored.files[model.path] = sha256(legacySource)
  writeFileSync(manifestFile, JSON.stringify(stored, null, 2) + '\n')
  return { ...f, value, saved, generated, model, legacySource, manifestFile, stored, png, textureFile: path.join(f.project, stored.texture.path) }
}

test('Saved legacy creature output stays editable without writes and upgrades only through preview/save', async t => {
  for (const splitClient of [false, true]) await t.test(splitClient ? 'split client sources' : 'combined sources', async () => {
    const f = await legacyCreatureFixture(splitClient), before = snapshotFiles(f.root)
    const read = f.call({ action: 'read', id: f.value.id }).document as ContentDocument
    assert.equal(read.editable, true, read.reason)
    assert.deepEqual(read.value, f.saved.value)
    assert.notEqual(read.revision, f.saved.revision)
    assert.deepEqual(f.call({ action: 'read', id: f.value.id }).document, read)
    assert.equal((f.call({ action: 'list' }).documents as ContentDocument[])[0].editable, true)
    assert.deepEqual(snapshotFiles(f.root), before)

    const planned = f.preview(f.value, read.revision), files = planned.files as ContentFile[]
    assert.deepEqual(files.find(file => file.path === f.model.path), { path: f.model.path, before: f.legacySource, after: f.model.content })
    const manifestChange = files.find(file => file.path === '.modcrafting/content/legacy_creature.json')!
    assert.equal(JSON.parse(manifestChange.before!).files[f.model.path], sha256(f.legacySource))
    assert.equal(JSON.parse(manifestChange.after).files[f.model.path], sha256(f.model.content))
    assert.deepEqual(snapshotFiles(f.root), before)
    assert.throws(() => f.preview(f.value, f.saved.revision), { code: 'CONTENT_CONFLICT' })
    assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: f.saved.revision, previewRevision: planned.previewRevision }), { code: 'CONTENT_CONFLICT' })
    assert.throws(() => f.call({ action: 'save', value: { ...f.value, displayName: 'Changed after preview' }, expectedRevision: read.revision, previewRevision: planned.previewRevision }), { code: 'CONTENT_CONFLICT' })
    assert.deepEqual(snapshotFiles(f.root), before)

    const result = f.call({ action: 'save', value: f.value, expectedRevision: read.revision, previewRevision: planned.previewRevision }), upgraded = result.document as ContentDocument
    assert.equal(upgraded.editable, true, upgraded.reason)
    assert.notEqual(upgraded.revision, read.revision)
    for (const file of files) assert.equal(readFileSync(path.join(f.project, file.path), 'utf8'), file.after)
    for (const file of f.generated.files) assert.equal(readFileSync(path.join(f.project, file.path), 'utf8'), file.content)
    const stored = JSON.parse(readFileSync(f.manifestFile, 'utf8'))
    assert.deepEqual(stored.files, Object.fromEntries(f.generated.files.map(file => [file.path, sha256(file.content)])))
    assert.deepEqual(stored.texture, f.stored.texture)
    assert.deepEqual(readFileSync(f.textureFile), f.png)
    const backup = JSON.parse(readFileSync(result.backup as string, 'utf8'))
    assert.equal(backup.objectId, f.value.id)
    assert.deepEqual(backup.files, files)
    assert.equal(existsSync(path.join(f.project, '.modcrafting/content.lock')), false)
    const after = snapshotFiles(f.root)
    assert.throws(() => f.preview(f.value, read.revision), { code: 'CONTENT_CONFLICT' })
    assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: read.revision, previewRevision: planned.previewRevision }), { code: 'CONTENT_CONFLICT' })
    assert.deepEqual(f.call({ action: 'read', id: f.value.id }).document, upgraded)
    assert.ok((f.preview(f.value, upgraded.revision).files as ContentFile[]).every(file => file.before === file.after))
    assert.deepEqual(snapshotFiles(f.root), after)
  })
})

test('Generator upgrades retain manifest, owned path, texture, entrypoint and name protections', async t => {
  const cases: { name: string; change: (f: Awaited<ReturnType<typeof legacyCreatureFixture>>) => void; reason: RegExp }[] = [
    { name: 'external Java edit', change: f => { writeFileSync(path.join(f.project, f.model.path), f.legacySource + '// User edit\n') }, reason: /生成文件已被外部修改/ },
    { name: 'missing owned file', change: f => { unlinkSync(path.join(f.project, f.model.path)) }, reason: /生成文件已被外部修改/ },
    { name: 'stored hash mismatch', change: f => { f.stored.files[f.model.path] = sha256(f.model.content) }, reason: /生成文件已被外部修改/ },
    { name: 'missing manifest file entry', change: f => { delete f.stored.files[f.model.path] }, reason: /生成文件清单不匹配/ },
    { name: 'extra manifest file entry', change: f => { f.stored.files['src/main/java/Unowned.java'] = sha256('unowned') }, reason: /生成文件清单不匹配/ },
    { name: 'relocated manifest file entry', change: f => { f.stored.files['../outside.java'] = f.stored.files[f.model.path]; delete f.stored.files[f.model.path] }, reason: /生成文件清单不匹配/ },
    { name: 'source set path change', change: f => { writeFileSync(path.join(f.project, 'build.gradle'), 'loom { splitEnvironmentSourceSets() }\n') }, reason: /生成文件清单不匹配/ },
    { name: 'unsupported manifest version', change: f => { f.stored.version = 2 }, reason: /不支持的声明版本/ },
    { name: 'manifest ID mismatch', change: f => { f.stored.value.id = 'content_test:other_creature' }, reason: /内容 ID 与声明文件名不一致/ },
    { name: 'external texture edit', change: f => { writeFileSync(f.textureFile, Buffer.concat([f.png, Buffer.from([0])])) }, reason: /绘制纹理已被外部修改/ },
    { name: 'missing texture', change: f => { unlinkSync(f.textureFile) }, reason: /绘制纹理已被外部修改/ },
    { name: 'texture path mismatch', change: f => { f.stored.texture.path = '../outside.png' }, reason: /绘制纹理已被外部修改/ },
    { name: 'texture hash mismatch', change: f => { f.stored.texture.sha256 = sha256('other texture') }, reason: /绘制纹理已被外部修改/ },
    { name: 'invalid texture manifest', change: f => { f.stored.texture.sha256 = 123 }, reason: /纹理清单格式无效/ },
    ...(['main', 'client'] as const).map(type => ({ name: `missing ${type} entrypoint`, change: (f: Awaited<ReturnType<typeof legacyCreatureFixture>>) => {
      const file = path.join(f.project, 'src/main/resources/fabric.mod.json'), metadata = JSON.parse(readFileSync(file, 'utf8'))
      metadata.entrypoints[type] = metadata.entrypoints[type].filter((entry: unknown) => entry !== f.generated[type])
      writeFileSync(file, JSON.stringify(metadata))
    }, reason: /Fabric 入口已被外部修改/ })),
    ...['zh_cn', 'en_us'].map(locale => ({ name: `external ${locale} name edit`, change: (f: Awaited<ReturnType<typeof legacyCreatureFixture>>) => {
      const file = path.join(f.project, `src/main/resources/assets/content_test/lang/${locale}.json`), lang = JSON.parse(readFileSync(file, 'utf8'))
      lang[f.generated.langKey] = 'External name'; writeFileSync(file, JSON.stringify(lang))
    }, reason: /对象名称已被外部修改/ }))
  ]
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = await legacyCreatureFixture(), original = f.call({ action: 'read', id: f.value.id }).document as ContentDocument
    assert.equal(original.editable, true, original.reason)
    const planned = f.preview(f.value, original.revision)
    scenario.change(f)
    writeFileSync(f.manifestFile, JSON.stringify(f.stored, null, 2) + '\n')
    const before = snapshotFiles(f.root), read = f.call({ action: 'read', id: f.value.id }).document as ContentDocument
    assert.equal(read.editable, false)
    assert.match(read.reason!, scenario.reason)
    assert.notEqual(read.revision, original.revision)
    assert.throws(() => f.preview(f.value, original.revision), { code: 'CONTENT_CONFLICT' })
    assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: original.revision, previewRevision: planned.previewRevision }), { code: 'CONTENT_CONFLICT' })
    assert.throws(() => f.preview(f.value, read.revision), { code: 'CONTENT_READ_ONLY' })
    assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: read.revision, previewRevision: planned.previewRevision }), { code: 'CONTENT_READ_ONLY' })
    assert.deepEqual(snapshotFiles(f.root), before)
  })
})
