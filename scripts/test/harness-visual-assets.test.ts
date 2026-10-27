import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { itemImage, textureImage, prepareVisualAssets } from '../../packages/modcrafting-core/src/visual-assets.ts'
import { createRuntimePaths } from '../../packages/modcrafting-core/src/node.ts'
import { articulatedHumanoidBoxes, entityAppearanceSchema, orderedEntityBoxes, poseEntityBoxes, transformEntityPoint, type EntityBox, type EntityVector } from '../../packages/modcrafting-core/src/entity-appearance.ts'
import { generateContent } from '../../packages/modcrafting-core/src/content-codegen.ts'
import { newContentObject } from '../../packages/modcrafting-core/src/content-model.ts'

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const nearVector = (actual: EntityVector, expected: EntityVector) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-8, `${actual} != ${expected}`))
const rigAppearance = (boxes: EntityBox[]) => ({ version: 1 as const, mode: 'custom' as const, textureSize: [256, 256] as [number, number], boxes })

test('Articulated preset validates and rejects missing, self, cyclic or duplicate parent IDs', () => {
  const boxes = articulatedHumanoidBoxes()
  assert.equal(entityAppearanceSchema.safeParse(rigAppearance(boxes)).success, true)
  for (const parent of ['missing', 'pelvis', 'head']) {
    assert.equal(entityAppearanceSchema.safeParse(rigAppearance(boxes.map((box, index) => index === 0 ? { ...box, parent } : box))).success, false)
  }
  assert.equal(entityAppearanceSchema.safeParse(rigAppearance([...boxes, boxes[0]])).success, false)
  const ordered = orderedEntityBoxes([...boxes].reverse())
  for (const box of ordered) if (box.parent) assert.ok(ordered.findIndex(parent => parent.id === box.parent) < ordered.indexOf(box))
})

test('Nested waist and elbow rotation keep the shared joint position attached', () => {
  const boxes = articulatedHumanoidBoxes().map(box => ({ ...box, rotation: (box.id === 'torso' ? [38, 17, -12] : box.id === 'arm_left_upper' ? [-20, 6, 25] : box.id === 'arm_left_lower' ? [-65, 0, 0] : box.rotation) as EntityVector }))
  for (const box of boxes.filter(box => box.parent)) {
    nearVector(transformEntityPoint(boxes, box.id, box.pivot), transformEntityPoint(boxes, box.parent!, box.pivot))
  }
  const rest = articulatedHumanoidBoxes(), head = rest.find(box => box.id === 'head')!
  assert.notDeepEqual(transformEntityPoint(boxes, head.id, head.origin), transformEntityPoint(rest, head.id, head.origin))
  const calf = rest.find(box => box.id === 'leg_left_lower')!
  nearVector(transformEntityPoint(boxes, calf.id, calf.origin), calf.origin)
})

test('Preview rotations follow Minecraft ZYX matrix order and unposed model coordinates', () => {
  const box: EntityBox = { id: 'root', name: 'root', origin: [0, 0, 0], size: [2, 2, 2], pivot: [0, 0, 0], rotation: [90, 90, 0] }
  nearVector(transformEntityPoint([box], 'root', [0, 1, 0]), [1, 0, 0])
  nearVector(transformEntityPoint(articulatedHumanoidBoxes(), 'head', [2, -39, 1]), [2, -39, 1])
})

test('Pose sampling preserves rest rotations, fades gait and does not leak across frozen frames or living entities', () => {
  const boxes = articulatedHumanoidBoxes().map(box => ({ ...box, rotation: [5, 9, -3] as EntityVector, deathRotation: [30, 15, 20] as EntityVector }))
  const before = JSON.stringify(boxes), corpse = poseEntityBoxes(boxes, 0.3, 1, 0.7)
  for (let frame = 0; frame < 100; frame++) assert.deepEqual(poseEntityBoxes(boxes, 0.3, 1, 0.7), corpse)
  assert.equal(JSON.stringify(boxes), before)
  assert.deepEqual(poseEntityBoxes(boxes, 0, 0, 0).map(box => box.rotation), boxes.map(box => box.rotation))
  assert.deepEqual(poseEntityBoxes(boxes, 0.3, 1, 1).map(box => box.rotation), boxes.map(() => [35, 24, 17]))
  const walk = poseEntityBoxes(articulatedHumanoidBoxes(), 0, 1)
  assert.equal(walk.find(box => box.id === 'leg_left_lower')!.rotation[0], 0)
  assert.ok(walk.find(box => box.id === 'leg_right_lower')!.rotation[0] > 0)
})

test('Java hierarchy uses parent-relative pivots, a single foot offset and reset-before-additive animation', () => {
  const boxes = articulatedHumanoidBoxes().reverse()
  boxes.find(box => box.id === 'torso')!.deathRotation = [30, 10, 5]
  const value = { ...newContentObject('entity', 'rig_test'), texture: 'rig_test:entity/rig', appearance: rigAppearance(boxes) }
  const java = generateContent(value).files.find(file => file.path.endsWith('/ContentEntityModel.java'))!.content
  assert.match(java, /part_pelvis = root\.addChild\("pelvis"[\s\S]*?ModelTransform\.of\(0\.0f, 8\.0f, 0\.0f/)
  assert.match(java, /part_torso = part_pelvis\.addChild\("torso"[\s\S]*?ModelTransform\.of\(0\.0f, -4\.0f, 0\.0f/)
  assert.match(java, /part_leg_left_lower = part_leg_left_upper\.addChild\("leg_left_lower"[\s\S]*?ModelTransform\.of\(0\.0f, 8\.0f, 0\.0f/)
  assert.match(java, /this\.part_arm_left_lower = this\.part_arm_left_upper\.getChild\("arm_left_lower"\)/)
  assert.ok(java.indexOf('super.setAngles(state);') < java.indexOf('part_torso.pitch +='))
  assert.doesNotMatch(java, /\.pitch =|\.yaw =|\.roll =/)
  assert.match(java, /part_torso\.roll \+= \(float\) Math\.toRadians\(5\.0\) \* death/)
  assert.equal(generateContent(value, true).files.some(file => file.path.startsWith('src/client/java/') && file.path.endsWith('/ContentEntityModel.java')), true)
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-visuals-')), paths = createRuntimePaths(path.join(root, 'data')), project = path.join(root, 'project')
  const cache = path.join(paths.assetsRoot, 'minecraft-textures/1.21.4')
  const put = (base: string, name: string, value: unknown) => { const file = path.join(base, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.isBuffer(value) ? value : JSON.stringify(value)); return file }
  return { root, paths, project, cache, put }
}
test('Vanilla block icons follow 1.21.4 item definitions, inherited models and texture variables', () => {
  const f = fixture(), a = 'assets/minecraft/'
  f.put(f.cache, a + 'items/stone.json', { model: { type: 'minecraft:model', model: 'minecraft:block/stone' } })
  f.put(f.cache, a + 'models/block/stone.json', { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } })
  f.put(f.cache, a + 'models/block/cube_all.json', { textures: { particle: '#all' } })
  f.put(f.cache, a + 'textures/block/stone.png', png)
  assert.equal(itemImage(f.paths, f.project, 'minecraft:stone'), 'data:image/png;base64,' + png.toString('base64'))
  assert.equal(itemImage(f.paths, f.project, 'minecraft:unknown'), undefined)
})
test('Project models and textures override vanilla without copying into or rewriting the project', () => {
  const f = fixture(), assets = path.join(f.project, 'src/main/resources'), a = 'assets/example/'
  f.put(assets, a + 'items/tool.json', { model: { type: 'minecraft:model', model: 'example:item/tool' } })
  f.put(assets, a + 'models/item/tool.json', { parent: 'minecraft:item/generated', textures: { layer0: '#custom', custom: 'example:item/blue' } })
  const file = f.put(assets, a + 'textures/item/blue.png', png)
  assert.ok(itemImage(f.paths, f.project, 'example:tool'))
  assert.ok(textureImage(f.paths, f.project, 'example:item/blue'))
  assert.deepEqual(readFileSync(file), png)
  assert.equal(itemImage(f.paths, f.project, '../escape:item/blue'), undefined)
  assert.equal(textureImage(f.paths, f.project, 'example:item/../../secret'), undefined)
  f.put(assets, a + 'models/item/cycle.json', { parent: 'example:item/cycle', textures: { layer0: '#loop', loop: '#loop' } })
  assert.equal(itemImage(f.paths, f.project, 'example:cycle'), undefined)
  const outside = f.put(f.root, 'outside.png', png)
  symlinkSync(path.dirname(outside), path.join(assets, 'assets/linked'), 'junction')
  assert.throws(() => textureImage(f.paths, f.project, 'linked:outside'), /链接/)
})
test('A cold local client cache is version checked and extracts only bounded PNG/JSON resources', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(), gradle = path.join(f.root, 'gradle'), jar = path.join(gradle, 'caches/fabric-loom/1.21.4/minecraft-client.jar')
  mkdirSync(path.dirname(jar), { recursive: true })
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($env:VISUAL_TEST_JAR,'Create')
try { foreach($key in @('version.json','assets/minecraft/textures/item/apple.png','assets/minecraft/items/apple.json','../escape.png','secret.txt')) {
 $entry=$zip.CreateEntry($key); $stream=$entry.Open(); try {
 $data=if($key -eq 'version.json'){[Text.Encoding]::UTF8.GetBytes('{"id":"1.21.4"}')}elseif($key.EndsWith('.png')){[Convert]::FromBase64String('${png.toString('base64')}')}else{[Text.Encoding]::UTF8.GetBytes('{}')};$stream.Write($data,0,$data.Length)
 }finally{$stream.Dispose()}
} }finally{$zip.Dispose()}`
  const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, VISUAL_TEST_JAR: jar }, encoding: 'utf8' })
  assert.equal(created.status, 0, created.stderr)
  const old = process.env.GRADLE_USER_HOME; process.env.GRADLE_USER_HOME = gradle
  try {
    const [one, two] = await Promise.all([prepareVisualAssets(f.paths), prepareVisualAssets(f.paths)])
    assert.equal(one.ready, true, one.message); assert.deepEqual(one, two)
    assert.ok(textureImage(f.paths, f.project, 'minecraft:item/apple'))
    assert.equal(existsSync(path.join(f.cache, 'secret.txt')), false)
    assert.equal(existsSync(path.join(f.cache, '../escape.png')), false)
    assert.equal((await prepareVisualAssets(f.paths)).ready, true)
  } finally { if (old === undefined) delete process.env.GRADLE_USER_HOME; else process.env.GRADLE_USER_HOME = old }
})
