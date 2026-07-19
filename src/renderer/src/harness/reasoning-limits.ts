/** Soft: kick next round when CoT rumination exceeds this (diag: 16k–75k truncations). */
export const MAX_REASONING_SOFT_CHARS = 6_000
/** Hard: abort stream if still only thinking past this with no tool_calls yet. */
export const MAX_REASONING_HARD_CHARS = 12_000

export const LONG_REASONING_KICK =
  '【系统】上一轮推理过长且反复自我否定（Wait/Hmm）。下一轮禁止长篇分析：一两句旁白后立即调用工具执行。'
