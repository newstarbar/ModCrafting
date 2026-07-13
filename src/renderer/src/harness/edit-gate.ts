/** Basic syntax gates before accepting file writes (ACI-style). */

export interface EditGateResult {
  ok: boolean
  reason?: string
}

export function validateJavaBraceBalance(content: string): EditGateResult {
  let braces = 0
  let parens = 0
  let inString = false
  let inChar = false
  let escape = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (inChar) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === "'") inChar = false
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "'") {
      inChar = true
      continue
    }

    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '(') parens++
    else if (ch === ')') parens--

    if (braces < 0) return { ok: false, reason: '花括号不匹配：多余的 }' }
    if (parens < 0) return { ok: false, reason: '圆括号不匹配：多余的 )' }
  }

  if (inString) return { ok: false, reason: '未闭合的字符串字面量' }
  if (inChar) return { ok: false, reason: '未闭合的字符字面量' }
  if (braces !== 0) return { ok: false, reason: `花括号不匹配：差值 ${braces}` }
  if (parens !== 0) return { ok: false, reason: `圆括号不匹配：差值 ${parens}` }
  return { ok: true }
}

export function validateJsonSyntax(content: string): EditGateResult {
  try {
    JSON.parse(content)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `JSON 语法错误：${err instanceof Error ? err.message : String(err)}` }
  }
}

export function validateFileEditGate(relPath: string, content: string): EditGateResult {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase()
  if (normalized.endsWith('.java')) return validateJavaBraceBalance(content)
  if (normalized.endsWith('.json')) return validateJsonSyntax(content)
  return { ok: true }
}
