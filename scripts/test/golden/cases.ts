/**
 * Golden fixture set.
 *
 * These cases are the resource surface the project actually emits. They are
 * deliberately small: the point is to pin *paths and JSON shapes* per dialect,
 * not to exercise every content parameter (harness-content-workspace does that).
 */
import { newContentObject, type ContentObject } from '../../../packages/modcrafting-core/src/content-model.ts'
import type { GeneralRecipeInput } from '../../../packages/modcrafting-core/src/recipe-format.ts'
import type { VoxelDsl } from '../../../packages/modcrafting-core/src/voxel-dsl.ts'

export const GOLDEN_MOD_ID = 'golden_demo'

export interface GoldenContentCase {
  kind: 'content'
  id: string
  value: ContentObject
}

export interface GoldenRecipeCase {
  kind: 'recipe'
  id: string
  recipeId: string
  input: GeneralRecipeInput
}

export type GoldenCase = GoldenContentCase | GoldenRecipeCase

function content(kind: ContentObject['kind'], name: string, patch: Partial<ContentObject> = {}): ContentObject {
  const value = newContentObject(kind, GOLDEN_MOD_ID)
  value.id = `${GOLDEN_MOD_ID}:${name}`
  value.displayName = `Golden ${name}`
  return { ...value, ...patch }
}

const cube: VoxelDsl = {
  version: 1,
  size: [4, 4, 4],
  palette: { a: '#c0392b', b: '#2c3e50' },
  ops: [
    { op: 'box', p: 'a', from: [0, 0, 0], to: [3, 3, 3] },
    { op: 'box', p: 'b', from: [1, 1, 3], to: [2, 2, 3] }
  ],
  texture: { mode: 'shaded', resolution: 16 }
}

export const GOLDEN_CASES: GoldenCase[] = [
  { kind: 'content', id: 'block-basic', value: content('block', 'ruby_block') },
  { kind: 'content', id: 'block-voxel', value: content('block', 'ruby_lantern', { voxel: cube }) },
  { kind: 'content', id: 'item-basic', value: content('item', 'ruby') },
  { kind: 'content', id: 'item-durable', value: content('item', 'ruby_charm', { parameters: { maxStackSize: 1, durability: 120 } }) },
  { kind: 'content', id: 'item-voxel', value: content('item', 'ruby_shard', { voxel: cube }) },
  { kind: 'content', id: 'item-tool', value: content('tool', 'ruby_pickaxe') },
  { kind: 'content', id: 'item-armor', value: content('armor', 'ruby_chestplate') },
  { kind: 'content', id: 'food-basic', value: content('food', 'ruby_apple') },
  {
    kind: 'recipe',
    id: 'recipe-shaped',
    recipeId: `${GOLDEN_MOD_ID}:ruby_block`,
    input: {
      type: 'shaped',
      pattern: ['AA', 'AA'],
      keys: { A: { item: 'minecraft:iron_ingot' } },
      result: { item: `${GOLDEN_MOD_ID}:ruby`, count: 1 }
    }
  },
  {
    kind: 'recipe',
    id: 'recipe-shaped-tag',
    recipeId: `${GOLDEN_MOD_ID}:ruby_from_planks`,
    input: {
      type: 'shaped',
      pattern: ['A'],
      keys: { A: { tag: 'minecraft:planks' } },
      result: { item: `${GOLDEN_MOD_ID}:ruby`, count: 2 }
    }
  },
  {
    kind: 'recipe',
    id: 'recipe-shapeless',
    recipeId: `${GOLDEN_MOD_ID}:ruby_ingot`,
    input: { type: 'shapeless', ingredients: [{ item: 'minecraft:iron_ingot' }, { item: 'minecraft:redstone' }], result: { item: `${GOLDEN_MOD_ID}:ruby`, count: 1 } }
  },
  {
    kind: 'recipe',
    id: 'recipe-smelting',
    recipeId: `${GOLDEN_MOD_ID}:ruby_from_ore`,
    input: { type: 'smelting', ingredient: { item: 'minecraft:iron_ore' }, result: { item: `${GOLDEN_MOD_ID}:ruby` }, experience: 0.7, cookingTime: 200 }
  },
  {
    kind: 'recipe',
    id: 'recipe-blasting',
    recipeId: `${GOLDEN_MOD_ID}:ruby_fast`,
    input: { type: 'blasting', ingredient: { item: 'minecraft:iron_ore' }, result: { item: `${GOLDEN_MOD_ID}:ruby` }, experience: 1.2, cookingTime: 100 }
  },
  {
    kind: 'recipe',
    id: 'recipe-stonecutting',
    recipeId: `${GOLDEN_MOD_ID}:ruby_slab`,
    input: { type: 'stonecutting', ingredient: { item: `${GOLDEN_MOD_ID}:ruby_block` }, result: { item: `${GOLDEN_MOD_ID}:ruby`, count: 4 } }
  }
]
