/** Plan-phase gates: exploration cap → force submit_plan (no prose-only exit). */

export const MAX_READONLY_ROUNDS = 3
export const MAX_PLAN_OFFERED_REJECT_ROUNDS = 2
/** Text-only replies after lock before giving up (controller may still format-retry). */
export const MAX_PLAN_SUBMIT_NUDGE_ROUNDS = 3

export const PLAN_EXPLORATION_LOCK_KICK =
  '【系统】计划阶段已探索足够。list_directory/read_file/grep 已锁定。' +
  '请立即调用 submit_plan 提交结构化计划；信息仍不足时用 ask_clarification（须带 options）。' +
  '不要再尝试列出目录或搜索源码。'

export const PLAN_SUBMIT_NUDGE =
  '【系统】计划阶段禁止仅用文字结束。请立即调用 submit_plan 提交结构化计划' +
  '（每步含 kind、description、targetPath、evidence）；信息不足时用 ask_clarification（须带 options）。' +
  '不要再分析或复述代码。'

export function shouldNudgePlanSubmit(nudgeRoundsCompleted: number): boolean {
  return nudgeRoundsCompleted < MAX_PLAN_SUBMIT_NUDGE_ROUNDS
}

/** After exploration lock, only allow plan-closing tools. */
export function isPlanPostLockTool(name: string): boolean {
  return name === 'submit_plan' || name === 'ask_clarification'
}
