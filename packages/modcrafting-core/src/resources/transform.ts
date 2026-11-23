/**
 * Resource transforms: semantic input in, target-dialect file out.
 *
 * Rules:
 *  - pure: no fs, no network, no throwing for business reasons
 *  - path + content always come together, so a caller cannot pair a 1.21.4 body
 *    with a 1.20.1 path
 *  - no `src/main/resources` literal may appear here; the layout owns paths
 *
 * Byte stability matters: 1.21.4 output is pinned by `golden/baseline.json`, so
 * key order and the trailing newline are part of the contract.
 */
import type { ResourceLayout } from './layout.ts'
import { buildRecipeContent } from '../recipe-format.ts'
import type { GeneralRecipeInput } from '../recipe-format.ts'

export interface ResourceFile { path: string; content: string }

/** JSON files in this repo always end with exactly one newline. */
export const encodeJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * `bare` and `qualified` both exist today and are byte-different but
 * semantically equal. Callers must state which one they mean instead of us
 * silently normalising one of them into a 40-file diff.
 */
export type ParentStyle = 'bare' | 'qualified'

export function parentRef(id: string, style: ParentStyle): string {
  return style === 'qualified' && !id.includes(':') ? `minecraft:${id}` : id
}

export interface BlockstateInput { namespace: string; name: string; model: string }

export function blockstateFile(layout: ResourceLayout, input: BlockstateInput): ResourceFile {
  // `variants-v2` is not implemented yet: the 1.21.5+ wrapper is unconfirmed
  // (see RESOURCE_SHAPE_EVIDENCE). Emitting a guessed shape would be worse than
  // emitting the proven one and flagging the gap.
  return {
    path: layout.blockstatePath(input.namespace, input.name),
    content: encodeJson({ variants: { '': { model: input.model } } })
  }
}

export interface ModelInput { namespace: string; name: string; parent: string; textures?: Record<string, string> }

export function blockModelFile(layout: ResourceLayout, input: ModelInput): ResourceFile {
  return {
    path: layout.blockModelPath(input.namespace, input.name),
    content: encodeJson(input.textures ? { parent: input.parent, textures: input.textures } : { parent: input.parent })
  }
}

export function itemModelFile(layout: ResourceLayout, input: ModelInput): ResourceFile {
  return {
    path: layout.itemModelPath(input.namespace, input.name),
    content: encodeJson(input.textures ? { parent: input.parent, textures: input.textures } : { parent: input.parent })
  }
}

export interface ItemDefinitionInput { namespace: string; name: string }

/** Empty on targets that predate item model definitions (before 1.21.4). */
export function itemModelDefinitionFiles(layout: ResourceLayout, input: ItemDefinitionInput): ResourceFile[] {
  const path = layout.itemModelDefinitionPath(input.namespace, input.name)
  if (!path) return []
  return [{ path, content: encodeJson({ model: { type: 'minecraft:model', model: `${input.namespace}:item/${input.name}` } }) }]
}

export interface LootTableInput { namespace: string; name: string; item: string }

export function blockLootTableFile(layout: ResourceLayout, input: LootTableInput): ResourceFile {
  return {
    path: layout.blockLootTablePath(input.namespace, input.name),
    content: encodeJson({
      type: 'minecraft:block',
      pools: [{ rolls: 1, entries: [{ type: 'minecraft:item', name: input.item }] }]
    })
  }
}

export interface RecipeFileInput { namespace: string; name: string; input: GeneralRecipeInput }

/**
 * Recipe bodies come from `recipe-format` so the validator and the writer can
 * never disagree about the dialect.
 */
export function recipeFile(layout: ResourceLayout, input: RecipeFileInput): ResourceFile {
  return {
    path: layout.recipePath(input.namespace, input.name),
    content: buildRecipeContent({ ...input.input, mcVersion: layout.minecraft })
  }
}

export interface LangFileInput { namespace: string; locale: string; existing?: string | null; entries: Record<string, string> }

export function langFile(layout: ResourceLayout, input: LangFileInput): ResourceFile {
  let base: Record<string, string> = {}
  if (input.existing?.trim()) {
    try {
      const parsed = JSON.parse(input.existing) as Record<string, string>
      if (parsed && typeof parsed === 'object') base = { ...parsed }
    } catch { base = {} }
  }
  return { path: layout.langPath(input.namespace, input.locale), content: encodeJson({ ...base, ...input.entries }) }
}

/** Texture files are version independent; the layout still owns the prefix. */
export function textureFile(layout: ResourceLayout, namespace: string, relative: string): string {
  return layout.texturePath(namespace, relative)
}
