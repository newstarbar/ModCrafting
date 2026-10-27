import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRuntimePaths, ensureRuntimePaths, guiWorkspace, guiLayoutSchema, newGuiLayout, newGuiElement, guiOrigin, moveGuiElement, resizeGuiElement, type GuiRequest, type GuiLayout, type GuiDocument } from '../../packages/modcrafting-core/src/index.ts'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-gui-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths); mkdirSync(path.join(project, 'src/main/resources'), { recursive: true })
  writeFileSync(path.join(project, 'src/main/resources/fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'gui_test', version: '1', entrypoints: { main: ['custom.Main'], client: [{ adapter: 'kotlin', value: 'custom.Client' }] } }))
  writeFileSync(path.join(project, 'gradlew.bat'), '@echo fixture'); writeFileSync(path.join(project, 'gradle.properties'), 'minecraft_version=1.21.4\n')
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true }); writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({ itemsById: { 'minecraft:iron_ingot': { id: 'minecraft:iron_ingot' } } }))
  const call = (value: Record<string, unknown>) => guiWorkspace(paths, { projectPath: project, ...value } as GuiRequest)
  const preview = (value: GuiLayout, expectedRevision: string | null = null) => call({ action: 'preview', value, expectedRevision })
  const save = (value: GuiLayout, expectedRevision: string | null = null) => call({ action: 'save', value, expectedRevision, previewRevision: preview(value, expectedRevision).previewRevision }).document as GuiDocument
  return { root, project, paths, call, preview, save, value: newGuiLayout('gui_test') }
}
test('Three GUI layout types round-trip with native client resources and preserve unrelated entrypoints', () => {
  const f = fixture()
  assert.deepEqual(f.call({ action: 'template', layoutType: 'custom-screen' }).value, f.value)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/gui')), false)
  for (const [index, type] of (['custom-screen', 'option-list', 'hud-overlay'] as const).entries()) {
    const value = { ...newGuiLayout('gui_test', type), id: 'gui_test:layout_' + index, keyCode: 71 + index, elements: [newGuiElement('label', 'heading')] }
    const saved = f.save(value); assert.equal(saved.editable, true, saved.reason); assert.deepEqual(saved.value, value)
    assert.deepEqual((f.call({ action: 'read', id: value.id }).document as GuiDocument).value, value)
  }
  const metadata = JSON.parse(readFileSync(path.join(f.project, 'src/main/resources/fabric.mod.json'), 'utf8'))
  assert.deepEqual(metadata.entrypoints.main, ['custom.Main']); assert.deepEqual(metadata.entrypoints.client[0], { adapter: 'kotlin', value: 'custom.Client' }); assert.equal(metadata.entrypoints.client.length, 4)
  assert.equal((f.call({ action: 'list' }).documents as GuiDocument[]).length, 3)
})
test('GUI preview never writes; shared-file changes and preview changes reject stale saves', () => {
  const f = fixture(), plan = f.preview(f.value)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/gui')), false)
  writeFileSync(path.join(f.project, 'build.gradle'), '// Agent edit\n')
  assert.throws(() => f.call({ action: 'save', value: f.value, expectedRevision: null, previewRevision: plan.previewRevision }), /预览后/)
  assert.equal(existsSync(path.join(f.project, '.modcrafting/gui/new_screen.json')), false)
  const first = f.save(f.value), changed = { ...f.value, title: 'New title' }
  writeFileSync(path.join(f.project, 'gradle.properties'), 'minecraft_version=1.21.4\n# external\n')
  assert.throws(() => f.preview(changed, first.revision), /改变/)
})
test('Modified or unknown Java is never overwritten, and a late hardlink failure rolls back owned files', () => {
  const f = fixture(), first = f.save(f.value), target = path.join(f.project, first.files.find(file => file.endsWith('.java'))!)
  const source = readFileSync(target, 'utf8') + '\n// Agent custom logic\n'; writeFileSync(target, source)
  const read = f.call({ action: 'read', id: first.id }).document as GuiDocument
  assert.equal(read.editable, false); assert.throws(() => f.preview(f.value, read.revision), /外部修改/); assert.equal(readFileSync(target, 'utf8'), source)
  const g = fixture(), metadata = path.join(g.project, 'src/main/resources/fabric.mod.json'), original = readFileSync(metadata, 'utf8')
  linkSync(metadata, path.join(g.root, 'linked.json'))
  assert.throws(() => g.save(g.value), /硬链接/); assert.equal(readFileSync(metadata, 'utf8'), original)
  assert.equal(existsSync(path.join(g.project, '.modcrafting/gui/new_screen.json')), false); assert.equal(existsSync(path.join(g.project, '.modcrafting/gui.lock')), false)
  const outside = path.join(g.root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, path.join(g.project, '.modcrafting/gui'), 'junction')
  assert.throws(() => g.call({ action: 'list' }), /链接/)
})
test('GUI contracts reject duplicate IDs, overflow, broken bindings, invalid widgets and conflicting keys', () => {
  const f = fixture(), label = newGuiElement('label', 'heading')
  const bad = [
    { ...f.value, elements: [label, label] },
    { ...f.value, elements: [{ ...label, x: 319 }] },
    { ...f.value, elements: [{ ...label, bind: 'missing' }] },
    { ...f.value, elements: [{ ...newGuiElement('slider', 'power'), min: 5, max: 1 }] },
    { ...f.value, elements: [{ ...newGuiElement('button', 'boost'), action: 'increment', target: 'missing' }] },
    { ...f.value, layoutType: 'hud-overlay', elements: [newGuiElement('toggle', 'enabled')] },
    { ...f.value, elements: [{ ...newGuiElement('slot', 'display'), itemId: 'minecraft:../outside' }] }
  ]
  for (const value of bad) assert.equal(guiLayoutSchema.safeParse(value).success, false)
  assert.throws(() => f.preview({ ...f.value, elements: [newGuiElement('slot', 'display')].map(element => ({ ...element, itemId: 'gui_test:missing' })) }), /未出现/)
  f.save(f.value); assert.throws(() => f.preview({ ...f.value, id: 'gui_test:other' }), /快捷键/)
  assert.throws(() => f.preview({ ...f.value, id: 'other:outside' }), /命名空间/)
})
test('Legacy grid/edge geometry clamps moves and resizes, honors disabled snapping and viewport anchors', () => {
  const layout = newGuiLayout('gui_test'), element = { ...newGuiElement('label', 'moving'), x: 24, y: 24, width: 64, height: 24 }
  layout.elements = [element, { ...element, id: 'other', x: 80, y: 80 }]
  assert.equal(moveGuiElement(layout, element, 33, 39).element.x, 32)
  assert.equal(moveGuiElement(layout, element, 79, 80).guideX, 80)
  assert.equal(moveGuiElement(layout, element, 79, 77, false).element.x, 79)
  assert.equal(moveGuiElement(layout, element, -100, 999).element.y, 216)
  assert.equal(resizeGuiElement(layout, element, 999, 999).width, 296)
  assert.deepEqual(guiOrigin(layout, 427, 240), { x: 53, y: 0 })
  assert.deepEqual(guiOrigin({ ...layout, anchor: 'bottom-right' }, 480, 270), { x: 160, y: 30 })
})
