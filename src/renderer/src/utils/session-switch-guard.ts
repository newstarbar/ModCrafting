/**
 * Session-switch guards: keep turn events and snapshot restore consistent
 * when the user switches chat sessions while an Agent turn is running.
 */

/** Apply turn UI events only when the event's turn generation still matches. */
export function shouldApplyTurnEvent(eventGeneration: number, currentGeneration: number): boolean {
  return eventGeneration === currentGeneration
}

/**
 * Force Controller.restoreSnapshot when crossing sessions.
 * Same-session persist cycles should keep the length guard instead.
 */
export function shouldForceRestoreSnapshot(
  previousSessionId: string | null,
  nextSessionId: string | null
): boolean {
  if (!nextSessionId) return false
  if (!previousSessionId) return true
  return previousSessionId !== nextSessionId
}

/** True when leaving a session that may still have an in-flight turn. */
export function shouldCancelTurnOnSessionLeave(
  previousSessionId: string | null,
  nextSessionId: string | null
): boolean {
  return Boolean(previousSessionId && previousSessionId !== nextSessionId)
}
