export interface UsageStats {
  sessionTokens: number
  turnTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  turnCacheHitTokens: number
  turnCacheMissTokens: number
  turns: number
  contextPercent: number
  lastPromptTokens: number
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
  lastPromptTokens: 0,
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

export function contextWindowLimit(model?: string): number {
  const m = (model || '').toLowerCase()
  if (/1m|1000k|1048k/.test(m)) return 1_000_000
  // DeepSeek V4 系列（flash / pro）为 1M 上下文
  if (/deepseek-?v4|v4-flash|v4-pro/.test(m)) return 1_000_000
  if (/256/.test(m)) return 256_000
  if (/(^|[^0-9])32k?([^0-9]|$)/.test(m)) return 32_000
  if (/(^|[^0-9])64k?([^0-9]|$)/.test(m)) return 64_000
  // DeepSeek V3/R1 及多数现代模型默认 128K 上下文
  return 128_000
}

export function formatContextLimit(limit: number): string {
  if (limit >= 1000) return `${Math.round(limit / 1000)}k`
  return String(limit)
}

export function contextPercentFromPrompt(promptTokens: number, model?: string): number {
  if (promptTokens <= 0) return 0
  const limit = contextWindowLimit(model)
  return Math.min(100, Math.round((promptTokens / limit) * 100))
}

export function formatTokensK(n: number): string {
  if (n <= 0) return '—'
  if (n < 1000) return String(n)
  const k = n / 1000
  return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`
}

export function cacheHitRate(hit: number, miss: number): number | null {
  const total = hit + miss
  if (total <= 0) return null
  return (hit / total) * 100
}

/** Prefer turn-level cache stats; fall back to session-level. */
export function effectiveCacheHitRate(
  turnHit: number,
  turnMiss: number,
  sessionHit: number,
  sessionMiss: number
): number | null {
  return cacheHitRate(turnHit, turnMiss) ?? cacheHitRate(sessionHit, sessionMiss)
}

export function cacheHitMissForDisplay(
  turnHit: number,
  turnMiss: number,
  sessionHit: number,
  sessionMiss: number
): { hit: number; miss: number } {
  if (turnHit + turnMiss > 0) return { hit: turnHit, miss: turnMiss }
  return { hit: sessionHit, miss: sessionMiss }
}
