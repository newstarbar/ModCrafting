import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { contentWorkspace, createRuntimePaths, ensureRuntimePaths, newContentObject, type ContentDocument, type ContentRequest } from '../../packages/modcrafting-core/src/index.ts'
import { materializeProject } from '../../packages/modcrafting-core/src/node.ts'
import { resolveTarget } from '../../packages/modcrafting-core/src/version/targets.ts'

async function fixture() {
  mkdirSync('temp', { recursive: true })
  const root = mkdtempSync(path.resolve('temp/neoforge-content-')), project = path.join(root, 'project'), paths = createRuntimePaths(path.join(root, 'data'))
  ensureRuntimePaths(paths)
  const wrapper = { batch: '@echo off\r\n', properties: 'distributionUrl=gradle-9.5.0-bin.zip\n', jarBase64: Buffer.from('jar').toString('base64') }
  await materializeProject({ projectPath: project, modId: 'neo_test', modName: 'Neo Test', target: resolveTarget('neoforge', '1.21.4'), wrapper })
  // Knowledge must be written after scaffolding: the scaffold refuses a non-empty directory.
  mkdirSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4'), { recursive: true })
  writeFileSync(path.join(project, '.modcrafting/knowledge/minecraft-data/1.21.4/index.json'), JSON.stringify({
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

test('saving an item into a NeoForge project emits DeferredRegister Java and aggregates it', async () => {
  const f = await fixture()
  const value = newContentObject('item', 'neo_test')
  value.id = 'neo_test:probe_item'
  value.displayName = '探针物品'
  value.parameters = { ...value.parameters, maxStackSize: 16 }
  const document = f.save(value)
  assert.equal(document.editable, true, document.reason)

  const itemFile = path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/o_probe_item/content/ModItems.java')
  assert.ok(existsSync(itemFile), '内容类必须按对象分目录生成')
  const java = readFileSync(itemFile, 'utf8')
  assert.match(java, /DeferredRegister\.createItems\(Main\.MOD_ID\)/)
  assert.match(java, /ITEMS\.registerSimpleItem\("probe_item", new Item\.Properties\(\)\.stacksTo\(16\)\)/)
  assert.match(java, /public static void register\(IEventBus bus\)/)
  assert.doesNotMatch(java, /net\.minecraft\.item\.Item;/, 'Mojmap target must not import Yarn packages')
  assert.match(java, /net\.minecraft\.world\.item\.Item/)

  const index = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/ContentIndex.java'), 'utf8')
  assert.match(index, /modcrafting\.generated\.neo_test\.o_probe_item\.content\.ModItems\.register\(modEventBus\);/, 'ContentIndex 必须登记每个内容类')

  const main = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/Main.java'), 'utf8')
  assert.match(main, /ContentIndex\.register\(modEventBus\);/)

  assert.equal(existsSync(path.join(f.project, 'src/main/resources/fabric.mod.json')), false, '不能给 NeoForge 工程写 Fabric 元数据')
  const lang = JSON.parse(readFileSync(path.join(f.project, 'src/main/resources/assets/neo_test/lang/zh_cn.json'), 'utf8'))
  assert.equal(lang['item.neo_test.probe_item'], '探针物品')
})

test('two items produce two registration entries and do not collide on one file', async () => {
  const f = await fixture()
  for (const name of ['first_item', 'second_item']) {
    const value = newContentObject('item', 'neo_test')
    value.id = `neo_test:${name}`
    f.save(value)
  }
  const index = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/ContentIndex.java'), 'utf8')
  assert.equal((index.match(/content\.ModItems\.register\(modEventBus\);/g) ?? []).length, 2)
  assert.ok(existsSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/o_first_item/content/ModItems.java')))
  assert.ok(existsSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/o_second_item/content/ModItems.java')))
})

test('a block emits BlockBehaviour properties and reuses the shared resource layer', async () => {
  const f = await fixture()
  const value = newContentObject('block', 'neo_test')
  value.id = 'neo_test:probe_block'
  value.displayName = '探针方块'
  value.parameters = { ...value.parameters, hardness: 3, resistance: 9, luminance: 7, materialStyle: 'metal' }
  assert.equal(f.save(value).editable, true)

  const java = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/o_probe_block/content/ModBlocks.java'), 'utf8')
  assert.match(java, /DeferredRegister\.createBlocks\(Main\.MOD_ID\)/)
  assert.match(java, /new Block\(BlockBehaviour\.Properties\.of\(\)/)
  assert.match(java, /\.strength\(3f, 9f\)/)
  assert.match(java, /\.lightLevel\(state -> 7\)/)
  assert.match(java, /\.sound\(SoundType\.METAL\)/)
  assert.match(java, /ITEMS\.registerSimpleBlockItem\("probe_block", PROBE_BLOCK\)/, '方块必须有对应的 BlockItem，否则拿不到物品形态')

  const resources = [
    'src/main/resources/assets/neo_test/blockstates/probe_block.json',
    'src/main/resources/assets/neo_test/models/block/probe_block.json',
    'src/main/resources/assets/neo_test/models/item/probe_block.json',
    'src/main/resources/data/neo_test/loot_table/blocks/probe_block.json'
  ]
  for (const file of resources) assert.ok(existsSync(path.join(f.project, file)), '缺少资源：' + file)
  assert.match(readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/ContentIndex.java'), 'utf8'), /o_probe_block\.content\.ModBlocks\.register\(modEventBus\);/)
})

test('food emits a FoodProperties builder with the requested nutrition', async () => {
  const f = await fixture()
  const value = newContentObject('food', 'neo_test')
  value.id = 'neo_test:probe_food'
  value.displayName = '探针食物'
  value.parameters = { ...value.parameters, hunger: 7, saturation: 0.8 }
  assert.equal(f.save(value).editable, true)

  const java = readFileSync(path.join(f.project, 'src/main/java/modcrafting/generated/neo_test/o_probe_food/content/ModItems.java'), 'utf8')
  assert.match(java, /new FoodProperties\.Builder\(\)\.nutrition\(7\)\.saturationModifier\(0\.8f\)\.build\(\)/)
  assert.match(java, /net\.minecraft\.world\.food\.FoodProperties/)
  assert.doesNotMatch(java, /FoodComponent/, 'Mojmap 里没有 FoodComponent')
})

test('tool, armor and entity stay refused on NeoForge until their emitters land', async () => {
  const f = await fixture()
  for (const kind of ['tool', 'armor', 'entity'] as const) {
    const value = newContentObject(kind, 'neo_test')
    value.id = `neo_test:probe_${kind}`
    assert.throws(() => f.save(value), (error: unknown) => {
      assert.match(String((error as Error).message), /NeoForge 发射器尚未实现/)
      return true
    }, kind)
  }
})
