import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  contentWorkspace, createRuntimePaths, encodePng, ensureRuntimePaths, newContentObject, textureWorkspace,
  type ContentObject, type TextureRequest
} from '../../packages/modcrafting-core/src/index.ts'
import type { RGBAImage } from '../../packages/modcrafting-core/src/texture-core.ts'

function sourceImage(): RGBAImage {
  const width = 128, height = 128, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4
    const diamond = Math.abs(x - 64) + Math.abs(y - 64) < 42
    const highlight = Math.abs(x - 58) + Math.abs(y - 58) < 12
    const color = diamond ? (highlight ? [230, 245, 255, 255] : [150, 90, 190, 255]) : [255, 0, 255, 255]
    data[index] = color[0]; data[index + 1] = color[1]; data[index + 2] = color[2]; data[index + 3] = color[3]
  }
  return { width, height, data }
}

function fixture() {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/texture-unit-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths)
  mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'texture_test', version: '1', depends: { minecraft: '1.21.4' }, entrypoints: { main: [] } }))
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture'); writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({
    itemsById: Object.fromEntries(['iron_ingot', 'apple', 'iron_pickaxe', 'iron_chestplate', 'diamond_sword', 'diamond_pickaxe', 'diamond_chestplate'].map(id => ['minecraft:' + id, { id: 'minecraft:' + id, name: id }])),
    blocksById: { 'minecraft:stone': { id: 'minecraft:stone', hardness: 1.5 } },
    entitiesById: { 'minecraft:pig': { id: 'minecraft:pig' }, 'minecraft:zombie': { id: 'minecraft:zombie' } }
  }))
  const source = path.join(root, 'source.png'); writeFileSync(source, Buffer.from(encodePng(sourceImage())))
  const call = (args: Record<string, unknown>) => textureWorkspace(paths, { projectPath: project, ...args } as TextureRequest)
  const saveContent = (value: ContentObject) => {
    const preview = contentWorkspace(paths, { action: 'preview', projectPath: project, value, expectedRevision: null }) as { previewRevision?: string }
    return contentWorkspace(paths, { action: 'save', projectPath: project, value, expectedRevision: null, previewRevision: preview.previewRevision! }) as { document: { revision: string; value: ContentObject; editable: boolean } }
  }
  return { root, project, paths, source, call, saveContent }
}

const options = { size: 16, background: 'auto', backgroundTolerance: 40, trim: true, padding: 1, pixelize: true, outlineExpansion: true, paletteSize: 12, dither: 'none', alphaThreshold: 128, outline: 1, contrast: 0, saturation: 0, mirror: 'none' }

test('Prompt is read-only and returns a target texture path', () => {
  const f = fixture()
  const prompt = f.call({ action: 'prompt', description: '紫水晶长剑', itemId: 'texture_test:amethyst_sword', size: 16 }) as { target: { textureId: string; filePath: string }; prompt: string }
  assert.equal(prompt.target.textureId, 'texture_test:item/amethyst_sword')
  assert.equal(prompt.target.filePath, 'src/main/resources/assets/texture_test/textures/item/amethyst_sword.png')
  assert.match(prompt.prompt, /16x16/)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/texture.lock')), false)
})

test('Import stores a candidate, save writes PNG with revisions and bind updates the content model', () => {
  const f = fixture(), textureId = 'texture_test:item/test_sword'
  assert.equal((f.call({ action: 'read', textureId }) as { exists: boolean }).exists, false)
  const imported = f.call({ action: 'import', textureId, sourcePath: f.source, options }) as { candidateId: string; image: string; revision: string | null; qualityOk: boolean; failures: unknown[]; pixels: { base64: string } }
  assert.ok(imported.candidateId); assert.ok(imported.image.startsWith('data:image/png;base64,'))
  assert.equal(imported.revision, null); assert.equal(imported.qualityOk, true, JSON.stringify(imported.failures))
  assert.ok(existsSync(path.join(f.paths.dataRoot, 'texture-library')))
  const listed = f.call({ action: 'list', textureId }) as { candidates: unknown[]; textures: unknown[] }
  assert.equal(listed.candidates.length, 1); assert.equal(listed.textures.length, 0)
  const preview = f.call({ action: 'preview', textureId, candidateId: imported.candidateId, options }) as { previewRevision: string; pixels: { base64: string; width: number; height: number } }
  assert.match(preview.previewRevision, /^[a-f0-9]{64}$/)
  const saved = f.call({ action: 'save', textureId, pixelsBase64: preview.pixels.base64, width: 16, height: 16, options, expectedRevision: null, previewRevision: preview.previewRevision }) as { revision: string; qualityOk: boolean }
  assert.match(saved.revision, /^[a-f0-9]{64}$/); assert.equal(saved.qualityOk, true)
  const file = path.join(f.project, 'src/main/resources/assets/texture_test/textures/item/test_sword.png')
  assert.ok(existsSync(file))
  const read = f.call({ action: 'read', textureId }) as { exists: boolean; revision: string }
  assert.equal(read.exists, true); assert.equal(read.revision, saved.revision)
  assert.ok((f.call({ action: 'list', textureId }) as { textures: Array<{ textureId: string }> }).textures.some(value => value.textureId === textureId))
  assert.throws(() => f.call({ action: 'save', textureId, pixelsBase64: preview.pixels.base64, width: 16, height: 16, options, expectedRevision: null, previewRevision: preview.previewRevision }), (error: { code?: string }) => error.code === 'TEXTURE_CONFLICT')
  assert.throws(() => f.call({ action: 'save', textureId, pixelsBase64: preview.pixels.base64, width: 16, height: 16, options, expectedRevision: saved.revision, previewRevision: '0'.repeat(64) }), (error: { code?: string }) => error.code === 'TEXTURE_CONFLICT')

  const value = newContentObject('item', 'texture_test'); value.id = 'texture_test:test_item'; value.displayName = '测试物品'
  const savedContent = f.saveContent(value)
  assert.equal(savedContent.document.editable, true)
  const bound = f.call({ action: 'bind', contentId: value.id, textureId, expectedRevision: savedContent.document.revision }) as { document: { value: ContentObject } }
  assert.equal(bound.document.value.texture, textureId)
  const model = JSON.parse(readFileSync(path.join(f.project, 'src/main/resources/assets/texture_test/models/item/test_item.json'), 'utf8'))
  assert.equal(model.textures.layer0, textureId)
  assert.throws(() => f.call({ action: 'bind', contentId: value.id, textureId, expectedRevision: savedContent.document.revision }), (error: { code?: string }) => error.code === 'CONTENT_CONFLICT')
})

test('Texture workspace rejects traversal, non-PNG sources, missing upload context and empty saves', () => {
  const f = fixture(), textureId = 'texture_test:item/test_sword'
  assert.throws(() => f.call({ action: 'import', textureId: 'texture_test:item/../escape', sourcePath: f.source, options }), (error: { code?: string }) => error.code === 'TEXTURE_ID_INVALID')
  assert.throws(() => f.call({ action: 'import', textureId: 'other:item/test', sourcePath: f.source, options }), (error: { code?: string }) => error.code === 'TEXTURE_ID_INVALID')
  const text = path.join(f.root, 'not-a-png.png'); writeFileSync(text, 'not a png')
  assert.throws(() => f.call({ action: 'import', textureId, sourcePath: text, options }), (error: { code?: string }) => error.code === 'TEXTURE_SOURCE_INVALID')
  assert.throws(() => f.call({ action: 'import', textureId, sourceToken: '00000000-0000-0000-0000-000000000000.png', options }), (error: { code?: string }) => error.code === 'TEXTURE_SOURCE_INVALID')
  const transparent = Buffer.alloc(16 * 16 * 4).toString('base64')
  assert.throws(() => f.call({ action: 'save', textureId, pixelsBase64: transparent, width: 16, height: 16, expectedRevision: null, previewRevision: '0'.repeat(64) }), (error: { code?: string }) => error.code === 'TEXTURE_QUALITY')
})
