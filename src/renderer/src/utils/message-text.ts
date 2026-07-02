import type { DisplayMessage } from '../types/display-message'

export function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

export function messagePlainText(msg: DisplayMessage): string {
  if (msg.role === 'user') return msg.content.trim()

  if (msg.entries && msg.entries.length > 0) {
    return msg.entries
      .filter((e) => e.kind === 'text' || e.kind === 'reasoning')
      .map((e) => e.content ?? '')
      .join('\n')
      .trim() || msg.content.trim()
  }

  return msg.content.trim()
}

export function turnShareText(user?: DisplayMessage, assistant?: DisplayMessage): string {
  const parts: string[] = []
  if (user) {
    parts.push('### 用户', '', messagePlainText(user))
  }
  if (assistant) {
    if (parts.length > 0) parts.push('', '')
    parts.push('### AI', '', messagePlainText(assistant))
  }
  return parts.join('\n').trim()
}
