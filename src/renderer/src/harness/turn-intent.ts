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

/** Crash reports, Gradle failures, stack traces — should drive repair, not chat. */
const ERROR_REPORT_PATTERN =
  /Crash Report|----\s*Minecraft Crash Report\s*----|Exception in thread|java\.lang\.\w*Exception|at\s+knot\/\/|BUILD FAILED|Compilation failed|\.java:\d+|error:\s|Caused by:|什么都没改|崩溃报告|编译错误|构建失败/i

export function isResumeInput(input: string): boolean {
  return RESUME_PATTERN.test(input.trim())
}

export function isPlanAdjustInput(input: string): boolean {
  return PLAN_ADJUST_PATTERN.test(input.trim())
}

export function isErrorReportInput(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  if (ERROR_REPORT_PATTERN.test(trimmed)) return true
  // Multi-line stack-ish dumps without the exact Crash Report header
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length >= 4) {
    const stackish = lines.filter((l) => /^\s*at\s+\S+/.test(l) || /Exception|Error/.test(l)).length
    if (stackish >= 2) return true
  }
  return false
}

/** User says the previous "fix" did not work — keep as sticky acceptance criteria. */
const USER_SYMPTOM_PATTERN =
  /还是|仍然|依旧|又|模糊|花屏|报错|不对|不行|没用|无效|失败|没有[看见反应效果]|看不见|不显示|不正确|崩溃|卡死|黑屏|闪退|键名|翻译键|预览|乱码|错位|穿模|冲突|wrong\s*thread|exception|blur|glitch|broken|still\s|doesn't\swork|does\snot\swork/i

/** User confirms the symptom is gone. */
const SYMPTOM_RESOLVED_PATTERN =
  /^(好了|可以了|解决了|修好了|没问题了|正常了|通过了|ok了|已解决|已修复)[\s!！。.?？~]*$/i

export function isUserSymptomFeedback(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 800) return false
  if (isResumeInput(trimmed)) return false
  if (SYMPTOM_RESOLVED_PATTERN.test(trimmed)) return false
  if (isErrorReportInput(trimmed)) return true
  return USER_SYMPTOM_PATTERN.test(trimmed)
}

export function isSymptomResolvedFeedback(input: string): boolean {
  return SYMPTOM_RESOLVED_PATTERN.test(input.trim())
}

export function buildUserSymptomBlock(symptom: string | null | undefined): string {
  const text = (symptom || '').trim()
  if (!text) return ''
  return (
    `【用户待验证症状】${text.slice(0, 400)}\n` +
    `硬约束：trigger_build runClient 出现 MC_PHASE:ready 仅表示游戏启动成功，不代表该症状已修复。` +
    `ready 后必须调用 mc_inspect 或 mc_screenshot（必要时 mc_inventory / mc_world / mc_command）做客观校验。` +
    `写码步骤必须针对该症状做可验证修改（禁止只加注释/空改）；若 build 全 UP-TO-DATE，说明改动未进入编译，须核对路径（main/client）与 edit_file 是否落盘。` +
    `完成后用一两句说明改了哪一处，由用户确认是否解决。`
  )
}

/** Keep recent user feedback + short assistant notes when starting a follow-up task. */
export function buildCrossTurnDiagnosisRetain(args: {
  system?: { role: 'system'; content: string; origin?: string }
  messages: Array<{ role: string; content?: string; origin?: string }>
  taskId: string
  maxPriorUsers?: number
  maxAssistantNotes?: number
}): Array<{ role: string; content: string; origin?: string; taskId?: string }> {
  const maxUsers = args.maxPriorUsers ?? 5
  const maxAssistants = args.maxAssistantNotes ?? 2
  const priorUsers = args.messages
    .filter((m) => m.role === 'user' && m.origin !== 'harness')
    .map((m) => (m.content || '').trim())
    .filter(Boolean)
    .slice(-maxUsers)
  const currentUser = [...args.messages].reverse().find((m) => m.role === 'user' && m.origin !== 'harness')
  const assistantNotes = args.messages
    .filter((m) => m.role === 'assistant' && (m.content || '').trim().length > 20)
    .map((m) => (m.content || '').trim().slice(0, 1200))
    .slice(-maxAssistants)

  const out: Array<{ role: string; content: string; origin?: string; taskId?: string }> = []
  if (args.system) {
    out.push({ role: 'system', content: args.system.content, origin: 'harness' })
  }
  if (priorUsers.length > 0) {
    out.push({
      role: 'user',
      origin: 'harness',
      content:
        `【跨轮诊断摘要】用户近期反馈（必须保留，禁止遗忘）：\n` +
        priorUsers.map((s, i) => `${i + 1}. ${s.slice(0, 240)}`).join('\n') +
        `\n请针对最新用户消息修复；不要重复已尝试且无效的方案。`
    })
  }
  for (const note of assistantNotes) {
    out.push({ role: 'assistant', content: note, origin: 'assistant', taskId: args.taskId })
  }
  if (currentUser) {
    out.push({
      role: 'user',
      content: currentUser.content || '',
      origin: 'user',
      taskId: args.taskId
    })
  }
  return out
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

  // Error/crash dumps should resume or re-enter develop, never silent chat.
  if (isErrorReportInput(trimmed)) {
    if (ctx.phase === 'execute' || canResumePlan) return 'resume'
    return 'develop'
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
    if (heuristicDevelop(trimmed, ctx.hasProject)) return 'develop'
    return ctx.hasProject ? 'develop' : 'chat'
  }

  if (heuristicChat(trimmed)) return 'chat'
  if (heuristicDevelop(trimmed, ctx.hasProject)) return 'develop'
  return ctx.hasProject ? 'develop' : 'chat'
}

export function buildSessionGoalBlock(sessionGoal: string): string {
  const goal = sessionGoal.trim()
  return `## 当前会话目标\n${goal || '（未设置）'}\n本轮用户消息应服务于上述目标；若与目标无关，先简短确认再行动。`
}
