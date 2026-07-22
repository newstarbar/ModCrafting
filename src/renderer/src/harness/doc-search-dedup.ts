/** Normalize / compare fabric_docs_search keywords to stop near-duplicate repair loops. */

const DOC_SEARCH_NOISE = new Set([
  'parameters',
  'parameter',
  'params',
  'param',
  'signature',
  'signatures',
  'overload',
  'overloads',
  'method',
  'methods',
  'class',
  'api',
  'yarn',
  'mapping',
  'mappings',
  'minecraft',
  'fabric',
  'mc',
  'version',
  'how',
  'use',
  'using',
  '正确',
  '用法',
  '签名',
  '参数'
])

/** Fingerprint for similarity: significant identifier tokens, sorted. */
export function normalizeDocSearchFingerprint(keyword: string): string {
  const tokens = String(keyword || '')
    .match(/[A-Za-z\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]{1,}/g)
    ?.map((t) => t.toLowerCase())
    .filter((t) => t.length > 1 && !DOC_SEARCH_NOISE.has(t) && !/^\d+\.\d+/.test(t))
  if (!tokens?.length) return ''
  return [...new Set(tokens)].sort().join(' ')
}

export function isSimilarDocSearchFingerprint(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const ta = new Set(a.split(' ').filter(Boolean))
  const tb = new Set(b.split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return false
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  if (inter === 0) return false
  // Subset: "drawcontext drawtexture" ⊂ "... identifier"
  let aInB = true
  for (const t of ta) if (!tb.has(t)) { aInB = false; break }
  let bInA = true
  for (const t of tb) if (!ta.has(t)) { bInA = false; break }
  if (aInB || bInA) return true
  const union = ta.size + tb.size - inter
  return inter / union >= 0.6
}

export function hasSimilarDocSearch(
  seen: Iterable<string>,
  fingerprint: string
): boolean {
  if (!fingerprint) return false
  for (const s of seen) {
    if (isSimilarDocSearchFingerprint(s, fingerprint)) return true
  }
  return false
}

/** Pull API method names from javac / Gradle compile errors for repair prompts. */
export function extractCompileApiHints(output: string): string[] {
  const hints: string[] = []
  const patterns = [
    /对于\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /cannot find symbol[\s\S]{0,80}?symbol:\s*method\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    /找不到符号[\s\S]{0,80}?符号:\s*方法\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /找不到合适的方法[\s\S]{0,40}?\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /错误:\s*找不到符号[\s\S]{0,60}?\.([A-Za-z_][A-Za-z0-9_]*)\(/g
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(output)) !== null) {
      const name = m[1]
      if (name && !hints.includes(name)) hints.push(name)
    }
  }
  return hints.slice(0, 6)
}
