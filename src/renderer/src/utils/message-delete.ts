import type { DisplayMessage } from '../types/display-message'

export function removeMessageFromDisplay(
	messages: DisplayMessage[],
	msgId: string,
): { next: DisplayMessage[]; removedIds: string[] } {
	const idx = messages.findIndex((m) => m.id === msgId)
	if (idx < 0) return { next: messages, removedIds: [] }

	const msg = messages[idx]
	if (msg.role === 'user') {
		const paired = messages[idx + 1]
		if (paired?.role === 'assistant') {
			return {
				next: [...messages.slice(0, idx), ...messages.slice(idx + 2)],
				removedIds: [msg.id, paired.id],
			}
		}
		return {
			next: [...messages.slice(0, idx), ...messages.slice(idx + 1)],
			removedIds: [msg.id],
		}
	}

	return {
		next: [...messages.slice(0, idx), ...messages.slice(idx + 1)],
		removedIds: [msg.id],
	}
}
