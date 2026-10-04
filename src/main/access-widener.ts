/**
 * Access Widener (AW) parser and suppression rules for the fast-compile path.
 *
 * Background: bare javac sees Yarn-named class files where members declared
 * `accessible` by the project's `.accesswidener` are still private (Loom applies
 * widening during the remap step, not at compile time). Without suppression,
 * javac reports these as spurious "cannot find symbol" errors and the model
 * wastes repair rounds chasing them.
 *
 * Format reference: https://fabricmc.net/wiki/tutorial:accesswideners
 *   accessWidener v1 named
 *   accessible   class   com/example/MyClass
 *   accessible   field   com/example/MyClass secretField
 *   accessible   method  com/example/MyClass someMethod (...)V
 *   mutable      field   com/example/MyField I
 *   extendable   class   com/example/MyExtensible
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type AwOp = 'accessible' | 'mutable' | 'extendable'
export type AwTarget = 'class' | 'field' | 'method'

export interface AwEntry {
  op: AwOp
  target: AwTarget
  /** Dotted, fully-qualified class name (com/example/Cls -> com.example.Cls). */
  className: string
  /** Member name, or undefined for class-level entries. */
  memberName?: string
  /** Method descriptor like "(I)V"; undefined for field/class entries. */
  descriptor?: string
  /** File the entry was read from (for diagnostics). */
  source: string
  /** Line within source file (1-indexed). */
  line: number
}

const AW_FILE_RE = /\.accesswidener$/i

/** Walks src/{main,client,server} and root for any *.accesswidener file. */
export function discoverAccessWidenerFiles(projectPath: string): string[] {
  const roots = [projectPath, 'src/main', 'src/client', 'src/server']
  const found: string[] = []
  for (const rel of roots) {
    const abs = path.join(projectPath, rel)
    if (!existsSync(abs)) continue
    walkAw(abs, found, projectPath)
  }
  return found
}

function walkAw(dir: string, out: string[], _projectPath: string): void {
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[] } catch { return }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walkAw(full, out, _projectPath); continue }
    if (entry.isFile() && AW_FILE_RE.test(entry.name)) out.push(full)
  }
}

/** Parse a single .accesswidener file. Header lines are ignored. */
export function parseAccessWidener(content: string, source = '<string>'): AwEntry[] {
  const out: AwEntry[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    const tokens = raw.split(/\s+/)
    // Header: "accessWidener vX <format>" — 3 tokens, op is not a real op.
    if (tokens[0] === 'accessWidener') continue
    if (tokens.length < 3) continue
    const [opToken, targetToken, owner, member, descriptor] = tokens
    const op = normalizeOp(opToken)
    const target = normalizeTarget(targetToken)
    if (!op || !target) continue
    if (!owner) continue
    const entry: AwEntry = {
      op, target,
      className: owner.replace(/\//g, '.'),
      source, line: i + 1
    }
    if (target === 'method' || target === 'field') {
      if (!member) continue
      entry.memberName = member
      if (descriptor) entry.descriptor = descriptor
    }
    out.push(entry)
  }
  return out
}

function normalizeOp(value: string): AwOp | null {
  if (value === 'accessible' || value === 'mutable' || value === 'extendable') return value
  return null
}

function normalizeTarget(value: string): AwTarget | null {
  if (value === 'class' || value === 'field' || value === 'method') return value
  return null
}

/** Load + parse every AW file under projectPath. Errors are swallowed per-file. */
export function loadAccessWidenerEntries(projectPath: string): AwEntry[] {
  const files = discoverAccessWidenerFiles(projectPath)
  const out: AwEntry[] = []
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8')
      out.push(...parseAccessWidener(text, file))
    } catch { /* skip unreadable AW */ }
  }
  return out
}

/**
 * True when `className` (+ optional member) is widened by some AW entry.
 * Used to suppress javac's spurious "cannot find symbol" on AW-widened members.
 *
 * Matching rules:
 *   - class-level entry matches any method/field of that class
 *   - method entry matches when both member name and descriptor match (descriptor optional)
 *   - field entry matches when member name matches
 */
export function isAwWidened(entries: AwEntry[], className: string, memberName?: string, descriptor?: string): boolean {
  const cn = className.replace(/\//g, '.')
  for (const entry of entries) {
    if (entry.className !== cn) continue
    if (entry.target === 'class') return true
    if (!memberName) continue
    if (entry.memberName !== memberName) continue
    if (entry.target === 'method') {
      if (!entry.descriptor) return true
      if (!descriptor) return true
      return entry.descriptor === descriptor
    }
    if (entry.target === 'field') return true
  }
  return false
}

/**
 * Per-entry validation that AW references actually exist on the symbol index.
 * Catches the common "I typo'd a method name in the AW" failure mode that Loom
 * reports with very unhelpful "Could not widen X" messages.
 */
export interface AwValidationIssue {
  entry: AwEntry
  kind: 'class_not_found' | 'member_not_found'
  hint: string
}

export interface SymbolLookupFn {
  (className: string): { name?: string; methods?: { name: string; descriptor: string }[]; fields?: { name: string }[] } | null | undefined
}

export function validateAccessWidenerEntries(entries: AwEntry[], lookup: SymbolLookupFn): AwValidationIssue[] {
  const issues: AwValidationIssue[] = []
  // Cache class lookups by FQCN so we don't re-resolve the same class repeatedly.
  const classCache = new Map<string, AwValidationIssue[]>()
  for (const entry of entries) {
    let record = classCache.get(entry.className)
    if (record === undefined) {
      const result = lookup(entry.className)
      if (!result || !result.name) {
        const issue: AwValidationIssue = {
          entry, kind: 'class_not_found',
          hint: `AW 引用了不存在的类 ${entry.className}`
        }
        record = [issue]
      } else {
        record = []
      }
      classCache.set(entry.className, record)
    }
    if (record.length > 0) { issues.push(...record); continue }
    if (entry.target === 'class') continue
    if (!entry.memberName) continue
    const symbol = classCache.get(entry.className) === undefined ? null : null
    void symbol
    const result = lookup(entry.className)
    if (!result) continue
    if (entry.target === 'method') {
      const members = result.methods || []
      const hit = members.some((m) => m.name === entry.memberName && (!entry.descriptor || !m.descriptor || m.descriptor === entry.descriptor))
      if (!hit) issues.push({
        entry, kind: 'member_not_found',
        hint: `AW 引用了不存在的方法 ${entry.className}#${entry.memberName}${entry.descriptor || ''}`
      })
    } else if (entry.target === 'field') {
      const fields = result.fields || []
      if (!fields.some((f) => f.name === entry.memberName)) issues.push({
        entry, kind: 'member_not_found',
        hint: `AW 引用了不存在的字段 ${entry.className}#${entry.memberName}`
      })
    }
  }
  return issues
}