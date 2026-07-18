import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import zlib from 'node:zlib'
import { buildRecipeContent, validateRecipeContent } from '../src/renderer/src/harness/recipe-utils.ts'
import { buildMixinScaffold, parseMethodDescriptor, type MixinScaffoldMetadata } from '../src/renderer/src/harness/mixin-utils.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import { isToolAllowedForStep } from '../src/renderer/src/harness/step-policy.ts'
import { recordsStepEvidence } from '../src/renderer/src/harness/workflow-engine.ts'
import type { ToolResult } from '../src/renderer/src/harness/tools.ts'

const vanilla = new Set(['minecraft:stone', 'minecraft:diamond', 'minecraft:iron_ore', 'minecraft:iron_ingot'])
const recipeOptions = { path: 'src/main/resources/data/example/recipe/test.json', modId: 'example', knownVanillaIds: vanilla }

test('1.21.4 recipe validator accepts all five supported recipe types', () => {
  const recipes = [
    buildRecipeContent({ type: 'shapeless', ingredients: [{ item: 'minecraft:stone' }], result: { item: 'minecraft:diamond' }, mcVersion: '1.21.4' }),
    buildRecipeContent({ type: 'shaped', pattern: ['SS', 'SS'], keys: { S: { item: 'minecraft:stone' } }, result: { item: 'minecraft:diamond' }, mcVersion: '1.21.4' }),
    buildRecipeContent({ type: 'smelting', ingredient: { item: 'minecraft:iron_ore' }, result: { item: 'minecraft:iron_ingot' }, experience: 0.7, cookingTime: 200, mcVersion: '1.21.4' }),
    buildRecipeContent({ type: 'blasting', ingredient: { item: 'minecraft:iron_ore' }, result: { item: 'minecraft:iron_ingot' }, experience: 0.7, cookingTime: 100, mcVersion: '1.21.4' }),
    buildRecipeContent({ type: 'stonecutting', ingredient: { item: 'minecraft:stone' }, result: { item: 'minecraft:diamond' }, mcVersion: '1.21.4' })
  ]
  for (const content of recipes) assert.equal(validateRecipeContent(content, recipeOptions).valid, true, content)
})

test('recipe validator rejects legacy format, plural path and invalid shaped keys', () => {
  const legacy = JSON.stringify({
    type: 'minecraft:crafting_shaped', pattern: ['AB', 'A'],
    key: { A: { item: 'minecraft:stone' }, C: 'minecraft:diamond' },
    result: { item: 'minecraft:diamond' }
  })
  const result = validateRecipeContent(legacy, { ...recipeOptions, path: 'src/main/resources/data/example/recipes/test.json' })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /路径必须|等宽|旧版|缺少 key|未在 pattern|result\.id/)
})

test('recipe validator rejects empty shapeless and unknown vanilla ids', () => {
  const content = JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: [], result: { id: 'minecraft:not_real' } })
  const result = validateRecipeContent(content, recipeOptions)
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /1–9|未知/)
})

function metadata(overrides: Partial<MixinScaffoldMetadata> = {}): MixinScaffoldMetadata {
  return { version: 1, targetClass: 'net.minecraft.entity.LivingEntity', selector: 'tick', descriptor: '()V', injectionType: 'inject', at: 'HEAD', side: 'common', ...overrides }
}

test('Mixin descriptor parser and Inject scaffold produce exact callback shape', () => {
  assert.deepEqual(parseMethodDescriptor('(Lnet/minecraft/entity/Entity;I)Z'), {
    parameters: ['net.minecraft.entity.Entity', 'int'], returnType: 'boolean'
  })
  const source = buildMixinScaffold({ packageName: 'com.example.mixin', className: 'LivingMixin', metadata: metadata(), targetStatic: false })
  assert.match(source, /@Inject\(method = "tick\(\)V"/)
  assert.match(source, /CallbackInfo ci/)
  assert.match(source, /MODCRAFTING_MIXIN/)
})

test('Mixin scaffold covers supported injection families', () => {
  const cases: Array<{ meta: MixinScaffoldMetadata; expected: RegExp }> = [
    { meta: metadata({ selector: 'health', descriptor: 'F', injectionType: 'accessor' }), expected: /@Accessor\("health"\)/ },
    { meta: metadata({ selector: 'damage', descriptor: '(F)V', injectionType: 'invoker' }), expected: /@Invoker\("damage"\)/ },
    { meta: metadata({ injectionType: 'redirect', at: 'INVOKE', atTarget: 'Lnet/minecraft/entity/LivingEntity;tick()V' }), expected: /@Redirect/ },
    { meta: metadata({ injectionType: 'modify_arg', at: 'INVOKE', atTarget: 'Lnet/minecraft/entity/LivingEntity;damage(F)V', argumentIndex: 0 }), expected: /@ModifyArg/ },
    { meta: metadata({ selector: 'isAlive', descriptor: '()Z', injectionType: 'modify_return_value', at: 'RETURN' }), expected: /@ModifyReturnValue/ }
  ]
  for (const entry of cases) {
    const source = buildMixinScaffold({ packageName: 'com.example.mixin', className: 'GeneratedMixin', metadata: entry.meta, targetStatic: false, atTargetStatic: false })
    assert.match(source, entry.expected)
  }
})

test('workflow classifies Mixin separately and allows write/delete for client migration', () => {
  const [step] = normalizeWorkflowSteps([{ id: '1', description: '实现 PlayerMixin 并注册', status: 'running', kind: 'mixin', targetPath: 'src/main/java/com/example/mixin/PlayerMixin.java' }])
  assert.equal(step.kind, 'mixin')
  assert.equal(isToolAllowedForStep(step, { name: 'write_file', args: { path: step.targetPath } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'delete_file', args: { path: step.targetPath } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'edit_file', args: { path: step.targetPath } }), true)
  assert.equal(isToolAllowedForStep(step, { name: 'fabric_mixin_validate', args: { sourcePath: step.targetPath } }), true)
  assert.ok(step.allowedTools.includes('write_file'))
  assert.ok(step.allowedTools.includes('delete_file'))
})

test('recipe and Mixin evidence require structured validation', () => {
  const [recipeStep] = normalizeWorkflowSteps([{ id: '1', description: '生成配方', status: 'running', kind: 'recipe' }])
  const [mixinStep] = normalizeWorkflowSteps([{ id: '1', description: '生成 Mixin', status: 'running', kind: 'mixin' }])
  const plain: ToolResult = { output: 'written', ok: true, durationMs: 0, toolName: 'fabric_recipe_generate' }
  assert.equal(recordsStepEvidence(recipeStep, plain), false)
  assert.equal(recordsStepEvidence(recipeStep, { ...plain, validation: { kind: 'recipe', valid: true, version: '1.21.4', checkedAt: 1 } }), true)
  assert.equal(recordsStepEvidence(mixinStep, { ...plain, toolName: 'fabric_mixin_validate', validation: { kind: 'mixin', valid: true, version: '1.21.4', checkedAt: 1 } }), true)
})

test('bundled symbol index contains exact static and side metadata', () => {
  const index = JSON.parse(zlib.gunzipSync(fs.readFileSync('resources/fabric-symbol-index-1.21.4.json.gz')).toString('utf8'))
  assert.equal(index.minecraftVersion, '1.21.4')
  assert.equal(index.yarnMappings, '1.21.4+build.1')
  const living = index.classes.find((entry: { name: string }) => entry.name === 'net.minecraft.entity.LivingEntity')
  const clientPlayer = index.classes.find((entry: { name: string }) => entry.name === 'net.minecraft.client.network.ClientPlayerEntity')
  assert.equal(living.side, 'common')
  assert.equal(clientPlayer.side, 'client')
  assert.equal(living.methods.find((entry: { name: string; descriptor: string }) => entry.name === 'tick' && entry.descriptor === '()V').static, false)
})
