import test from 'node:test'
import assert from 'node:assert/strict'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'
import { deriveResourceLayout } from '../../packages/modcrafting-core/src/version/resources-profile.ts'
import { deriveJavaApiProfile } from '../../packages/modcrafting-core/src/version/java-profile.ts'
import { matrix, resolveTarget, describeProjectTarget } from '../../packages/modcrafting-core/src/version/targets.ts'
import { maxEvidenceFor, isBuildable } from '../../packages/modcrafting-core/src/version/availability.ts'
import { recipeFolder, recipePath, usesResultIdField, usesStringRecipeIngredients } from '../../packages/modcrafting-core/src/recipe-format.ts'

const registry = getRegistry()

test('release order keeps year-based ids ahead of the 1.21 line', () => {
  assert.ok(registry.compare('26.3', '1.21.11') > 0, '26.3 is newer than 1.21.11')
  assert.ok(registry.compare('26.1', '26.3') < 0)
  assert.ok(registry.compare('1.21.4', '1.21.11') < 0)
  assert.equal(registry.atLeast('26.3', '1.21.11'), true)
  assert.equal(registry.atLeast('1.21.4', '1.21.5'), false)
})

test('unknown ids still compare totally instead of throwing', () => {
  // Snapshots never enter the catalog, but era boundaries must not explode on them.
  assert.ok(registry.compare('26.4-snapshot-1', '26.3') > 0)
  assert.equal(registry.has('26.4-snapshot-1'), false)
})

test('contiguous ranges refuse a gap in the release sequence', () => {
  assert.deepEqual(registry.contiguousRange(['1.21.5', '1.21.4']), { min: '1.21.4', max: '1.21.5' })
  assert.equal(registry.contiguousRange(['1.21.4', '1.21.8']), undefined, '1.21.5-1.21.7 sit in between')
  assert.equal(registry.contiguousRange(['1.21.4', '26.3-snapshot-2']), undefined)
})

test('resource layout follows the target instead of a literal', () => {
  const legacy = deriveResourceLayout('1.20.1', registry)
  assert.equal(legacy.recipeDir, 'recipes')
  assert.equal(legacy.lootTableDir, 'loot_tables')
  assert.equal(legacy.tagsDir, 'tags/items')
  assert.equal(legacy.itemModelDefinition, 'none')
  assert.equal(legacy.recipeResult, 'item-object')
  assert.equal(legacy.recipePath('demo', 'widget'), 'src/main/resources/data/demo/recipes/widget.json')

  const modern = deriveResourceLayout('1.21.4', registry)
  assert.equal(modern.recipeDir, 'recipe')
  assert.equal(modern.itemModelDefinition, 'assets-items')
  assert.equal(modern.recipeResult, 'id-object')
  assert.equal(modern.recipePath('demo', 'widget'), 'src/main/resources/data/demo/recipe/widget.json')
  assert.equal(modern.blockLootTablePath('demo', 'widget'), 'src/main/resources/data/demo/loot_table/blocks/widget.json')
  assert.equal(modern.itemModelDefinitionPath('demo', 'widget'), 'src/main/resources/assets/demo/items/widget.json')

  // Year-based ids must not fall back to legacy layout.
  const year = deriveResourceLayout('26.3', registry)
  assert.equal(year.recipeDir, 'recipe')
  assert.equal(year.itemModelDefinition, 'assets-items')
})

test('java profile switches mapping namespace and language level per target', () => {
  const yarn = deriveJavaApiProfile('1.21.4', 'yarn', registry)
  assert.equal(yarn.languageLevel, 21)
  assert.equal(yarn.identifier, 'of')
  assert.equal(yarn.packages.identifier, 'net.minecraft.util.Identifier')

  const mojmap = deriveJavaApiProfile('1.21.4', 'mojmap', registry)
  assert.equal(mojmap.packages.identifier, 'net.minecraft.resources.ResourceLocation', 'the same codegen must not leak Yarn names into Mojmap targets')

  const legacy = deriveJavaApiProfile('1.20.1', 'yarn', registry)
  assert.equal(legacy.languageLevel, 17)
  assert.equal(legacy.identifier, 'new')

  const year = deriveJavaApiProfile('26.3', 'official', registry)
  assert.equal(year.languageLevel, 25, 'Minecraft 26.x requires Java 25')
  assert.equal(year.render.screenPipeline, 'state-extract')
})

test('recipe helpers keep 1.21.4 output byte-identical and adapt to legacy targets', () => {
  assert.equal(recipeFolder(), 'recipe')
  assert.equal(recipePath('demo', 'widget'), 'src/main/resources/data/demo/recipe/widget.json')
  assert.equal(usesStringRecipeIngredients(), true)
  assert.equal(usesResultIdField(), true)

  assert.equal(recipeFolder('1.20.1'), 'recipes')
  assert.equal(recipePath('demo', 'widget', '1.20.1'), 'src/main/resources/data/demo/recipes/widget.json')
  assert.equal(usesStringRecipeIngredients('1.20.1'), false)
  assert.equal(usesResultIdField('1.20.1'), false)
  assert.equal(usesResultIdField('1.20.5'), true)

  // Year-based ids are newer than every 1.21 boundary.
  assert.equal(recipeFolder('26.1'), 'recipe')
  assert.equal(usesResultIdField('26.1'), true)
})

test('matrix covers every milestone for every loader', () => {
  const targets = matrix()
  const milestones = registry.milestones()
  assert.equal(targets.length, milestones.length * 3)
  assert.equal(new Set(targets.map((entry) => entry.id)).size, targets.length)
})

test('beta-only and latest-only cells never claim full support', () => {
  const beta = registry.cell('neoforge', '26.1')
  assert.ok(beta?.release, 'NeoForge 26.1 must resolve')
  assert.equal(beta.release.channel, 'beta')
  assert.equal(beta.status, 'build-only')
  assert.equal(maxEvidenceFor(beta), 'compile')

  const latestOnly = registry.cell('forge', '26.1')
  assert.ok(latestOnly?.release)
  assert.equal(latestOnly.release.channel, 'latest')
  assert.notEqual(latestOnly.status, 'supported')
})

test('unproven cells are declared, and only verified cells may be buildable claims', () => {
  // 1.20.x-1.21.x are all probed now, so the remaining unproven Fabric cells are the year-based line.
  const cell = registry.cell('fabric', '26.1')
  assert.ok(cell?.release)
  assert.equal(cell.status, 'declared')
  assert.equal(maxEvidenceFor(cell), 'codegen')
  assert.equal(isBuildable(cell), true)
})

test('a probed cell reports compile evidence and never claims runtime', () => {
  const cell = registry.cell('fabric', '1.21.4')
  assert.ok(cell?.release?.build)
  assert.equal(cell.release.build.evidence, 'probed', 'run pnpm run probe:target --target fabric@1.21.4 --record')
  assert.equal(cell.status, 'build-only')
  assert.equal(maxEvidenceFor(cell), 'compile', 'a compile probe is not an in-game test')
})

test('resolveTarget rejects versions outside the matrix with an actionable next step', () => {
  assert.throws(() => resolveTarget('fabric', '1.21.9'), (error: unknown) => {
    const failure = error as { code?: string; message?: string; remediation?: string }
    assert.equal(failure.code, 'TARGET_UNSUPPORTED')
    assert.match(String(failure.message), /1\.21\.9/)
    assert.match(String(failure.remediation), /versions:sync/)
    return true
  })
})

test('authoring can target a real version that is not in the publishing matrix', () => {
  const target = describeProjectTarget('fabric', '1.21.3')
  assert.equal(target.layout.recipeDir, 'recipe')
  assert.equal(target.layout.itemModelDefinition, 'none', 'item model definitions started at 1.21.4')
  assert.equal(target.cell, undefined)
  assert.throws(() => describeProjectTarget('fabric', 'not-a-version'), /无法识别/)
})
