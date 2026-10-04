import type { FabricClassRecord } from './fabric-metadata.ts'

/**
 * The bundled symbol index stores only `{name, descriptor, static}` — access
 * flags are dropped — so a `$`-nested class is discoverable by name alone. When
 * a member misses on the outer class it is usually declared on one of its nested
 * classes, and `@Mixin(Outer.Inner.class)` cannot compile there (Loom/Yarn inner
 * classes are typically private); only `targets = "Outer$Inner"` works.
 */
export function nestedClassMemberHints(
  classes: FabricClassRecord[],
  owner: FabricClassRecord,
  memberName: string
): string[] {
  const needle = memberName.trim().toLowerCase()
  if (!needle) return []
  const hints: string[] = []
  for (const entry of classes) {
    if (!entry.name.startsWith(`${owner.name}$`)) continue
    for (const member of [...entry.methods, ...entry.fields]) {
      if (!isRelatedName(needle, member.name.toLowerCase())) continue
      hints.push(
        `嵌套类 ${entry.name} 有 ${member.name}${member.descriptor}；` +
          `Mixin 请用 @Mixin(targets = "${entry.name}")`
      )
      if (hints.length >= 6) return hints
    }
  }
  return hints
}

function isRelatedName(needle: string, candidate: string): boolean {
  if (candidate.includes(needle) || needle.includes(candidate)) return true
  // Typos only: short names are far too collision-prone for an edit distance of 2.
  if (needle.length < 5 || candidate.length < 5) return false
  return editDistance(needle, candidate) <= 2
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost))
    }
    previous = current
  }
  return previous[b.length]
}
