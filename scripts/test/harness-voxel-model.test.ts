import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, linkSync } from 'node:fs'
import path from 'node:path'
import { createRuntimePaths, ensureRuntimePaths, contentWorkspace, contentObjectSchema, newContentObject, voxelDslSchema, validateVoxel, evaluateVoxel, voxelAsciiViews, encodeRle, meshVoxel, buildAtlas, resolvePalette, voxelWorkspace, type ContentRequest, type ContentDocument, type ContentObject, type VoxelDsl } from '../../packages/modcrafting-core/src/index.ts'
import { encodePng } from '../../packages/modcrafting-core/src/voxel-png.ts'
import type { RuntimePaths } from '../../packages/modcrafting-core/src/contracts.ts'

const solidBox = (): VoxelDsl => ({
  version: 1,
  size: [4, 4, 4],
  palette: { a: '#994422', b: { color: '#ffcc55', pattern: 'noise' } },
  ops: [{ op: 'box', p: 'a', from: [0, 0, 0], to: [3, 3, 3] }],
  texture: { mode: 'shaded', resolution: 16 }
})

function fixture() {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/voxel-unit-')), project = path.join(root, 'project')
  const paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths); mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'content_test', version: '1', depends: { minecraft: '1.21.4' }, entrypoints: { main: ['custom.Existing'] } }))
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture'); writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({ itemsById: { 'minecraft:iron_ingot': { id: 'minecraft:iron_ingot', name: 'iron_ingot' } }, blocksById: { 'minecraft:stone': { id: 'minecraft:stone', hardness: 1.5 } } }))
  const call = (args: Record<string, unknown>) => contentWorkspace(paths, { projectPath: project, ...args } as ContentRequest)
  const voxelCall = (args: Record<string, unknown>) => voxelWorkspace(paths, { projectPath: project, ...args } as Record<string, unknown>)
  return { root, project, paths: paths as RuntimePaths, call, voxelCall }
}

const voxelValue = (kind: 'block' | 'item', id: string): ContentObject => {
  const value = newContentObject(kind, 'content_test')
  value.id = `content_test:${id}`
  value.displayName = id === 'new_block' ? '新方块' : '新物品'
  value.voxel = solidBox()
  return value
}

test('Voxel DSL validation reports structured errors for bounds, RLE sums, palette and empty models', () => {
  assert.equal(voxelDslSchema.safeParse({ ...solidBox(), size: [33, 4, 4] }).success, false)
  assert.equal(voxelDslSchema.safeParse({ ...solidBox(), palette: {} }).success, false)
  assert.equal(validateVoxel({ ...solidBox(), layers: ['aaaa'] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), layers: ['aaaa', 'aaaa', 'aaaa'] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), layers: ['16a'] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), layers: ['aaaa', 'aaaa', 'aaaa', '15a'] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), layers: ['16a', '16a', '16a', '15a'] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), ops: [{ op: 'box', p: 'a', from: [0, 0, 0], to: [4, 3, 3] }] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), ops: [{ op: 'box', p: 'z', from: [0, 0, 0], to: [3, 3, 3] }] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), ops: [] }).ok, false)
  assert.equal(validateVoxel({ ...solidBox(), version: 2 }).ok, false)
  const rejected = validateVoxel({ ...solidBox(), layers: ['16a', '16a', '16a', '15a'] }) as { ok: false; errors: Array<{ path: string; message: string }> }
  assert.equal(rejected.errors[0].path, 'layers.3')
  assert.equal(contentObjectSchema.safeParse({ ...voxelValue('block', 'vx_block'), kind: 'food' }).success, false)
  const uppercase = { ...solidBox(), palette: { ...solidBox().palette, A: '#112233' } }
  assert.equal(voxelDslSchema.safeParse(uppercase).success, false)
})

test('Layer RLE evaluation keeps x-major order and applies layers before mirrored box ops', () => {
  const dsl: VoxelDsl = {
    version: 1, size: [4, 2, 4],
    palette: { a: '#111111', b: '#222222' },
    layers: ['4a4.4a4.', '-'],
    ops: [{ op: 'box', p: 'b', from: [0, 1, 0], to: [1, 1, 1], mirror: 'xz' }],
    texture: { mode: 'material', resolution: 16 }
  }
  const { grid, symbols } = evaluateVoxel(dsl)
  assert.deepEqual(symbols, ['a', 'b'])
  const at = (x: number, y: number, z: number) => grid[(y * 4 + z) * 4 + x]
  assert.equal(at(0, 0, 0), 1); assert.equal(at(3, 0, 0), 1); assert.equal(at(1, 0, 1), 0); assert.equal(at(2, 0, 2), 1)
  assert.equal(at(0, 1, 0), 2); assert.equal(at(3, 1, 3), 2); assert.equal(at(0, 1, 3), 2)
  assert.equal(encodeRle(['a', 'a', '.', 'b', 'b', 'a']), '2a.2ba')
  const views = voxelAsciiViews(grid, [4, 2, 4], symbols)
  assert.equal(views.top.length, 4); assert.equal(views.front.length, 2)
})

test('Face culling and greedy merging reduce a solid cube to six merged rects', () => {
  const { grid } = evaluateVoxel({ ...solidBox() })
  const merged = meshVoxel(grid, [4, 4, 4], true)
  assert.equal(merged.exposedFaces, 96)
  assert.equal(merged.rects.length, 6)
  const unmerged = meshVoxel(grid, [4, 4, 4], false)
  assert.equal(unmerged.rects.length, 96)
})

test('Atlas generation is deterministic, power-of-two sized, and encodes stable PNG bytes', () => {
  const entries = resolvePalette(solidBox().palette)
  const first = buildAtlas(entries, 'shaded')
  const second = buildAtlas(entries, 'shaded')
  assert.equal(first.width, first.height)
  assert.ok(first.width >= 32 && (first.width & (first.width - 1)) === 0)
  assert.equal(first.tiles.length, 6)
  assert.deepEqual(first.pixels, second.pixels)
  const pngA = encodePng(first.width, first.height, first.pixels)
  const pngB = encodePng(first.width, first.height, first.pixels)
  assert.deepEqual(pngA, pngB)
  assert.deepEqual([...pngA.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const material = buildAtlas(entries, 'material')
  assert.equal(material.tiles.length, 2)
})

test('Voxel workspace template and validate round-trip without touching the project', () => {
  const f = fixture()
  const template = f.voxelCall({ action: 'template', kind: 'block' }) as { value: ContentObject; schema: Record<string, unknown>; example: VoxelDsl; hint: string }
  assert.equal(voxelDslSchema.safeParse(template.value.voxel).success, true)
  assert.equal(template.value.texture, 'content_test:block/new_block_atlas')
  assert.ok(template.schema && template.hint.length > 0)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content')), false)
  const checked = voxelWorkspace(f.paths, { action: 'validate', kind: 'block', voxel: template.example }) as { ok: boolean; stats: { cuboids: number; solid: number }; previews: { top: string[] } }
  assert.equal(checked.ok, true)
  assert.ok(checked.stats.cuboids > 0 && checked.stats.solid > 0)
  assert.equal(checked.previews.top.length, 16)
  const invalid = voxelWorkspace(f.paths, { action: 'validate', kind: 'block', voxel: { ...template.example, layers: ['nope'] } }) as { ok: boolean; code?: string; errors?: unknown[] }
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'VOXEL_DSL_INVALID'); assert.ok(Array.isArray(invalid.errors))
})

test('Voxel block and item save writes model JSON plus atlas PNG and reads back editable', () => {
  const f = fixture()
  for (const [kind, id] of [['block', 'vx_block'], ['item', 'vx_item']] as const) {
    const value = voxelValue(kind, id)
    value.texture = 'minecraft:block/stone'
    const planned = f.voxelCall({ action: 'preview', value, expectedRevision: null }) as { files: Array<{ path: string; binary?: boolean; size?: number }>; image?: string }
    if (kind === 'block') assert.equal(existsSync(path.join(f.project, '.modcrafting/content')), false)
    const atlas = planned.files.find(file => file.path.endsWith('_atlas.png'))!
    assert.equal(atlas.binary, true); assert.ok((atlas.size ?? 0) > 100)
    assert.ok(planned.image?.startsWith('data:image/png;base64,'))
    const saved = f.voxelCall({ action: 'save', value, expectedRevision: null, previewRevision: planned.previewRevision }) as { document: ContentDocument }
    assert.equal(saved.document.editable, true, saved.document.reason)
    assert.equal(saved.document.value!.texture, `content_test:${kind}/${id}_atlas`)
    const modelPath = path.join(f.project, `src/main/resources/assets/content_test/models/${kind}/${id}.json`)
    const model = JSON.parse(readFileSync(modelPath, 'utf8'))
    assert.ok(model.elements.length >= 1)
    assert.equal(model.elements[0].faces[Object.keys(model.elements[0].faces)[0]].texture, '#0')
    if (kind === 'block') {
      assert.equal(model.parent, 'block/block')
      assert.ok(model.textures.particle.endsWith('_particle'))
      assert.ok(existsSync(path.join(f.project, `src/main/resources/assets/content_test/textures/block/${id}_particle.png`)))
      assert.ok(JSON.parse(readFileSync(path.join(f.project, `src/main/resources/assets/content_test/blockstates/${id}.json`), 'utf8')).variants)
    } else {
      assert.ok(model.display?.gui)
      assert.ok(JSON.parse(readFileSync(path.join(f.project, `src/main/resources/assets/content_test/items/${id}.json`), 'utf8')).model)
    }
    assert.ok(existsSync(path.join(f.project, `src/main/resources/assets/content_test/textures/${kind}/${id}_atlas.png`)))
    const read = f.call({ action: 'read', id: `content_test:${id}` }).document as ContentDocument
    assert.equal(read.editable, true); assert.ok(read.image?.startsWith('data:image/png;base64,'))
  }
  const documents = f.voxelCall({ action: 'list' }) as { documents: ContentDocument[] }
  assert.deepEqual(documents.documents.map(doc => doc.id).sort(), ['content_test:vx_block', 'content_test:vx_item'])
})

test('External atlas edits make the voxel object read-only without touching other files', () => {
  const f = fixture(), value = voxelValue('block', 'vx_block')
  const saved = f.voxelCall({ action: 'save', value, expectedRevision: null, previewRevision: (f.voxelCall({ action: 'preview', value, expectedRevision: null }) as { previewRevision: string }).previewRevision }) as { document: ContentDocument }
  const atlas = path.join(f.project, 'src/main/resources/assets/content_test/textures/block/vx_block_atlas.png')
  writeFileSync(atlas, Buffer.concat([readFileSync(atlas), Buffer.from([0])]))
  const read = f.call({ action: 'read', id: 'content_test:vx_block' }).document as ContentDocument
  assert.equal(read.editable, false); assert.match(read.reason!, /外部修改/)
  assert.throws(() => f.voxelCall({ action: 'preview', value, expectedRevision: read.revision }), /外部修改/)
  assert.equal(saved.document.id, 'content_test:vx_block')
})

test('A late hard-link failure rolls back freshly written binary atlas bytes', () => {
  const f = fixture(), value = voxelValue('block', 'vx_block')
  const metadata = path.join(f.project, 'src/main/resources/fabric.mod.json')
  linkSync(metadata, path.join(f.root, 'linked-fabric.json'))
  const planned = f.voxelCall({ action: 'preview', value, expectedRevision: null }) as { previewRevision: string }
  assert.throws(() => f.voxelCall({ action: 'save', value, expectedRevision: null, previewRevision: planned.previewRevision }), /硬链接/)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/assets/content_test/textures/block/vx_block_atlas.png')), false)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content/vx_block.json')), false)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/content.lock')), false)
})
