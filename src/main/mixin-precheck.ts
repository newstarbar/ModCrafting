/**
 * Mixin / Access Widener precheck for the fast-compile path.
 *
 * Runs after javac and complements it: javac cannot validate Mixin injection
 * points without the Loom annotation processor (which we disable for speed),
 * and it cannot tell whether an @Mixin target class actually exists.
 *
 * What we check:
 *   1. @Mixin(TargetClass.class) target resolves to an existing class
 *      (project source OR fabric-symbol-index).
 *   2. Each @Inject/@Redirect/@Overwrite/@ModifyArg/@ModifyVariable/@Accessor/@Invoker
 *      target method exists on the target class with the chosen descriptor.
 *   3. @Shadow method/field exists.
 *   4. Overloaded methods without an explicit descriptor are flagged (javac
 *      does not see the @Inject annotation context).
 *   5. mixins.json `client` field referenced from a common-source mixin is
 *      flagged when the target class lives in `net.minecraft.client.*`.
 *
 * AW validation runs here too (see access-widener.ts): each accessible/mutable
 * declaration must point to an existing class+member.
 *
 * Output: a list of precheck issues. Each is either `hard` (block the unit)
 * or `soft` (surface to the harness as guidance).
 */

import type { Diagnostic, ProjectProfile } from '../shared/harness-runtime.ts'
import {
  loadAccessWidenerEntries,
  validateAccessWidenerEntries,
  type AwEntry,
  type AwValidationIssue
} from './access-widener.ts'
import { applyVerdict } from './compile-verdict.ts'

// Type matching fabric-metadata.ts's FabricSymbolResult so we don't have to
// import that module (which pulls in electron and the rest of build-env). The
// precheck only reads the .ok / .class / .methods / .fields fields.
type FabricClassRecordLike = { name: string; methods: Array<{ name: string; descriptor: string }>; fields: Array<{ name: string }> }
type FabricSymbolResultLike = { ok: boolean; error?: string; class?: FabricClassRecordLike; methods: Array<{ name: string; descriptor: string }>; fields: Array<{ name: string }>; suggestions: unknown[]; ambiguous: boolean }
type SymbolLookupFn = (req: { className: string; memberName?: string; descriptor?: string; memberKind?: 'method' | 'field' | 'any' }) => FabricSymbolResultLike | null

export interface MixinPrecheckContext {
  projectPath: string
  /** Project Java sources, one entry per file. */
  sources: Array<{ path: string; content: string }>
  /** Mixin config files (.mixins.json) under src/main/resources. */
  mixinConfigs: Array<{ path: string; content: string }>
  /** Project profile for splitEnvironment + source-set awareness. */
  projectProfile: ProjectProfile
  /** Pre-loaded AW entries (callers may have them already). */
  awEntries?: AwEntry[]
  /**
   * Symbol lookup fn. Defaults to a stub that returns "not found" for every
   * class, which makes the precheck report every @Mixin target as missing.
   * In production the host wires the real fabric-metadata lookup.
   */
  symbolLookup?: SymbolLookupFn
}

export interface MixinPrecheckContext {
  projectPath: string
  /** Project Java sources, one entry per file. */
  sources: Array<{ path: string; content: string }>
  /** Mixin config files (.mixins.json) under src/main/resources. */
  mixinConfigs: Array<{ path: string; content: string }>
  /** Project profile for splitEnvironment + source-set awareness. */
  projectProfile: ProjectProfile
  /** Pre-loaded AW entries (callers may have them already). */
  awEntries?: AwEntry[]
}

export interface MixinPrecheckResult {
  /** Diagnostics produced. Severity is already applied. */
  diagnostics: Diagnostic[]
  /** AW validation issues from access-widener.ts. */
  awIssues: AwValidationIssue[]
  /** Per-file summary (for harness telemetry). */
  perFile: Array<{ path: string; issues: number }>
}

// Annotation names → short label
const MIXIN_INJECTION_ANNOTATIONS = new Set([
  'Inject', 'Redirect', 'Overwrite', 'ModifyArg', 'ModifyVariable',
  'ModifyArgs', 'ModifyConstant', 'Accessor', 'Invoker', 'Shadow'
])

const ANNOTATION_REGEX = /@([A-Za-z_][\w.]*)\s*(?:\(([^)]*)\))?/g

/**
 * Run the full precheck. Call from the host after `fastCompile` returns.
 */
export function runMixinPrecheck(context: MixinPrecheckContext): MixinPrecheckResult {
  const awEntries = context.awEntries ?? loadAccessWidenerEntries(context.projectPath)
  const diagnostics: Diagnostic[] = []
  const perFile = new Map<string, number>()

  // 1. Parse every source file looking for mixin annotations.
  const symbolLookup = context.symbolLookup ?? defaultSymbolLookup
  for (const source of context.sources) {
    if (!source.path.includes('/java/')) continue;
    if (!/\.(?:java|kt)$/i.test(source.path)) continue
    const parsed = parseMixinFile(source.content, source.path, symbolLookup)
    perFile.set(source.path, parsed.issues.length)
    diagnostics.push(...parsed.issues)
  }

  // 2. AW validation.
  const awIssues = validateAccessWidenerEntries(awEntries, makeAwLookup(symbolLookup))
  for (const issue of awIssues) {
    diagnostics.push({
      id: `aw_${issue.kind}_${issue.entry.source}_${issue.entry.line}`,
      stage: 'mixin',
      responsibility: 'project',
      message: issue.hint,
      normalizedMessage: issue.hint,
      raw: `${issue.entry.op} ${issue.entry.target} ${issue.entry.className} ${issue.entry.memberName || ''}`,
      file: toRelative(issue.entry.source, context.projectPath),
      line: issue.entry.line,
      severity: 'hard',
      rootCauseId: `aw|${issue.kind}|${issue.entry.className}|${issue.entry.memberName || ''}`
    })
  }

  // 3. mixins.json cross-side validation.
  for (const config of context.mixinConfigs) {
    try {
      const parsed = JSON.parse(config.content) as Record<string, unknown>
      const isClientOnly = /client\.mixins\.json$/.test(config.path)
      const listed = collectMixinClassNames(parsed)
      for (const className of listed) {
        if (!className.includes('.')) continue
        // Class lives on the client classpath — if listed in a common mixin
        // config it will fail Loom's splitEnvironment task at build time.
        if (!isClientOnly && className.startsWith('net.minecraft.client.')) {
          diagnostics.push({
            id: `mixin_split_${className}`,
            stage: 'mixin',
            responsibility: 'generated_code',
            message: `mixin 类 ${className} 引用了客户端命名空间，应放入 client mixin 配置`,
            normalizedMessage: `client-class in common mixin config: ${className}`,
            raw: JSON.stringify(parsed),
            file: toRelative(config.path, context.projectPath),
            severity: context.projectProfile.splitEnvironment ? 'hard' : 'soft'
          })
        }
      }
    } catch { /* ignore malformed JSON — static gate caught it */ }
  }

  // 4. Apply tiered verdict (so AW-suppressed diagnostics stay soft if any).
  const final = applyVerdict(diagnostics, awEntries, context.projectProfile)

  return {
    diagnostics: final,
    awIssues,
    perFile: [...perFile.entries()].map(([path, issues]) => ({ path, issues }))
  }
}

// ── File parser ────────────────────────────────────────────────────────────

interface ParsedMixinFile {
  issues: Diagnostic[]
  targetClass?: string
}

function parseMixinFile(content: string, filePath: string, lookup: SymbolLookupFn): ParsedMixinFile {
  const out: Diagnostic[] = []
  const baseDiagnosticFields = { stage: 'mixin' as const, responsibility: 'generated_code' as const }

  // Strip comments first to avoid matching @Inject inside Javadoc.
  const stripped = stripComments(content)

  // Find @Mixin at the class level. We allow both `@Mixin(...)` and
  // `@Mixin(value = ..., priority = ...)`. The class declaration may be on
  // the same line OR on a subsequent line (e.g. annotated abstract class).
  const mixinMatch = stripped.match(/@Mixin\s*(?:\(([^)]+)\))?[\s\S]{0,80}?(?:class|interface)\s+([A-Za-z_][\w$]*)/)
  if (!mixinMatch) return { issues: out }
  const args = mixinMatch[1] || ''
  const className = extractMixinTargetClass(args)
  if (!className) {
    out.push({
      ...baseDiagnosticFields,
      id: `mixin_no_target_${filePath}`,
      message: '@Mixin 缺少目标类（应为 @Mixin(SomeClass.class)，嵌套类用 @Mixin(targets = "SomeClass$Inner")）',
      normalizedMessage: '@Mixin missing target',
      raw: mixinMatch[0],
      file: filePath,
      severity: 'hard',
      rootCauseId: 'mixin|no-target'
    })
    return { issues: out }
  }

  // Confirm target class exists.
  const classRecord = lookup({ className })
  const classOk = classRecord?.ok && !!classRecord.class

  if (!classOk) {
    out.push({
      ...baseDiagnosticFields,
      id: `mixin_target_missing_${className}`,
      message: `@Mixin 目标类 ${className} 在符号索引中不存在（可能是三方 mod 类、typo、或版本不匹配）`,
      normalizedMessage: `mixin target not in symbol index: ${className}`,
      raw: mixinMatch[0],
      file: filePath,
      severity: 'hard',
      rootCauseId: `mixin|target|${className}`
    })
  }

  // Walk annotations on methods/fields. Re-scan the file line-by-line for
  // precision of method references.
  const targetMembers = classRecord?.ok
    ? [...classRecord.methods.map((m) => ({ ...m, kind: 'method' as const })), ...classRecord.fields.map((f) => ({ ...f, kind: 'field' as const }))]
    : []
  const memberNames = new Set(targetMembers.map((m) => m.name))

  // Find annotation occurrences with method/field names following them.
  const annotationRe = /@(Inject|Redirect|Overwrite|ModifyArg|ModifyVariable|ModifyArgs|ModifyConstant|Accessor|Invoker|Shadow)\s*(?:\(([^)]+)\))?/g
  let m: RegExpExecArray | null
  let lineOffset = 1
  // Build a line index once for column->line translation.
  const lineIndex = buildLineIndex(stripped)

  while ((m = annotationRe.exec(stripped)) !== null) {
    const kind = m[1]
    const argsText = m[2] || ''
    if (!MIXIN_INJECTION_ANNOTATIONS.has(kind)) continue
    const memberRef = extractMixinMemberReference(argsText, kind)
    if (!memberRef) continue

    // Translate char-offset to 1-indexed line.
    const line = lineIndex[Math.min(m.index, lineIndex.length - 1)] || lineOffset
    lineOffset = line + 1

    if (kind === 'Shadow') {
      const exists = memberNames.has(memberRef.name)
      if (!exists) {
        out.push({
          ...baseDiagnosticFields,
          id: `mixin_shadow_missing_${className}_${memberRef.name}`,
          message: `@Shadow ${memberRef.name} 在目标类 ${className} 中不存在`,
          normalizedMessage: `@Shadow target missing: ${className}#${memberRef.name}`,
          raw: m[0],
          file: filePath,
          line,
          severity: 'hard',
          rootCauseId: `mixin|shadow|${className}|${memberRef.name}`
        })
      }
      continue
    }

    // Injection / accessor / invoker: target must exist.
    const candidates = targetMembers.filter((t) => t.kind === 'method' && t.name === memberRef.name)
    if (candidates.length === 0) {
      out.push({
        ...baseDiagnosticFields,
        id: `mixin_method_missing_${className}_${memberRef.name}`,
        message: `@${kind} 方法 ${memberRef.name} 在 ${className} 中不存在`,
        normalizedMessage: `@${kind} method missing: ${className}#${memberRef.name}`,
        raw: m[0],
        file: filePath,
        line,
        severity: 'hard',
        rootCauseId: `mixin|${kind}|${className}|${memberRef.name}`
      })
      continue
    }
    // Multiple overloads + no explicit descriptor → javac can't disambiguate.
    if (candidates.length > 1 && !memberRef.descriptor) {
      out.push({
        ...baseDiagnosticFields,
        id: `mixin_overload_ambiguous_${className}_${memberRef.name}`,
        message: `@${kind} ${memberRef.name} 在 ${className} 有 ${candidates.length} 个重载，必须显式指定 descriptor 才能消除歧义`,
        normalizedMessage: `@${kind} ambiguous overload: ${className}#${memberRef.name}`,
        raw: m[0],
        file: filePath,
        line,
        severity: 'soft',
        rootCauseId: `mixin|overload|${className}|${memberRef.name}`
      })
    } else if (memberRef.descriptor) {
      const hit = candidates.find((c) => c.descriptor === memberRef.descriptor)
      if (!hit) {
        out.push({
          ...baseDiagnosticFields,
          id: `mixin_desc_mismatch_${className}_${memberRef.name}`,
          message: `@${kind} ${memberRef.name} 的 descriptor ${memberRef.descriptor} 与 ${className} 上任何重载都不匹配`,
          normalizedMessage: `@${kind} descriptor mismatch: ${className}#${memberRef.name}`,
          raw: m[0],
          file: filePath,
          line,
          severity: 'hard',
          rootCauseId: `mixin|descriptor|${className}|${memberRef.name}`
        })
      }
    }
  }

  return { issues: out, targetClass: className }
}

/**
 * Best-effort: extract the target member reference from a Mixin annotation's args.
 *   @Inject(method = "foo")              -> {name:"foo"}
 *   @Inject(method = "foo(Lnet/minecraft/..;)V")` -> {name:"foo", descriptor:"(L..;)V"}
 *   @Inject(target = ...)                -> not a member reference; skipped
 *   @Shadow("foo")                       -> {name:"foo"}
 *   @Accessor("foo")                     -> {name:"foo"}
 */
function extractMixinMemberReference(args: string, _kind: string): { name: string; descriptor?: string } | undefined {
  if (!args) return undefined
  // Single string literal: "@Inject("foo")"
  const single = matchStringLiteral(args)
  if (single) return { name: single }
  // method = "foo(...)V"
  const methodMatch = args.match(/method\s*=\s*"([^"]+)"/)
  if (methodMatch) {
    const ref = methodMatch[1]
    const descStart = ref.indexOf('(')
    if (descStart >= 0) return { name: ref.slice(0, descStart), descriptor: ref.slice(descStart) }
    return { name: ref }
  }
  // value = "foo" or target = ...
  const valueMatch = args.match(/(?:value|target|name)\s*=\s*"([^"]+)"/)
  if (valueMatch) {
    const ref = valueMatch[1]
    const descStart = ref.indexOf('(')
    if (descStart >= 0) return { name: ref.slice(0, descStart), descriptor: ref.slice(descStart) }
    return { name: ref }
  }
  return undefined
}

function matchStringLiteral(text: string): string | undefined {
  const m = text.match(/"([^"]+)"/)
  return m ? m[1] : undefined
}

/**
 * Extract the target class FQCN from @Mixin's argument list. Supports:
 *   - String literal: @Mixin("com.foo.Bar")
 *   - Class literal: @Mixin(com.foo.Bar.class)
 *   - value= form: @Mixin(value = com.foo.Bar.class, priority = 1000)
 */
function extractMixinTargetClass(args: string): string | undefined {
  // String literal first
  const str = matchStringLiteral(args)
  if (str) return str
  // Class literal: dotted identifier followed by `.class`
  const classLit = args.match(/\b((?:[A-Za-z_][\w]*\.)+[A-Za-z_][\w$]*)\s*\.\s*class\b/)
  if (classLit) return classLit[1]
  return undefined
}

function collectMixinClassNames(config: Record<string, unknown>): string[] {
  const keys = ['mixins', 'client', 'server']
  const out: string[] = []
  for (const key of keys) {
    const value = config[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') out.push(item)
      }
    }
  }
  return out
}

function stripComments(content: string): string {
  // Replace block comments (incl. Javadoc) with spaces of equal length so offsets stay aligned.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
}

function buildLineIndex(content: string): number[] {
  // offset[i] = 1-indexed line of the character at content index i
  const out: number[] = []
  let line = 1
  for (let i = 0; i < content.length; i++) {
    out.push(line)
    if (content.charCodeAt(i) === 10) line++
  }
  out.push(line)
  return out
}

function toRelative(filePath: string, projectPath: string): string {
  const norm = filePath.replace(/\\/g, '/')
  const prefix = projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return norm.startsWith(prefix) ? norm.slice(prefix.length) : norm
}

function lookupFabricSymbolLocal(req: { className: string; memberName?: string; descriptor?: string; memberKind?: 'method' | 'field' | 'any' }): ReturnType<SymbolLookupFn> | null {
  // Default stub: nothing resolves. Tests can pass a custom symbolLookup.
  return null
}

function makeAwLookup(symbolLookup: SymbolLookupFn): (className: string) => { name?: string; methods?: { name: string; descriptor: string }[]; fields?: { name: string }[] } | null {
  return (className: string) => {
    const record = symbolLookup({ className })
    if (!record || !record.ok || !record.class) return null
    return { name: record.class.name, methods: record.class.methods, fields: record.class.fields }
  }
}

function defaultSymbolLookup(_req: { className: string; memberName?: string; descriptor?: string; memberKind?: 'method' | 'field' | 'any' }): FabricSymbolResultLike {
  return { ok: false, error: 'symbol index unavailable', methods: [], fields: [], suggestions: [], ambiguous: false }
}