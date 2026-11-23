/**
 * Source-level adaptation of generated Java to the target's API era.
 *
 * The templates always emit the modern form (1.21.2+: `Identifier.of`,
 * `RegistryKey`-based registration, `settings.registryKey(...)`). Older targets
 * need the pre-1.21.2 form, and rewriting seven template sites with branches would
 * multiply the places that can silently drift. One deterministic transform, pinned
 * by unit tests and proven by real Gradle compiles on both eras, is cheaper to
 * trust.
 *
 * No-Op on modern targets, so 1.21.4 output stays byte-identical (pinned by golden).
 */
import type { JavaApiProfile } from './java-profile.ts'

export function applyJavaDialect(java: string, api: JavaApiProfile): string {
  let source = java
  if (api.identifier === 'new') source = source.replaceAll('Identifier.of(', 'new Identifier(')
  if (api.registration === 'registry-key') return source

  // Pre-1.21.2 Yarn registers by Identifier, and Item/Block settings have no registryKey.
  // Collect `RegistryKey<T> key = RegistryKey.of(KIND, rhs)` first: the right-hand side is
  // reused verbatim at the register call, whether it is a variable or an inline expression.
  const keyToIdentifier = new Map<string, string>()
  source = source.replace(/^[ \t]*RegistryKey<[^;]+> (\w+) = RegistryKey\.of\(RegistryKeys\.\w+, ([^;]+)\);\r?\n/gm, (_match, keyVar: string, rhs: string) => {
    keyToIdentifier.set(keyVar, rhs.trim())
    return ''
  })
  // Inline form used directly inside settings expressions (block settings path).
  source = source.replace(/\.registryKey\(RegistryKey\.of\(RegistryKeys\.\w+, new Identifier\([^()]*\)\)\)/g, '')
  for (const [keyVar, identifierExpression] of keyToIdentifier) {
    source = source.replaceAll(`.registryKey(${keyVar})`, '')
    for (const registry of ['ITEM', 'BLOCK', 'ENTITY_TYPE']) {
      source = source.replaceAll(`Registry.register(Registries.${registry}, ${keyVar}, `, `Registry.register(Registries.${registry}, ${identifierExpression}, `)
    }
  }
  // In raw-registry output every RegistryKey usage has been removed by the rules
  // above, so the two imports are dead weight. Checking the remaining body for the
  // substring cannot work here: the import lines themselves contain the word.
  source = source.replace(/^import net\.minecraft\.registry\.RegistryKey;\r?\n/gm, '')
  source = source.replace(/^import net\.minecraft\.registry\.RegistryKeys;\r?\n/gm, '')
  return source
}
