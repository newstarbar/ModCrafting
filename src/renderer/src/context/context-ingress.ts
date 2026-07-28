/** Aggregated tag describing the context type, for chip-based UI display. */
export type ContextTagType = 'crash' | 'code-explain' | 'build-error' | 'shortcut' | 'runtime-error' | 'quick-create' | 'generic'

export interface ContextTag {
  type: ContextTagType
  label: string
}

/** Unified payload for anything injected into the chat composer. */
export type ContextPayload =
  | { kind: 'text'; text: string; source?: string; tag?: ContextTag }
  | { kind: 'image'; path: string; mimeType: string; previewUrl?: string; name?: string; source?: string }
  | { kind: 'file'; path: string; name: string; source?: string }

export type ComposerAttachment =
  | { id: string; kind: 'image'; path: string; mimeType: string; previewUrl?: string; name?: string }
  | { id: string; kind: 'file'; path: string; name: string }

export type MessageAttachment = {
  kind: 'image' | 'file'
  path: string
  mimeType?: string
  name?: string
}

export function isImageMime(mime: string | undefined | null): boolean {
  return Boolean(mime && mime.toLowerCase().startsWith('image/'))
}

export function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  return 'application/octet-stream'
}

export function isImagePath(filePath: string): boolean {
  return isImageMime(mimeFromPath(filePath))
}

export function payloadToAttachment(payload: ContextPayload, id: string): ComposerAttachment | null {
  if (payload.kind === 'image') {
    return {
      id,
      kind: 'image',
      path: payload.path,
      mimeType: payload.mimeType || mimeFromPath(payload.path),
      previewUrl: payload.previewUrl,
      name: payload.name
    }
  }
  if (payload.kind === 'file') {
    return { id, kind: 'file', path: payload.path, name: payload.name }
  }
  return null
}

export function attachmentToMessageAttachment(a: ComposerAttachment): MessageAttachment {
  if (a.kind === 'image') {
    return { kind: 'image', path: a.path, mimeType: a.mimeType, name: a.name }
  }
  return { kind: 'file', path: a.path, name: a.name }
}

export function hasImageAttachment(attachments: Array<{ kind: string }> | undefined | null): boolean {
  return Boolean(attachments?.some((a) => a.kind === 'image'))
}

/** Append file paths into the user text so the agent can read them with tools. */
export function appendFilePathsToText(text: string, attachments: MessageAttachment[]): string {
  const files = attachments.filter((a) => a.kind === 'file')
  if (files.length === 0) return text
  const block = files.map((f) => `- ${f.path}`).join('\n')
  const trimmed = text.trimEnd()
  return trimmed ? `${trimmed}\n\n附件路径：\n${block}` : `附件路径：\n${block}`
}

export function newAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `att-${crypto.randomUUID()}`
  }
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}
