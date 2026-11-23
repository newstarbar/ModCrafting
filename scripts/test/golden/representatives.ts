/**
 * Which representative version covers which matrix cell.
 *
 * Derived from `dialectSignature()` so the table can never drift from the layout
 * logic: a new Minecraft release lands in the right bucket automatically, and a
 * newly implemented dialect dimension immediately splits its bucket.
 *
 * Note: `blockstate` is excluded from the signature while `RESOURCE_SHAPE_EVIDENCE`
 * marks it unconfirmed, because an unconfirmed dimension does not change emitted
 * bytes yet. Including it would demand migrations that rewrite nothing.
 */
import { dialectSignature, deriveResourceLayout } from '../../../packages/modcrafting-core/src/resources/layout.ts'
import { loaderIds } from '../../../packages/modcrafting-core/src/version/schema.ts'
import { getRegistry } from '../../../packages/modcrafting-core/src/version/registry.ts'

const registry = getRegistry()
const milestones = registry.milestones()

const signatureOf = (minecraft: string): string => dialectSignature(deriveResourceLayout(minecraft, registry))

const representativeBySignature = new Map<string, string>()
for (const minecraft of milestones) {
  const signature = signatureOf(minecraft)
  if (!representativeBySignature.has(signature)) representativeBySignature.set(signature, minecraft)
}

export const REPRESENTATIVES: readonly string[] = [...representativeBySignature.values()]

export const CELL_REPRESENTATIVE: Record<string, string> = Object.fromEntries(
  loaderIds.flatMap((loader) => milestones.map((minecraft) => [`${loader}@${minecraft}`, representativeBySignature.get(signatureOf(minecraft))!]))
)
