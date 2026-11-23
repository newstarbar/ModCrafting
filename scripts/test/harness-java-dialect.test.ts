import test from 'node:test'
import assert from 'node:assert/strict'
import { applyJavaDialect } from '../../packages/modcrafting-core/src/version/java-dialect.ts'
import { deriveJavaApiProfile } from '../../packages/modcrafting-core/src/version/java-profile.ts'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'
import { generateContent } from '../../packages/modcrafting-core/src/content-codegen.ts'
import { newContentObject, type ContentObject } from '../../packages/modcrafting-core/src/content-model.ts'
import { generateGui } from '../../packages/modcrafting-core/src/gui-codegen.ts'
import { newGuiLayout } from '../../packages/modcrafting-core/src/gui-model.ts'
import { deriveResourceLayout } from '../../packages/modcrafting-core/src/resources/layout.ts'

const registry = getRegistry()
const apiFor = (minecraft: string) => deriveJavaApiProfile(minecraft, 'yarn', registry)

const MODERN = `import net.minecraft.registry.RegistryKey;
import net.minecraft.registry.RegistryKeys;

public class ModItems {
    private static Item register(String name, Item.Settings settings) {
        Identifier itemId = Identifier.of(Content.MOD_ID, name);
        RegistryKey<Item> itemKey = RegistryKey.of(RegistryKeys.ITEM, itemId);
        return Registry.register(Registries.ITEM, itemKey, new Item(settings.registryKey(itemKey)));
    }
}`

test('modern targets are a no-op, byte for byte', () => {
  assert.equal(applyJavaDialect(MODERN, apiFor('1.21.4')), MODERN)
})

test('pre-1.21.2 targets register by Identifier and drop registryKey settings', () => {
  const legacy = applyJavaDialect(MODERN, apiFor('1.20.1'))
  assert.match(legacy, /return Registry\.register\(Registries\.ITEM, itemId, new Item\(settings\)\);/)
  assert.doesNotMatch(legacy, /registryKey/)
  assert.doesNotMatch(legacy, /RegistryKey\.of/)
  assert.doesNotMatch(legacy, /^import net\.minecraft\.registry\.RegistryKey;/m, 'unused imports are removed')
  assert.doesNotMatch(legacy, /^import net\.minecraft\.registry\.RegistryKeys;/m)
  assert.match(legacy, /new Identifier\(Content\.MOD_ID, name\)/)
})

test('inline RegistryKey expressions inside settings are removed too', () => {
  const modern = 'Block block = new Block(Block.Settings.create().registryKey(RegistryKey.of(RegistryKeys.BLOCK, Identifier.of(Content.MOD_ID, "ruby_block"))).luminance(state -> 0));'
  const legacy = applyJavaDialect(modern, apiFor('1.20.1'))
  assert.equal(legacy, 'Block block = new Block(Block.Settings.create().luminance(state -> 0));')
})

test('the food component package follows the target generation', () => {
  // Ground truth from the Yarn mappings: 1.20.1+build.10 maps it under net.minecraft.item.
  assert.equal(apiFor('1.20.1').packages.food, 'net.minecraft.item.FoodComponent')
  assert.equal(apiFor('1.21.4').packages.food, 'net.minecraft.component.type.FoodComponent')
})

test('the food builder method name follows the target generation', () => {
  assert.equal(apiFor('1.20.1').foodNutrition, 'hunger')
  assert.equal(apiFor('1.21.4').foodNutrition, 'nutrition')
})

test('the GUI draw call and Screen.renderBackground follow the target generation', () => {
  const legacy = generateGui(newGuiLayout('dialect_test'), false, '1.20.1').files[0].content
  assert.doesNotMatch(legacy, /RenderLayer::getGuiTextured/, '1.20.1 uses the plain drawTexture overload')
  assert.doesNotMatch(legacy, /^import net\.minecraft\.client\.render\.RenderLayer;/m)
  assert.match(legacy, /renderBackground\(DrawContext ctx\)/)
  assert.match(legacy, /new Identifier\(/)

  const modern = generateGui(newGuiLayout('dialect_test'), false, '1.21.4').files[0].content
  assert.match(modern, /drawTexture\(RenderLayer::getGuiTextured,/)
  assert.match(modern, /renderBackground\(DrawContext ctx,int mouseX,int mouseY,float delta\)/)
})

test('tool, armor and entity are refused on pre-1.21.2 targets instead of emitting wrong Java', () => {
  const layout = deriveResourceLayout('1.20.1', registry)
  for (const kind of ['tool', 'armor', 'entity'] as const) {
    const value: ContentObject = newContentObject(kind, 'dialect_test')
    value.id = 'dialect_test:probe'
    assert.throws(() => generateContent(value, { layout }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'JAVA_DIALECT_UNSUPPORTED')
      return true
    }, kind)
  }
  // The same kinds still work on the modern target.
  const modernLayout = deriveResourceLayout('1.21.4', registry)
  const value = newContentObject('tool', 'dialect_test')
  value.id = 'dialect_test:probe'
  assert.ok(generateContent(value, { layout: modernLayout }).files.length > 0)
})
