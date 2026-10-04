/**
 * Tiered verdict: split javac output into "hard" (real errors) vs "soft" (plausible
 * concerns javac can't fully prove, e.g. AW-widened members, cross-side references).
 *
 * Why:
 *   Bare javac sees pre-remap class files; members declared accessible by the
 *   project's AccessWidener are still private at compile time and javac reports
 *   them as missing. If we treat every javac diagnostic as a hard error the model
 *   wastes repair rounds on code that's actually fine. Tiered verdict marks
 *   these so the harness can still run the full Gradle build for the
 *   authoritative answer.
 *
 * Inputs:
 *   - Diagnostics produced by `parseBuildDiagnostics()` (build-report.ts:131)
 *   - Access Widener entries from the project (access-widener.ts)
 *   - The ProjectProfile to detect splitEnvironment + source-set boundary cases
 */
import { isAwWidened, type AwEntry } from './access-widener.ts'
import type { Diagnostic, ProjectProfile } from '../shared/harness-runtime.ts'

/** Classify one diagnostic as "hard" (must fix) or "soft" (plausible concern). */
export function classifyDiagnosticSeverity(
  diagnostic: Diagnostic,
  awEntries: AwEntry[],
  profile: ProjectProfile
): 'hard' | 'soft' {
  const msg = `${diagnostic.message} ${diagnostic.raw}`
  const normalized = diagnostic.normalizedMessage || diagnostic.message

  // Split-environment cross-side reference is structurally suspect: src/main/java
  // reaching into net.minecraft.client.*. javac catches it because the named MC jar
  // is on the classpath but the Loom splitEnvironment task would reject it later.
  // We treat it as soft because Loom's task may produce a different verdict
  // (e.g. the project legitimately widens across sides via AW).
  if (
    profile.splitEnvironment
    && diagnostic.file
    && /^src\/(main|server)\/java\//i.test(diagnostic.file)
    && /\bnet\.minecraft\.client\b/i.test(msg)
  ) {
    return 'soft'
  }

  // Access Widener widened member — javac sees the pre-remap private, but the
  // project declares it accessible. Always suppress.
  if (diagnostic.symbol && diagnostic.file) {
    const owningClass = inferOwningClass(msg)
    if (owningClass && isAwWidened(awEntries, owningClass, diagnostic.symbol)) {
      return 'soft'
    }
    // Heuristic fallback: AW entries for `class` widen everything in it.
    if (owningClass && awEntries.some((entry) => entry.target === 'class' && entry.className === owningClass)) {
      return 'soft'
    }
  }

  // Loom-only annotations (@Environment, @Mixin) — javac can't validate these
  // without the Loom annotation processor (which we disable for speed). Treat
  // any "cannot find symbol" that mentions @Environment / @Mixin / @Inject as soft
  // because Loom's AP is the authoritative check.
  if (/(?:\b@Environment\b|\b@Mixin\b|\b@Inject\b|\b@Redirect\b|\b@Shadow\b)/i.test(msg)) {
    return 'soft'
  }

  // Anything else in java_compile stage is hard.
  return 'hard'
}

/** Annotate a list of diagnostics in-place with severity. Returns a new array.
 *  Rules:
 *    - If a diagnostic already carries severity=soft (e.g. a mixin-precheck
 *      cross-side warning), we keep it as soft.
 *    - Otherwise, classify via `classifyDiagnosticSeverity`.
 */
export function applyVerdict(
  diagnostics: Diagnostic[],
  awEntries: AwEntry[],
  profile: ProjectProfile
): Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.severity === 'soft') return diagnostic
    return { ...diagnostic, severity: classifyDiagnosticSeverity(diagnostic, awEntries, profile) }
  })
}

/**
 * "package X does not exist" is the cleanest hard error case — we can be sure
 * javac isn't being fooled by AW because AW only widens member access on classes
 * that exist. If the class itself is missing, the project genuinely can't compile.
 */
export function isUndeniablePackageMissing(diagnostic: Diagnostic): boolean {
  return /^package .+ does not exist$|^找不到包/.test(diagnostic.normalizedMessage || diagnostic.message)
}

/**
 * "cannot find symbol" with the offending class NAME on the next line. If that
 * class is genuinely absent from the symbol index, the error is hard. Used to
 * shortcut AW-widened false positives without needing the access-widener parser
 * to see the project files.
 */
export function isSymbolIndexResolvable(
  symbolIndex: Map<string, Set<string>> | null,
  className: string,
  memberName?: string
): boolean {
  if (!symbolIndex) return true
  const members = symbolIndex.get(className)
  if (!members) return false
  if (!memberName) return true
  return members.has(memberName)
}

/** Extract the first dotted class reference from a javac "cannot find symbol"
 *  block; returns undefined if not parseable. The owningClass is what AW matching
 *  needs to find an entry. */
function inferOwningClass(message: string): string | null {
  // javac formats "cannot find symbol:  method foo(...)" preceded by "location: class Bar"
  const locationMatch = message.match(/location:\s*class\s+([\w.$]+)/i)
  if (locationMatch) return locationMatch[1]
  // Fallback: dotted prefix in the message body.
  const dotted = message.match(/\b([a-z][\w]*(?:\.[a-z][\w]*)+)\b/i)
  return dotted ? dotted[1] : null
}