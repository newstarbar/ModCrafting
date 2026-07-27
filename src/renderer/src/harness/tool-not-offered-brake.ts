import type { ToolResult } from './tools.ts'

/** Same tool blocked this many consecutive rounds (or ≥ this many in one batch) → hard brake. */
export const MAX_SAME_TOOL_NOT_OFFERED = 3

const NOT_OFFERED_KINDS = new Set(['tool_not_offered', 'tool_not_allowed'])

export function isWhitelistReject(result: Pick<ToolResult, 'errorKind' | 'output' | 'error'>): boolean {
  if (result.errorKind && NOT_OFFERED_KINDS.has(result.errorKind)) return true
  const text = `${result.output || ''}\n${result.error || ''}`
  return /\[tool_not_offered\]|\[tool_not_allowed\]/.test(text)
}

/**
 * Update per-tool consecutive whitelist-reject streaks.
 * - Each round that rejects tool X increments X's streak by 1.
 * - A single round with ≥ MAX_SAME_TOOL_NOT_OFFERED rejects of X immediately brakes X.
 * - Tools not rejected this round have their streak cleared (not consecutive).
 * Returns tool names that have reached the brake threshold.
 */
export function updateNotOfferedStreak(
  streak: Map<string, number>,
  rejected: Iterable<Pick<ToolResult, 'toolName' | 'errorKind' | 'output' | 'error'>>
): string[] {
  const blockedCounts = new Map<string, number>()
  for (const r of rejected) {
    if (!isWhitelistReject(r)) continue
    const name = r.toolName || 'unknown'
    blockedCounts.set(name, (blockedCounts.get(name) || 0) + 1)
  }

  for (const name of [...streak.keys()]) {
    if (!blockedCounts.has(name)) streak.delete(name)
  }

  const braked: string[] = []
  for (const [name, count] of blockedCounts) {
    const next = (streak.get(name) || 0) + 1
    const value = count >= MAX_SAME_TOOL_NOT_OFFERED ? Math.max(next, MAX_SAME_TOOL_NOT_OFFERED) : next
    streak.set(name, value)
    if (value >= MAX_SAME_TOOL_NOT_OFFERED) braked.push(name)
  }
  return braked
}

export function formatNotOfferedBrakeInstruction(
  brakedTools: string[],
  allowedToolNames: string[]
): string {
  const banned = brakedTools.join(', ')
  const allowed = allowedToolNames.length ? allowedToolNames.join(', ') : '（无）'
  return (
    `【系统】工具 ${banned} 已连续被白名单拒绝 ≥${MAX_SAME_TOOL_NOT_OFFERED} 次，禁止再调用。` +
    `当前允许工具：${allowed}。请改用允许的工具，或向用户说明阶段/步骤限制。`
  )
}
