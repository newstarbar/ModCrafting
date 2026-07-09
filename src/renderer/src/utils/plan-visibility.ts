import type { ActivePlan, DisplayMessage } from '../types/display-message'

const HIDDEN_TURN_STATUSES = new Set(['completed', 'answered', 'error', 'cancelled'])

export function shouldShowPinnedPlan(
	activePlan: ActivePlan | null,
	messages: DisplayMessage[],
	planReady: boolean,
): boolean {
	if (!activePlan?.pinned) return false

	const anchor = messages.find((m) => m.id === activePlan.anchorMsgId)
	if (!anchor) return false

	if (planReady) return true

	if (anchor.isStreaming && !anchor.turnStatus) return true

	if (anchor.turnStatus && HIDDEN_TURN_STATUSES.has(anchor.turnStatus)) return false

	if (anchor.turnStatus === 'partial') return true

	if (activePlan.steps.some((s) => s.status === 'running' || s.status === 'pending')) {
		return true
	}

	return false
}
