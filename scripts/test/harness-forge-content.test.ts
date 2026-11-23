import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { contentWorkspace, createRuntimePaths, ensureRuntimePaths, newContentObject, type ContentDocument, type ContentRequest } from '../../packages/modcrafting-core/src/index.ts'
import { materializeProject } from '../../packages/modcrafting-core/src/node.ts'
import { resolveTarget } from '../../packages/modcrafting-core/src/version/targets.ts'

async function fixture() {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/forge-content-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths)
  const wrapper = { batch: '@echo off\r\n', properties: 'distributionUrl=gradle-8.10.2-bin.zip\n', jarBase64: Buffer.from('jar').toString('base64') }
  await materializeProject({ projectPath: project, modId: 'forge_test', modName: 'Forge Test', target: resolveTarget('forge', '1.20.1'), wrapper })
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.20.1'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.20.1/index.json'), JSON.stringify({
    itemsById: Object.fromEntries(['iron_ingot', 'apple', 'iron_pickaxe', 'iron_chestplate', 'diamond_pickaxe', 'diamond_chestplate', 'diamond_sword'].map((id) => [`minecraft:${id}`, { id: `minecraft:${id}`, name: id }])),
    blocksById: { 'minecraft:stone': { id: 'minecraft:stone', hardness: 1.5 } },
    entitiesById: { 'minecraft:pig': { id: 'minecraft:pig' } }
  }))
  const call = (args: Record<string, unknown>) => contentWorkspace(paths, { projectPath: project, ...args } as ContentRequest)
  const save = (value: ReturnType<typeof newContentObject>) => {
    const preview = call({ action: 'preview', value, expectedRevision: null })
    return call({ action: 'save', value, expectedRevision: null, previewRevision: preview.previewRevision }).document as ContentDocument
  }
  return { project, call, save }
}

test('a Forge item uses ForgeRegistries + RegistryObject and lands in ContentIndex', async () => {
  const f = await fixture()
  const value = newContentObject('item', 'forge_test')
  value.id = 'forge_test:forge_item'
  value.displayName = 'Forge 物品'
  value.parameters = { ...value.parameters, maxStackSize: 32 }
  assert.equal(f.save(value).editable, true)

  const java = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/forge_test/o_forge_item/content/ModItems.java'), 'utf8')
  assert.match(java, /DeferredRegister\.create\(ForgeRegistries\.ITEMS, Main\.MOD_ID\)/)
  assert.match(java, /RegistryObject<Item> FORGE_ITEM = ITEMS\.register\("forge_item"/)
  assert.match(java, /\.stacksTo\(32\)/)

  const index = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/forge_test/ContentIndex.java'), 'utf8')
  assert.match(index, /import net\.minecraftforge\.eventbus\.api\.IEventBus;/, 'Forge 的 ContentIndex 必须用 Forge 总线类型')
  assert.doesNotMatch(index, /net\.neoforged/, '不能把 NeoForge 的总线类型写进 Forge 工程')
  assert.match(index, /o_forge_item\.content\.ModItems\.register\(modEventBus\);/)
  assert.equal(existsSync(path.join(f.project, 'src/main/resources/fabric.mod.json')), false)
})

test('a Forge block registers block and BlockItem separately', async () => {
  const f = await fixture()
  const value = newContentObject('block', 'forge_test')
  value.id = 'forge_test:forge_block'
  value.parameters = { ...value.parameters, hardness: 2, resistance: 4, luminance: 5 }
  assert.equal(f.save(value).editable, true)

  const java = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/forge_test/o_forge_block/content/ModBlocks.java'), 'utf8')
  assert.match(java, /DeferredRegister\.create\(ForgeRegistries\.BLOCKS, Main\.MOD_ID\)/)
  assert.match(java, /RegistryObject<Block> FORGE_BLOCK = BLOCKS\.register\("forge_block"/)
  assert.match(java, /RegistryObject<BlockItem> FORGE_BLOCK_ITEM = ITEMS\.register\("forge_block",\n?\s*\(\) -> new BlockItem\(FORGE_BLOCK\.get\(\), new Item\.Properties\(\)\)\)/)
  assert.match(java, /\.lightLevel\(state -> 5\)/)
  assert.ok(existsSync(path.join(f.project, 'src/main/resources/assets/forge_test/blockstates/forge_block.json')))
})

test('a Forge food carries FoodProperties and tool/armor/entity stay refused', async () => {
  const f = await fixture()
  const value = newContentObject('food', 'forge_test')
  value.id = 'forge_test:forge_food'
  value.parameters = { ...value.parameters, hunger: 5, saturation: 0.7 }
  assert.equal(f.save(value).editable, true)
  const java = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/forge_test/o_forge_food/content/ModItems.java'), 'utf8')
  assert.match(java, /FoodProperties\.Builder\(\)\.nutrition\(5\)\.saturationModifier\(0\.7f\)/)

  for (const kind of ['tool', 'armor', 'entity'] as const) {
    const other = newContentObject(kind, 'forge_test')
    other.id = `forge_test:probe_${kind}`
    assert.throws(() => f.save(other), (error: unknown) => {
      assert.match(String((error as Error).message), /Forge 发射器尚未实现/)
      return true
    }, kind)
  }
})
