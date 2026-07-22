import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveJavaPackage,
  javaPackageFromMainEntry,
  normalizeFormFieldsForCodegen,
  formatFormSummaryForDisplay,
  buildQuickCreateUserMessage,
  isQuickCreateGeneratedMessage
} from '../../src/renderer/src/project/template-params.ts'
import { runTemplateCodegen } from '../../src/renderer/src/project/template-codegen.ts'
import type { ProjectCreateConfig } from '../../src/renderer/src/project/scaffold.ts'

const baseConfig: ProjectCreateConfig = {
  projectDir: '/tmp/mod',
  folderName: 'mod',
  displayName: 'Test Mod',
  modId: 'example_mod',
  groupId: 'com.example',
  javaPackage: 'mymod',
  authors: '',
  description: '',
  modVersion: '1.0.0',
  versions: {
    minecraft_version: '1.21.4',
    loader_version: '0.16.10',
    fabric_version: '',
    yarn_mappings: '',
    loom_version: '',
    gradle_version: ''
  }
}

test('deriveJavaPackage avoids duplicating groupId as javaPackage folder', () => {
  const pkg = deriveJavaPackage(['com', 'example', 'mymod'], 'com.example', 'example_mod')
  assert.equal(pkg, 'mymod')
})

test('deriveJavaPackage falls back to modId when path equals groupId', () => {
  const pkg = deriveJavaPackage(['com', 'example'], 'com.example', 'example_mod')
  assert.equal(pkg, 'example_mod')
})

test('javaPackageFromMainEntry parses FQN after groupId', () => {
  const pkg = javaPackageFromMainEntry('com.example.mymod.ExampleMod', 'com.example', 'example_mod')
  assert.equal(pkg, 'mymod')
})

test('normalizeFormFieldsForCodegen maps protection and coerces empty numbers', () => {
  const { formFields, appliedSummary } = normalizeFormFieldsForCodegen('custom-armor', {
    armorName: '测试盔',
    armorId: 'test_helm',
    armorType: 'helmet',
    material: 'iron',
    protection: 5,
    specialEffect: 'none'
  })
  assert.equal(formFields.durability, 5)
  assert.ok(appliedSummary.some((s) => s.includes('防护值=5')))
})

test('normalizeFormFieldsForCodegen maps specialEffect to effect for food', () => {
  const { formFields } = normalizeFormFieldsForCodegen('custom-food', {
    foodName: '测试食物',
    foodId: 'test_food',
    hunger: '',
    saturation: 0.6,
    isMeat: 'yes',
    effect: 'speed'
  })
  assert.equal(formFields.hunger, 6)
  assert.equal(formFields.isMeat, 'yes')
  assert.equal(formFields.effect, 'speed')
})

test('formatFormSummaryForDisplay includes user-filled labels', () => {
  const summary = formatFormSummaryForDisplay('custom-block', {
    blockName: '测试方块',
    blockId: 'test_block',
    hardness: 3,
    resistance: 6,
    materialStyle: 'stone',
    specialFeatures: 'glowing',
    customRender: 'no'
  })
  assert.match(summary, /硬度值：3/)
  assert.match(summary, /特殊功能：发光/)
})

test('buildQuickCreateUserMessage includes form summary and applied params', () => {
  const message = buildQuickCreateUserMessage({
    templateId: 'custom-block',
    displayName: '测试',
    name: 'test_block',
    formData: { blockName: '测试', hardness: 3, specialFeatures: 'glowing' },
    createdFiles: ['src/main/java/com/example/mymod/TestBlock.java'],
    appliedParams: ['硬度=3', '发光=是'],
    unsupportedParams: [],
    ok: true
  })
  assert.match(message, /【快捷创建】模板已生成/)
  assert.match(message, /用户填写/)
  assert.match(message, /已写入代码的参数/)
  assert.match(message, /生成文件/)
})

test('runTemplateCodegen custom-block writes hardness and luminance literals', () => {
  const result = runTemplateCodegen({
    templateId: 'custom-block',
    config: baseConfig,
    name: 'test_block',
    displayName: '测试方块',
    formFields: { hardness: 3, resistance: 6, materialStyle: 'stone', specialFeatures: 'glowing' }
  })
  const modBlocks = result.files.find((f) => f.path.endsWith('ModBlocks.java'))?.content || ''
  assert.match(modBlocks, /\.strength\(3f, 6f\)/)
  assert.match(modBlocks, /luminance\(state -> 15\)/)
  assert.ok(result.appliedParams?.some((p) => p.startsWith('硬度=3')))
})

test('runTemplateCodegen custom-food writes nutrition and meat()', () => {
  const result = runTemplateCodegen({
    templateId: 'custom-food',
    config: baseConfig,
    name: 'test_food',
    displayName: '测试食物',
    formFields: { hunger: 10, saturation: 0.8, isMeat: 'yes', effect: 'none' }
  })
  const modItems = result.files.find((f) => f.path.endsWith('ModItems.java'))?.content || ''
  assert.match(modItems, /\.nutrition\(10\)/)
  assert.match(modItems, /\.meat\(\)/)
})

test('deriveJavaPackage avoids dotted folder when groupId missing', () => {
  const pkg = deriveJavaPackage(['com.example'], '', 'my-mod')
  assert.equal(pkg, 'my_mod')
})

test('isQuickCreateGeneratedMessage detects post-codegen build request', () => {
  const message = buildQuickCreateUserMessage({
    templateId: 'custom-block',
    displayName: '测试',
    name: 'ceshi',
    formData: {},
    createdFiles: [],
    appliedParams: [],
    unsupportedParams: [],
    ok: true
  })
  assert.equal(isQuickCreateGeneratedMessage(message), true)
})

test('runTemplateCodegen custom-block does not emit deprecated APIs', () => {
  const result = runTemplateCodegen({
    templateId: 'custom-block',
    config: baseConfig,
    name: 'test_block',
    displayName: '测试方块',
    formFields: { hardness: 3, resistance: 6, materialStyle: 'stone', specialFeatures: 'glowing', customRender: 'particles' }
  })
  const modBlocks = result.files.find((f) => f.path.endsWith('ModBlocks.java'))?.content || ''
  const blockClass = result.files.find((f) => f.path.endsWith('Block.java'))?.content || ''
  assert.doesNotMatch(modBlocks, /useBlockDescriptionPrefix/)
  assert.doesNotMatch(blockClass, /addParticleClient/)
  assert.match(blockClass, /addParticle\(/)
})

test('javaPath uses single javaPackage segment under groupId', () => {
  const result = runTemplateCodegen({
    templateId: 'custom-item',
    config: baseConfig,
    name: 'ruby',
    displayName: '红宝石',
    formFields: { maxStackSize: 64, hasDurability: 'no' }
  })
  const javaFile = result.files.find((f) => f.path.endsWith('ModItems.java'))
  assert.ok(javaFile)
  assert.match(javaFile!.path, /src\/main\/java\/com\/example\/mymod\/ModItems\.java$/)
  assert.doesNotMatch(javaFile!.path, /com\.example/)
})
