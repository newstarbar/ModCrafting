/** Shared helpers for retrying transient fetch / API failures during long agent runs. */

export const MAX_FETCH_RETRIES = 3

const RETRYABLE_PATTERN =
  /failed to fetch|networkerror|network error|load failed|econnreset|etimedout|timeout|aborted.*fetch|502|503|504|429|rate limit/i

export function isRetryableFetchError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERN.test(msg)
}

export function fetchRetryDelayMs(attempt: number): number {
  return 2000 * (attempt + 1)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
