/**
 * Compatibility shell. The implementation lives in `resources/layout.ts` so that
 * resource paths and dialects have exactly one owner.
 *
 * Kept as a separate module because existing imports (and one harness test) point
 * at this path; do not add logic here.
 */
export {
  deriveResourceLayout,
  dialectSignature,
  resourceDialect,
  unconfirmedShapes,
  RESOURCE_SHAPE_EVIDENCE,
  type AdvancementDir,
  type BlockstateDialect,
  type BlockTagDir,
  type ItemModelDefinitionMode,
  type ItemTagDir,
  type LootTableDir,
  type RecipeDir,
  type RecipeIngredientDialect,
  type RecipeResultDialect,
  type ResourceDialect,
  type ResourceLayout,
  type ResourceShape
} from '../resources/layout.ts'
