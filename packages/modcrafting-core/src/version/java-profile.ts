/**
 * Java API profile: the projection that changes with Minecraft *and* with the
 * mapping set (Yarn for Fabric, Mojmap/official for NeoForge and Forge).
 *
 * This is deliberately data, not branches inside codegen. When a generated class
 * needs `Identifier`, it reads `api.packages.identifier`; it must never spell
 * `net.minecraft...` itself. A unit test asserts that dialect output contains no
 * hard-coded `net.minecraft.` literal.
 */
import { ERA } from './eras.ts'
import type { MappingKind } from './schema.ts'
import type { VersionRegistry } from './registry.ts'

export interface JavaApiProfile {
  readonly languageLevel: 17 | 21 | 25
  readonly mapping: MappingKind
  readonly identifier: 'new' | 'of'
  readonly food: 'settings-food' | 'food-component' | 'consumable-component'
  /** Probed against the mappings: 1.20.1's builder calls it `hunger`, 1.20.5+ `nutrition`. */
  readonly foodNutrition: 'hunger' | 'nutrition'
  readonly registration: 'raw-registry' | 'registry-key'
  readonly render: {
    readonly guiTextureDraw: 'legacy-9arg' | 'render-layer-fn' | 'pending'
    readonly screenPipeline: 'immediate' | 'state-extract'
  }
  readonly entity: { readonly renderState: 'entity' | 'shared-state' }
  readonly packages: {
    readonly identifier: string
    readonly item: string
    readonly block: string
    readonly registry: string
    readonly food: string
  }
}

const MOJMAP = {
  identifier: 'net.minecraft.resources.ResourceLocation',
  item: 'net.minecraft.world.item.Item',
  block: 'net.minecraft.world.level.block.Block',
  registry: 'net.minecraft.core.registries.BuiltInRegistries',
  food: 'net.minecraft.world.food.FoodProperties'
} as const

/**
 * Probed 2026-11-16 against the real Yarn mappings: before 1.20.5 `FoodComponent`
 * lives under `net.minecraft.item` (`net/minecraft/item/FoodComponent` in
 * 1.20.1+build.10), and moves to `net.minecraft.component.type` from 1.20.5. A
 * wrong package here is not a style issue, it is a compile failure.
 */
const yarnPackages = (food: JavaApiProfile['food']) => ({
  identifier: 'net.minecraft.util.Identifier',
  item: 'net.minecraft.item.Item',
  block: 'net.minecraft.block.Block',
  registry: 'net.minecraft.registry.Registries',
  food: food === 'settings-food' ? 'net.minecraft.item.FoodComponent' : 'net.minecraft.component.type.FoodComponent'
})

export function deriveJavaApiProfile(minecraft: string, mapping: MappingKind, registry: VersionRegistry): JavaApiProfile {
  const languageLevel = registry.atLeast(minecraft, ERA.java25) ? 25 : registry.atLeast(minecraft, ERA.java21) ? 21 : 17
  const consumable = registry.atLeast(minecraft, ERA.consumableComponent)
  const food = consumable ? 'consumable-component' : registry.atLeast(minecraft, ERA.resultIdField) ? 'food-component' : 'settings-food'
  return {
    languageLevel,
    mapping,
    identifier: registry.atLeast(minecraft, ERA.singularDataDir) ? 'of' : 'new',
    food,
    foodNutrition: food === 'settings-food' ? 'hunger' : 'nutrition',
    registration: registry.atLeast(minecraft, ERA.stringRecipeIngredient) ? 'registry-key' : 'raw-registry',
    render: {
      guiTextureDraw: registry.atLeast(minecraft, ERA.entityRenderState) ? 'render-layer-fn' : 'legacy-9arg',
      screenPipeline: registry.atLeast(minecraft, ERA.guiStateExtract) ? 'state-extract' : 'immediate'
    },
    entity: { renderState: registry.atLeast(minecraft, ERA.entityRenderState) ? 'shared-state' : 'entity' },
    packages: mapping === 'yarn' ? yarnPackages(food) : MOJMAP
  }
}
