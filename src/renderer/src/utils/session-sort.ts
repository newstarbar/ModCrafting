import type { ChatSession } from '../types/chat'

export function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
	return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getMostRecentSessionId(sessions: ChatSession[]): string | null {
	if (sessions.length === 0) return null
	return sortSessionsByUpdatedAt(sessions)[0]?.id ?? null
}
