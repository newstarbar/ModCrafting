import assert from 'node:assert/strict'
import test from 'node:test'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  GAME_TEST_WORLD,
  createRuntimePaths,
  SystemToolchainProvider,
  FABRIC_TARGET,
  searchFabricDocs,
  isAllowedBridgeApiPath,
  compactSnapshot,
  portIsListening,
  customTextureSize,
  defaultEntityBox,
  entityAppearanceSchema,
  layoutEntityBoxes,
  scaffoldFabricProject,
  testVerdict,
  validateFabricProject,
  validateGameTestSpec
} from '../../packages/modcrafting-core/src/index.ts'

test('release branch excludes the retired Desktop application and dependency chain', async () => {
  const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'))
  assert.equal(existsSync('src'), false)
  assert.equal(existsSync('electron.vite.config.ts'), false)
  assert.equal(existsSync('scripts/plugin/migrate-desktop.ts'), false)
  assert.equal(packageJson.dependencies?.electron, undefined)
  assert.equal(packageJson.devDependencies?.electron, undefined)
  assert.equal(packageJson.scripts['build:win'], undefined)
})

test('shared core exposes the deterministic Observer and game-test contracts without Electron', () => {
  assert.equal(isAllowedBridgeApiPath('/v2/snapshot'), true)
  assert.equal(isAllowedBridgeApiPath('/v1/input'), true)
  assert.equal(isAllowedBridgeApiPath('/api/delete-everything'), false)
  assert.equal(testVerdict([{ passed: true }]), 'PASS')
  assert.equal(testVerdict([{ passed: false }]), 'FAIL')
  assert.equal(testVerdict([{ passed: true, unavailable: true }]), 'INCONCLUSIVE')
  const parsed = validateGameTestSpec({ version: 2, id: 'test_item', featureType: 'new_item', subject: {}, setup: [], actions: [{ type: 'wait', ms: 0 }], assertions: [{ type: 'inventory_contains', itemId: 'minecraft:stone' }], cleanup: [] })
  assert.equal(parsed.ok, true)
  assert.equal(GAME_TEST_WORLD, 'ModCrafting Test World')
})

test('checked-in first-use example includes loadable metadata and a supported V2 contract', async () => {
  const metadata = JSON.parse(await fs.readFile('examples/iron-ticket/src/main/resources/fabric.mod.json', 'utf8'))
  assert.equal(metadata.id, 'iron_ticket')
  assert.equal(metadata.version, '0.1.0')
  assert.equal(validateGameTestSpec(JSON.parse(await fs.readFile('examples/iron-ticket/test-spec.json', 'utf8'))).ok, true)
})

test('system-toolchain project inspection does not create a wrapper or download toolchain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modcrafting-plugin-'))
  try {
    const project = await scaffoldFabricProject(path.join(root, 'example'), 'example_mod', 'Example Mod')
    assert.equal(project.modId, 'example_mod')
    const validation = validateFabricProject(project.path)
    assert.equal(validation.checks.wrapper, false)
    assert.equal(existsSync(path.join(project.path, 'gradlew.bat')), false)
    const paths = createRuntimePaths(path.join(root, 'plugin-data'))
    assert.equal(paths.knowledgeRoot.endsWith('knowledge'), true)
    await fs.mkdir(path.join(paths.assetsRoot, 'agent-knowledge', 'fabric'), { recursive: true })
    await fs.writeFile(path.join(paths.assetsRoot, 'agent-knowledge', 'fabric', 'fixture.md'), 'fixture Fabric documentation')
    assert.equal(searchFabricDocs(paths, 'fixture').assetReady, true)
    assert.equal((searchFabricDocs(paths, 'fixture').hits as unknown[]).length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('compact snapshots drop recipe/trace bulk and item fingerprints while preserving limits', () => {
  const result = {
    ok: true, status: 200,
    data: {
      ok: true,
      recipes: Array.from({ length: 20 }, (_, index) => `recipe_${index}`),
      hudTrace: [{ text: 'hud' }], renderTrace: [{ text: 'render' }], combatTrace: [{ text: 'combat' }],
      entities: Array.from({ length: 20 }, (_, index) => ({ type: 'minecraft:cow', name: `cow_${index}`, health: 10 })),
      blocks: Array.from({ length: 4 }, (_, index) => ({ x: index, y: 100, z: 0, blockId: 'minecraft:stone' })),
      player: { health: 20, mainHand: { id: 'minecraft:name_tag', componentFingerprint: 'large payload' } },
      inventory: { ok: true, main: [{ id: 'minecraft:stone', componentFingerprint: 'large payload' }] }
    }
  }
  const compact = compactSnapshot(result, { entityLimit: 3 })
  const data = compact.data as Record<string, unknown>
  assert.equal((data.recipes as unknown[]).length, 0)
  assert.equal((data.hudTrace as unknown[]).length, 0)
  assert.equal((data.entities as unknown[]).length, 3)
  assert.equal(data.blocks, undefined)
  assert.equal((data.omitted as Record<string, number>).recipes, 20)
  assert.equal((data.omitted as Record<string, number>).entities, 17)
  assert.equal((data.player as { mainHand: Record<string, unknown> }).mainHand.componentFingerprint, undefined)
  assert.equal((data.inventory as { main: Array<Record<string, unknown>> }).main[0].componentFingerprint, undefined)
})

test('creature appearance boxes pack into a deterministic atlas and reject invalid geometry', () => {
  const boxes = [defaultEntityBox(0), { ...defaultEntityBox(1), id: 'head', name: '头' }]
  const layout = layoutEntityBoxes(boxes, customTextureSize())
  assert.deepEqual(layout.textureSize, [256, 256])
  assert.equal(layout.regions.length, 2)
  for (const region of layout.regions) {
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 256 && region.y + region.height <= 256)
  }
  const appearance = { version: 1, mode: 'custom', textureSize: layout.textureSize, boxes }
  assert.equal(entityAppearanceSchema.safeParse(appearance).success, true)
  assert.equal(entityAppearanceSchema.safeParse({ ...appearance, boxes: [] }).success, false)
  assert.equal(entityAppearanceSchema.safeParse({ ...appearance, boxes: [boxes[0], boxes[0]] }).success, false)
  assert.equal(entityAppearanceSchema.safeParse({ ...appearance, textureSize: [64, 64], boxes: [{ ...boxes[0], size: [64, 64, 64] }] }).success, false)
  assert.throws(() => layoutEntityBoxes([{ ...boxes[0], size: [64, 64, 64] }], [64, 64]))
})

test('Observer test-world lookup is rooted at the vanilla saves directory', async () => {
  const source = await fs.readFile('bridge-mod/src/client/java/com/modcrafting/observer/GamePreparation.java', 'utf8')
  assert.match(source, /LevelStorage\.create\(client\.runDirectory\.toPath\(\)\.resolve\("saves"\)\)/)
})

test('bridge discovery port probe distinguishes a dead port from a live one', async () => {
  const server = createServer((request, response) => { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: false })) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    assert.equal(portIsListening(port), true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  assert.equal(portIsListening(port), false)
})

test('supplied pinned Wrapper makes a new project buildable without executing Java or overwriting user files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modcrafting-scaffold-wrapper-'))
  const projectPath = path.join(directory, 'new project')
  const jar = await fs.readFile('bridge-mod/gradle/wrapper/gradle-wrapper.jar')
  const wrapper = { batch: await fs.readFile('bridge-mod/gradlew.bat', 'utf8'), properties: await fs.readFile('bridge-mod/gradle/wrapper/gradle-wrapper.properties', 'utf8'), jarBase64: jar.toString('base64') }
  const project = await scaffoldFabricProject(projectPath, 'wrapper_fixture', 'Wrapper Fixture', wrapper)
  assert.equal(project.valid, true); assert.equal(validateFabricProject(projectPath).ok, true)
  assert.deepEqual(await fs.readFile(path.join(projectPath, 'gradle/wrapper/gradle-wrapper.jar')), jar)
  assert.match(await fs.readFile(path.join(projectPath, 'gradle/wrapper/gradle-wrapper.properties'), 'utf8'), /distributionSha256Sum=[a-f0-9]{64}/)
  const metadata = JSON.parse(await fs.readFile(path.join(projectPath, 'src/main/resources/fabric.mod.json'), 'utf8'))
  assert.equal(metadata.version, '0.1.0')
  await fs.writeFile(path.join(projectPath, 'user-file'), 'preserve')
  await assert.rejects(scaffoldFabricProject(projectPath, 'wrapper_fixture', 'Again', wrapper), /non-empty/)
  assert.equal(await fs.readFile(path.join(projectPath, 'user-file'), 'utf8'), 'preserve')
})

test('resource validation reports missing 1.21.4 item definitions, model/texture references and legacy recipe directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modcrafting-validation-'))
  try {
    const project = await scaffoldFabricProject(path.join(root, 'project'), 'validation_fixture', 'Validation Fixture')
    const assets = path.join(project.path, 'src/main/resources/assets/validation_fixture')
    await fs.mkdir(path.join(assets, 'models/item'), { recursive: true })
    await fs.writeFile(path.join(assets, 'models/item/blueberry.json'), JSON.stringify({ parent: 'item/missing_parent', textures: { layer0: 'validation_fixture:item/missing_texture' } }))
    const recipes = path.join(project.path, 'src/main/resources/data/validation_fixture/recipes')
    await fs.mkdir(recipes, { recursive: true })
    await fs.writeFile(path.join(recipes, 'legacy.json'), JSON.stringify({ type: 'minecraft:crafting_shaped' }))
    await fs.writeFile(path.join(project.path, 'gradle.properties'), 'minecraft_version=1.21.3\n')
    const result = validateFabricProject(project.path)
    assert.equal(result.ok, false)
    for (const code of ['MINECRAFT_VERSION_MISMATCH', 'MISSING_ITEM_MODEL_DEFINITION', 'MISSING_MODEL', 'MISSING_TEXTURE', 'LEGACY_RECIPE_DIRECTORY']) {
      assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), `missing diagnostic ${code}: ${JSON.stringify(result.diagnostics)}`)
    }
    assert.equal(result.checks.minecraft1214, false)
    assert.equal(result.checks.resourceReferences, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Windows Gradle wrapper launcher runs a fixture batch through cmd without a real JDK/Gradle', { skip: process.platform !== 'win32' ? 'Windows-only batch fixture' : false }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modcrafting-wrapper-'))
  try {
    const project = await scaffoldFabricProject(path.join(root, 'project with spaces'), 'fixture_mod', 'Fixture')
    await fs.writeFile(path.join(project.path, 'gradlew.bat'), '@echo off\r\necho FIXTURE_TASK=%1\r\nexit /b 0\r\n')
    class FixtureProvider extends SystemToolchainProvider {
      async status() { return { ok: true, platform: process.platform, node: process.version, java: { ok: true }, gradleWrapper: true, target: FABRIC_TARGET, remediation: [] } }
    }
    let output = ''
    const child = await new FixtureProvider().startGradle(project.path, 'build', { onLog: (_, text) => { output += text } })
    const code = await new Promise<number>((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture batch timed out')) }, 3000); child.once('error', (error) => { clearTimeout(timer); reject(error) }); child.once('close', (code) => { clearTimeout(timer); resolve(code ?? -1) }) })
    assert.equal(code, 0)
    assert.match(output, /FIXTURE_TASK=build/)
    await assert.rejects(new FixtureProvider().startGradle(project.path, 'build&echo'), /Unsafe/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
