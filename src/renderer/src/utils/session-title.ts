const DEFAULT_SESSION_NAME_RE = /^会话 \d+$/

export function isDefaultSessionName(name: string): boolean {
  return DEFAULT_SESSION_NAME_RE.test(name.trim())
}

/** Short title from the first user message (single line, trimmed, max length). */
export function sessionTitleFromMessage(text: string, maxLen = 30): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, maxLen)}...`
}

export function nextDefaultSessionName(sessionCount: number): string {
  return `会话 ${sessionCount + 1}`
}
