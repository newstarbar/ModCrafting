import type { ChatContentPart } from '../harness/chat-message.ts'
import type { MessageAttachment } from '../context/context-ingress.ts'
import { appendFilePathsToText } from '../context/context-ingress.ts'

/**
 * Build OpenAI-compatible user content from text + attachments.
 * `imageDataUrls` maps attachment.path → data URL (already loaded).
 */
export function buildUserContent(
  text: string,
  attachments: MessageAttachment[],
  imageDataUrls: Map<string, string>
): string | ChatContentPart[] {
  const fullText = appendFilePathsToText(text, attachments)
  const images = attachments.filter((a) => a.kind === 'image')
  if (images.length === 0) return fullText

  const parts: ChatContentPart[] = []
  if (fullText.trim()) {
    parts.push({ type: 'text', text: fullText })
  }
  for (const img of images) {
    const url = imageDataUrls.get(img.path)
    if (!url) continue
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (parts.length === 0) return fullText || ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

export function contentPartsAsClassifyText(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
