/**
 * Parse Gradle / Java compiler errors from build output into structured entries.
 */

export interface GradleErrorEntry {
  file?: string
  line?: number
  column?: number
  message: string
  raw: string
}

const JAVA_ERROR_RE = /^(.*\.java):(\d+):\s*error:\s*(.+)$/gm
const GRADLE_FILE_RE = /^\s*>?\s*([^:\s]+\.java):(\d+):\s*(.+)$/gm
const ERROR_LINE_RE = /error:\s*(.+)/i
const BUILD_FAILED_RE = /BUILD FAILED/i

export function parseGradleErrors(log: string, maxEntries = 12): GradleErrorEntry[] {
  const entries: GradleErrorEntry[] = []
  const seen = new Set<string>()

  const push = (entry: GradleErrorEntry) => {
    const key = `${entry.file || ''}:${entry.line || ''}:${entry.message}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }

  let match: RegExpExecArray | null
  JAVA_ERROR_RE.lastIndex = 0
  while ((match = JAVA_ERROR_RE.exec(log)) !== null && entries.length < maxEntries) {
    push({
      file: match[1].replace(/\\/g, '/'),
      line: Number(match[2]),
      message: match[3].trim(),
      raw: match[0]
    })
  }

  GRADLE_FILE_RE.lastIndex = 0
  while ((match = GRADLE_FILE_RE.exec(log)) !== null && entries.length < maxEntries) {
    push({
      file: match[1].replace(/\\/g, '/'),
      line: Number(match[2]),
      message: match[3].trim(),
      raw: match[0]
    })
  }

  if (entries.length === 0 && BUILD_FAILED_RE.test(log)) {
    const lines = log.split('\n').filter((l) => ERROR_LINE_RE.test(l) || /FAILED|Exception|Caused by:/i.test(l))
    for (const line of lines.slice(-8)) {
      const msg = line.trim()
      if (!msg || seen.has(msg)) continue
      seen.add(msg)
      push({ message: msg, raw: msg })
      if (entries.length >= maxEntries) break
    }
  }

  return entries
}

export function formatGradleErrorsForPrompt(log: string, maxEntries = 8): string {
  const entries = parseGradleErrors(log, maxEntries)
  if (entries.length === 0) {
    return log.trim().split('\n').slice(-40).join('\n')
  }
  const lines = entries.map((e) => {
    const loc = e.file ? `${e.file}${e.line != null ? `:${e.line}` : ''}` : '(unknown)'
    return `- ${loc} — ${e.message}`
  })
  return `结构化编译错误（${entries.length} 条）：\n${lines.join('\n')}`
}

export function gradleErrorSignature(log: string): string {
  const entries = parseGradleErrors(log, 6)
  if (entries.length === 0) {
    return log.trim().split('\n').slice(-5).join('|').slice(0, 400)
  }
  return entries.map((e) => `${e.file}:${e.line}:${e.message}`).join('|').slice(0, 400)
}
