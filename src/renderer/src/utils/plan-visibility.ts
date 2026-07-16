import type { ActivePlan, DisplayMessage } from '../types/display-message'

const HIDDEN_TURN_STATUSES = new Set(['completed', 'answered', 'error', 'cancelled', 'partial'])

export function shouldShowPinnedPlan(
	activePlan: ActivePlan | null,
	messages: DisplayMessage[],
	planReady: boolean,
): boolean {
	if (!activePlan?.pinned) return false

	const anchor = messages.find((m) => m.id === activePlan.anchorMsgId)
	if (!anchor) return false

	// Plan-only mode: keep pinned until user starts execute.
	if (planReady) return true

	// While the turn is still streaming, keep the live plan visible.
	if (anchor.isStreaming && !anchor.turnStatus) return true

	// After the turn ends (partial/error/completed/...), hide the floating overlay.
	// Incomplete progress remains on the message via embeddedPlan for「继续」恢复.
	if (anchor.turnStatus && HIDDEN_TURN_STATUSES.has(anchor.turnStatus)) return false

	if (activePlan.steps.some((s) => s.status === 'running' || s.status === 'pending' || s.status === 'error')) {
		return true
	}

	return false
}
