import type { PlanTracker } from './plan-tracker.ts'

export type TurnIntent = 'chat' | 'resume' | 'develop' | 'plan_only'

export type ComposerMode = 'agent' | 'plan' | 'ask'

export interface TurnIntentContext {
  phase: 'plan' | 'execute'
  planTracker: PlanTracker | null
  hasProject: boolean
  composerMode: ComposerMode
  /** Plan text accepted/parsed but not yet attached as planTracker (e.g. after plan_failed). */
  hasPlanCandidate?: boolean
}

const RESUME_PATTERN = /^(继续|接着|往下|continue|执行计划|开始执行|执行)[\s!！。.?？~，,]*$/i
const GREETING_PATTERN = /^(你好|您好|嗨|hello|hi|hey|在吗|谢谢|感谢|好的|ok|okay|再见|拜拜)[\s!！。.?？~，,]*$/i
const QA_PATTERN = /^(什么是|为什么|怎么|如何|能否|是否|解释|说明|什么意思|这段|请问)/i
const DEV_PATTERN = /创建|实现|开发|添加|修改|修复|删除|重构|构建|写一个|制作|帮我.{0,8}(做|改|修|加)|生成.{0,8}(模组|mod|类|文件|物品|功能)|\b(create|implement|add|modify|fix|delete|refactor|build)\b/i
const FEATURE_PATTERN = /可以进行|能够|支持|二段跳|配方|物品|方块|mixin|功能|效果|技能/i
const PLAN_ADJUST_PATTERN = /调整计划|修改计划|重新计划|重做计划/i

export function isResumeInput(input: string): boolean {
  return RESUME_PATTERN.test(input.trim())
}

export function isPlanAdjustInput(input: string): boolean {
  return PLAN_ADJUST_PATTERN.test(input.trim())
}

function heuristicChat(input: string): boolean {
  const trimmed = input.trim()
  if (GREETING_PATTERN.test(trimmed)) return true
  if (QA_PATTERN.test(trimmed)) return true
  if ((trimmed.endsWith('?') || trimmed.endsWith('？')) && trimmed.length < 120) return true
  return false
}

function heuristicDevelop(input: string, hasProject: boolean): boolean {
  const trimmed = input.trim()
  if (DEV_PATTERN.test(trimmed)) return true
  if (FEATURE_PATTERN.test(trimmed)) return true
  if (hasProject && trimmed.length >= 4 && !heuristicChat(input)) return true
  return false
}

const CODE_EXPLAIN_PATTERN = /---\s*代码解释\s*---/i

export function isCodeExplainInput(input: string): boolean {
  return CODE_EXPLAIN_PATTERN.test(input)
}

export function resolveTurnIntent(input: string, ctx: TurnIntentContext): TurnIntent {
  const trimmed = input.trim()

  if (isCodeExplainInput(trimmed)) {
    return 'chat'
  }

  if (ctx.composerMode === 'ask') {
    return 'chat'
  }

  const hasIncompletePlan = Boolean(ctx.planTracker && !ctx.planTracker.allDone())
  const hasReadyPlan = Boolean(ctx.planTracker && ctx.planTracker.steps.length > 0 && !ctx.planTracker.allDone())
  const canResumePlan = hasIncompletePlan || Boolean(ctx.hasPlanCandidate)

  if (isResumeInput(trimmed) && (ctx.phase === 'execute' || canResumePlan)) {
    return 'resume'
  }

  if (ctx.composerMode === 'plan') {
    if (hasReadyPlan && !isPlanAdjustInput(trimmed) && !isResumeInput(trimmed)) {
      return 'plan_only'
    }
    if (isPlanAdjustInput(trimmed) || ctx.phase === 'plan' || !ctx.planTracker) {
      return 'plan_only'
    }
    if (isResumeInput(trimmed)) {
      return 'resume'
    }
    return 'plan_only'
  }

  if (ctx.composerMode === 'agent') {
    // Only resume if user explicitly says "continue" or similar
    if (canResumePlan && isResumeInput(trimmed)) {
      return 'resume'
    }
    // Agent mode is capable of acting, but questions/explanations remain read-only.
    // Only an explicit mutation signal enters the plan -> execute workflow.
    if (heuristicChat(trimmed)) return 'chat'
    if (heuristicDevelop(trimmed, false)) return 'develop'
    return 'chat'
  }

  if (heuristicChat(trimmed)) return 'chat'
  if (heuristicDevelop(trimmed, ctx.hasProject)) return 'develop'
  return ctx.hasProject ? 'develop' : 'chat'
}

export function buildSessionGoalBlock(sessionGoal: string): string {
  const goal = sessionGoal.trim()
  return `## 当前会话目标\n${goal || '（未设置）'}\n本轮用户消息应服务于上述目标；若与目标无关，先简短确认再行动。`
}
