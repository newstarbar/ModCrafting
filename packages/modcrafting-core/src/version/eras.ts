/**
 * The only place that knows when Minecraft changed a resource or API shape.
 *
 * Every boundary is expressed as a version id and compared through the catalog
 * release sequence, so the year-based ids work unchanged. Adding a new Minecraft
 * version usually means editing zero or two lines here — that is the whole point.
 *
 * Anything marked `confirmed: false` is a working hypothesis that a compile or
 * resource probe still has to settle. Do not promote a boundary to fact without
 * evidence, and never encode a boundary as a numeric comparison.
 */
export const ERA = {
  /** result.item -> result.id in recipe JSON. */
  resultIdField: '1.20.5',
  /** data/<ns>/recipes -> data/<ns>/recipe, loot_tables -> loot_table, tags/items -> tags/item. */
  singularDataDir: '1.21',
  /** Singular string ingredients and keys instead of {"item": ...} objects. */
  stringRecipeIngredient: '1.21.2',
  /** Entity renderers receive a shared EntityRenderState instead of the entity. */
  entityRenderState: '1.21.2',
  /** Item models need assets/<ns>/items/<name>.json definitions on top of models/item. */
  itemModelDefinition: '1.21.4',
  /** Blockstate and block model JSON gained a wrapper. Unconfirmed until a resource probe diffs it. */
  blockstateV2: '1.21.5',
  /** FoodComponent replaced by a food data component. Unconfirmed until a compile probe. */
  consumableComponent: '1.21.2',
  /** Screens render through an extracted render state instead of immediate drawing. */
  guiStateExtract: '26.1',
  /** Minecraft 26.1 requires Java 25; 1.20.5+ requires 21; older requires 17. */
  java25: '26.1',
  java21: '1.20.5',
  /** Minecraft 26.1 dropped obfuscation, so official names are usable. */
  unobfuscated: '26.1'
} as const

export type EraBoundary = (typeof ERA)[keyof typeof ERA]
