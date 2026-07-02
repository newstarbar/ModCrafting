export interface UsageStats {
  sessionTokens: number
  turnTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  turnCacheHitTokens: number
  turnCacheMissTokens: number
  turns: number
  contextPercent: number
  cost: number
}

export const EMPTY_USAGE: UsageStats = {
  sessionTokens: 0,
  turnTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  turnCacheHitTokens: 0,
  turnCacheMissTokens: 0,
  turns: 0,
  contextPercent: 0,
  cost: 0
}

/** Rough CNY estimate (DeepSeek-style: cached input cheaper, output pricier). */
export function estimateCostDelta(
  promptTokens: number,
  completionTokens: number,
  cacheHit: number,
  cacheMiss: number
): number {
  const hit = cacheHit
  const miss = cacheMiss > 0 ? cacheMiss : Math.max(0, promptTokens - hit)
  const inputCost = (miss * 0.27 + hit * 0.07) / 1_000_000
  const outputCost = completionTokens * 1.10 / 1_000_000
  return inputCost + outputCost
}

export function contextPercentFromPrompt(promptTokens: number, model?: string): number {
  if (promptTokens <= 0) return 0
  const limit = /128|256/i.test(model || '') ? 128000 : 64000
  return Math.min(100, Math.round((promptTokens / limit) * 100))
}

export function cacheHitRate(hit: number, miss: number): number | null {
  const total = hit + miss
  if (total <= 0) return null
  return (hit / total) * 100
}
