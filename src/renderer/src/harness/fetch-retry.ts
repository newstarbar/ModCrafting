/** Shared helpers for retrying transient fetch / API failures during long agent runs. */

export const MAX_FETCH_RETRIES = 3

const RETRYABLE_PATTERN =
  /failed to fetch|networkerror|network error|load failed|econnreset|etimedout|timeout|aborted.*fetch|502|503|504|429|rate limit/i

export function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERN.test(msg)
}

/**
 * A thinking-mode provider rejecting the conversation continuation because of the
 * `reasoning_content` field. Re-sending the same payload cannot help, and switching
 * to a fallback model discards the reasoning history just as hard, so this is
 * deliberately NOT part of RETRYABLE_PATTERN.
 */
export function isReasoningContinuityError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /reasoning_content/i.test(msg) && /invalid_request_error|api error 400|bad request/i.test(msg)
}

export function fetchRetryDelayMs(attempt: number): number {
  return 2000 * (attempt + 1)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
