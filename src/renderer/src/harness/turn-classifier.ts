/**
 * Constrained LLM turn classifier — replaces keyword bags in turn-intent.
 * Forces a single tool call `classify_user_turn` with an enum/boolean schema.
 */

import type { TurnIntent, TurnIntentContext, ComposerMode } from './turn-intent.ts'
import {
  isCodeExplainInput,
  isNarrowResumeInput,
  isStructuralErrorReport
} from './turn-intent.ts'
import { parseToolCalls } from './tools.ts'
import { stripMinimaxProtocolTokens, stripThinkTags } from './model-output-normalizer.ts'

export interface ClassifyVerifyTargetPayload {
  label: string
  hotkey?: string
  screenNameHints: string[]
  openSteps: string[]
}

export interface ClassifyUserTurnResult {
  intent: TurnIntent
  isInGameVerifyRequest: boolean
  skipFormalPlan: boolean
  isUserSymptom: boolean
  isSymptomResolved: boolean
  isErrorReport: boolean
  isGuiFeatureSymptom: boolean
  verifyTarget: ClassifyVerifyTargetPayload | null
  rationale: string
  /** true when LLM failed and structural fallback was used */
  usedFallback: boolean
  classificationSource?: 'fast_path' | 'tool_call' | 'json_retry' | 'structural_fallback'
  diagnostics?: ClassifierDiagnostics
}

export interface ClassifierDiagnostics {
  providerId: string
  model: string
  endpointHost: string
  attempted: 'tool_call' | 'json_retry'
  failureCode: string
  httpStatus?: number
}

export interface ClassifyUserTurnArgs {
  apiConfig: { endpoint: string; apiKey: string; model: string; providerId?: string }
  input: string
  ctx: TurnIntentContext
  stickySymptom?: string | null
  abortSignal?: AbortSignal
  /** Injectable for tests */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const CLASSIFY_TOOL_NAME = 'classify_user_turn'

const CLASSIFY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: {
      type: 'string',
      enum: ['chat', 'resume', 'develop', 'plan_only'],
      description: 'Routing intent for this user turn'
    },
    isInGameVerifyRequest: {
      type: 'boolean',
      description:
        'True when user asks to re-test / verify in Minecraft without starting a new formal plan'
    },
    skipFormalPlan: {
      type: 'boolean',
      description:
        'True for short bug/symptom fixes that should jump straight to execute (write/build/run)'
    },
    isUserSymptom: {
      type: 'boolean',
      description: 'True when the message reports a remaining bug / acceptance failure'
    },
    isSymptomResolved: {
      type: 'boolean',
      description: 'True when user confirms the previous symptom is fixed'
    },
    isErrorReport: {
      type: 'boolean',
      description: 'True for crash dumps, stack traces, or build failure pastes'
    },
    isGuiFeatureSymptom: {
      type: 'boolean',
      description: 'True when symptom is about GUI / screen / hotkey / preview / layout'
    },
    verifyTarget: {
      type: ['object', 'null'],
      description:
        'Concrete in-game screen target when GUI verification is needed; null otherwise',
      properties: {
        label: { type: 'string', description: 'Human-readable detection goal' },
        hotkey: {
          type: 'string',
          description: 'Optional hotkey like f6 (lowercase f + 1–12)'
        },
        screenNameHints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Substrings/class name fragments to match screen.simpleName (e.g. Preview, MainMenuPreviewScreen)'
        },
        openSteps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short steps for the agent to open the target screen'
        }
      },
      required: ['label', 'screenNameHints', 'openSteps']
    },
    rationale: {
      type: 'string',
      description: 'One short sentence explaining the classification'
    }
  },
  required: [
    'intent',
    'isInGameVerifyRequest',
    'skipFormalPlan',
    'isUserSymptom',
    'isSymptomResolved',
    'isErrorReport',
    'isGuiFeatureSymptom',
    'verifyTarget',
    'rationale'
  ]
}

const CLASSIFY_SYSTEM_PROMPT = `你是 ModCrafting 桌面应用的回合路由器。只通过工具 classify_user_turn 返回结构化判断，不要输出其它正文。

硬约束（按优先级）：
1. composerMode=ask → intent=chat；禁止写码/执行类路由。
2. 消息是「代码解释」上下文 → intent=chat。
3. 崩溃堆栈 / Minecraft Crash Report / BUILD FAILED / 多行 at … Exception → isErrorReport=true；execute 中有未完成计划时 intent=resume，否则 intent=develop；绝不能 intent=chat。
4. 用户明确要求继续执行已有计划（短命令）且 canResumePlan/phase=execute → intent=resume。
5. composerMode=plan → 通常 intent=plan_only（除非明确 resume）。
6. 有项目且用户只要求游戏内再测/验证/看效果（短请求）→ isInGameVerifyRequest=true，intent=develop，skipFormalPlan=false。
7. 短症状/仍坏反馈（非验证短命令）→ isUserSymptom=true，skipFormalPlan=true，intent=develop；若涉及界面/热键/预览 → isGuiFeatureSymptom=true，并填写 verifyTarget（screenNameHints 用类名片段如 Preview / ConfigScreen）。
8. 用户确认已修好 → isSymptomResolved=true，intent=chat 或 develop 均可但不要 skipFormalPlan。
9. 问候/纯问答 → intent=chat；明确要创建/修改功能 → intent=develop。
10. isInGameVerifyRequest 与 skipFormalPlan 互斥（验证请求不要 skipFormalPlan）。
11. 用户输入含模糊、不专业的游戏术语（如"会爆炸的绿色怪物"、"挖矿掉的红色石头"、"那个能发光的方块"）时，仍按上述规则判定 intent（通常为 develop 或 plan_only），不要因术语模糊而判定为 chat；执行阶段会由 mc_wiki_search 工具解析需求。
不要背诵词表；按语义判断。rationale 用一句中文。`

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asIntent(v: unknown): TurnIntent | null {
  if (v === 'chat' || v === 'resume' || v === 'develop' || v === 'plan_only') return v
  return null
}

function normalizeHotkey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = raw.trim().match(/^f?([1-9]|1[0-2])$/i)
  return m ? `f${m[1]}` : undefined
}

function parseVerifyTarget(raw: unknown): ClassifyVerifyTargetPayload | null {
  if (raw == null) return null
  if (typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const label = String(obj.label || '').trim()
  if (!label) return null
  const hints = Array.isArray(obj.screenNameHints)
    ? obj.screenNameHints.map((h) => String(h || '').trim()).filter(Boolean).slice(0, 8)
    : []
  const openSteps = Array.isArray(obj.openSteps)
    ? obj.openSteps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6)
    : []
  const hotkey = normalizeHotkey(obj.hotkey)
  return {
    label: label.slice(0, 120),
    ...(hotkey ? { hotkey } : {}),
    screenNameHints: hints,
    openSteps:
      openSteps.length > 0
        ? openSteps
        : ['打开待测功能界面', 'mc_inspect 确认已离开 TitleScreen']
  }
}

/** Validate and coerce tool arguments from the model. */
export function parseClassifyToolArgs(
  raw: unknown,
  classificationSource: 'tool_call' | 'json_retry' = 'tool_call'
): ClassifyUserTurnResult | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const intent = asIntent(obj.intent)
  if (!intent) return null
  return {
    intent,
    isInGameVerifyRequest: asBool(obj.isInGameVerifyRequest),
    skipFormalPlan: asBool(obj.skipFormalPlan),
    isUserSymptom: asBool(obj.isUserSymptom),
    isSymptomResolved: asBool(obj.isSymptomResolved),
    isErrorReport: asBool(obj.isErrorReport),
    isGuiFeatureSymptom: asBool(obj.isGuiFeatureSymptom),
    verifyTarget: parseVerifyTarget(obj.verifyTarget),
    rationale: String(obj.rationale || '').trim().slice(0, 200) || '（无理由）',
    usedFallback: false,
    classificationSource
  }
}

/** Apply context hard-gates after model output (or on fallback). */
export function applyClassifyContextGates(
  result: ClassifyUserTurnResult,
  ctx: TurnIntentContext,
  input: string
): ClassifyUserTurnResult {
  const trimmed = input.trim()
  let next = { ...result }

  if (isCodeExplainInput(trimmed) || ctx.composerMode === 'ask') {
    next = {
      ...next,
      intent: 'chat',
      isInGameVerifyRequest: false,
      skipFormalPlan: false
    }
  }

  if (ctx.composerMode === 'plan' && next.intent !== 'resume') {
    next = { ...next, intent: 'plan_only' }
  }

  if (next.isInGameVerifyRequest) {
    next = {
      ...next,
      skipFormalPlan: false,
      intent: next.intent === 'chat' ? 'develop' : next.intent
    }
  }

  if (next.isErrorReport && next.intent === 'chat') {
    const canResume =
      ctx.phase === 'execute' ||
      Boolean(ctx.planTracker && !ctx.planTracker.allDone()) ||
      Boolean(ctx.hasPlanCandidate)
    next = { ...next, intent: canResume ? 'resume' : 'develop' }
  }

  // Mutual exclusions
  if (next.isSymptomResolved) {
    next = { ...next, isUserSymptom: false, skipFormalPlan: false, isInGameVerifyRequest: false }
  }
  if (next.isInGameVerifyRequest && next.skipFormalPlan) {
    next = { ...next, skipFormalPlan: false }
  }

  return next
}

export function structuralClassifyFallback(
  input: string,
  ctx: TurnIntentContext,
  diagnostics?: ClassifierDiagnostics
): ClassifyUserTurnResult {
  const trimmed = input.trim()
  const canResumePlan =
    Boolean(ctx.planTracker && !ctx.planTracker.allDone()) || Boolean(ctx.hasPlanCandidate)
  const error = isStructuralErrorReport(trimmed)

  let intent: TurnIntent = 'develop'
  if (isCodeExplainInput(trimmed) || ctx.composerMode === 'ask') {
    intent = 'chat'
  } else if (ctx.composerMode === 'plan') {
    intent = 'plan_only'
  } else if (isNarrowResumeInput(trimmed) && (ctx.phase === 'execute' || canResumePlan)) {
    intent = 'resume'
  } else if (error) {
    intent = ctx.phase === 'execute' || canResumePlan ? 'resume' : 'develop'
  } else if (ctx.composerMode === 'agent') {
    intent = ctx.hasProject ? 'develop' : 'chat'
  } else {
    intent = ctx.hasProject ? 'develop' : 'chat'
  }

  return applyClassifyContextGates(
    {
      intent,
      isInGameVerifyRequest: false,
      skipFormalPlan: error && intent === 'develop',
      isUserSymptom: error,
      isSymptomResolved: false,
      isErrorReport: error,
      isGuiFeatureSymptom: false,
      verifyTarget: null,
      rationale: diagnostics
        ? `意图分类失败（${diagnostics.failureCode}），已用结构性兜底`
        : '意图分类失败，已用结构性兜底',
      usedFallback: true,
      classificationSource: 'structural_fallback',
      ...(diagnostics ? { diagnostics } : {})
    },
    ctx,
    input
  )
}

function buildUserClassifyPayload(
  input: string,
  ctx: TurnIntentContext,
  stickySymptom?: string | null
): string {
  const hasIncompletePlan = Boolean(ctx.planTracker && !ctx.planTracker.allDone())
  const planAllDone = Boolean(ctx.planTracker && ctx.planTracker.allDone())
  return JSON.stringify(
    {
      userText: input.trim().slice(0, 2000),
      composerMode: ctx.composerMode as ComposerMode,
      phase: ctx.phase,
      hasProject: ctx.hasProject,
      hasActivePlan: hasIncompletePlan,
      hasPlanCandidate: Boolean(ctx.hasPlanCandidate),
      planAllDone,
      canResumePlan: hasIncompletePlan || Boolean(ctx.hasPlanCandidate),
      stickySymptom: (stickySymptom || '').trim().slice(0, 400) || null
    },
    null,
    0
  )
}

function parseJsonContent(content: unknown): unknown | null {
  if (typeof content !== 'string') return null
  const normalized = stripThinkTags(stripMinimaxProtocolTokens(content)).text.trim()
  // Preserve the existing ModCrafting XML tool-call fallback before extracting a
  // generic JSON object: otherwise the outer { name, args } envelope wins.
  for (const call of parseToolCalls(normalized)) {
    if (call.name === CLASSIFY_TOOL_NAME) return call.args
  }
  const candidates = [
    normalized,
    normalized.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || '',
    (() => {
      const start = normalized.indexOf('{')
      const end = normalized.lastIndexOf('}')
      return start >= 0 && end > start ? normalized.slice(start, end + 1) : ''
    })()
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next normalized JSON shape.
    }
  }
  return null
}

function extractToolCallArgs(data: unknown): unknown | null {
  if (!data || typeof data !== 'object') return null
  const root = data as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string | Record<string, unknown> }
        }>
        content?: string | null
      }
    }>
  }
  const msg = root.choices?.[0]?.message
  for (const call of msg?.tool_calls || []) {
    if (call.function?.name && call.function.name !== CLASSIFY_TOOL_NAME) continue
    const raw = call.function?.arguments
    if (raw && typeof raw === 'object') return raw
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw)
      } catch {
        // Some compatible endpoints put their XML/JSON protocol in arguments.
        const parsed = parseJsonContent(raw)
        if (parsed) return parsed
      }
    }
  }
  return parseJsonContent(msg?.content)
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'invalid-endpoint'
  }
}

function classifierDiagnostics(
  args: ClassifyUserTurnArgs,
  attempted: ClassifierDiagnostics['attempted'],
  failureCode: string,
  httpStatus?: number
): ClassifierDiagnostics {
  return {
    providerId: args.apiConfig.providerId || 'custom',
    model: args.apiConfig.model,
    endpointHost: endpointHost(args.apiConfig.endpoint),
    attempted,
    failureCode,
    ...(httpStatus == null ? {} : { httpStatus })
  }
}

function isMiniMax(args: ClassifyUserTurnArgs): boolean {
  return args.apiConfig.providerId === 'minimax' || /^minimax-/i.test(args.apiConfig.model)
}

function classifyMessages(args: ClassifyUserTurnArgs, jsonOnly = false): Array<{ role: 'system' | 'user'; content: string }> {
  const system = jsonOnly
    ? `${CLASSIFY_SYSTEM_PROMPT}\n不要调用工具。只返回一个符合 classify_user_turn 参数 Schema 的 JSON 对象，不要 Markdown、解释或 think 内容。`
    : CLASSIFY_SYSTEM_PROMPT
  return [
    { role: 'system', content: system },
    { role: 'user', content: buildUserClassifyPayload(args.input, args.ctx, args.stickySymptom) }
  ]
}

function buildClassifierRequest(args: ClassifyUserTurnArgs, jsonOnly: boolean): Record<string, unknown> {
  const minimax = isMiniMax(args)
  const body: Record<string, unknown> = {
    model: args.apiConfig.model,
    stream: false,
    max_tokens: 400,
    temperature: minimax ? 0.01 : 0,
    messages: classifyMessages(args, jsonOnly)
  }
  if (jsonOnly) return body
  body.tools = [
    {
      type: 'function',
      function: {
        name: CLASSIFY_TOOL_NAME,
        description: 'Classify the user turn for ModCrafting harness routing',
        parameters: CLASSIFY_TOOL_PARAMETERS
      }
    }
  ]
  // MiniMax rejects the OpenAI object form used to force a tool call. Its system
  // prompt and schema are sufficient; other OpenAI-compatible providers retain it.
  if (!minimax) {
    body.tool_choice = { type: 'function', function: { name: CLASSIFY_TOOL_NAME } }
  }
  return body
}

interface ClassifierAttemptResult {
  parsed?: ClassifyUserTurnResult
  diagnostics?: ClassifierDiagnostics
}

async function runClassifierAttempt(
  args: ClassifyUserTurnArgs,
  endpoint: string,
  controller: AbortController,
  fetchImpl: typeof fetch,
  jsonOnly: boolean
): Promise<ClassifierAttemptResult> {
  const attempted: ClassifierDiagnostics['attempted'] = jsonOnly ? 'json_retry' : 'tool_call'
  try {
    const response = await fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiConfig.apiKey.trim()}`
      },
      signal: controller.signal,
      body: JSON.stringify(buildClassifierRequest(args, jsonOnly))
    })
    if (!response.ok) {
      return { diagnostics: classifierDiagnostics(args, attempted, `http_${response.status}`, response.status) }
    }
    let data: unknown
    try {
      data = await response.json()
    } catch {
      return { diagnostics: classifierDiagnostics(args, attempted, 'invalid_json_response') }
    }
    const parsed = parseClassifyToolArgs(extractToolCallArgs(data), jsonOnly ? 'json_retry' : 'tool_call')
    return parsed
      ? { parsed }
      : { diagnostics: classifierDiagnostics(args, attempted, 'unparseable_response') }
  } catch (error) {
    if (controller.signal.aborted) {
      return { diagnostics: classifierDiagnostics(args, attempted, args.abortSignal?.aborted ? 'cancelled' : 'timeout') }
    }
    return { diagnostics: classifierDiagnostics(args, attempted, error instanceof Error ? 'network_error' : 'request_error') }
  }
}

function mayRetryAsJson(diagnostics: ClassifierDiagnostics | undefined): boolean {
  if (!diagnostics) return false
  return diagnostics.failureCode === 'unparseable_response' || diagnostics.failureCode === 'invalid_json_response' ||
    diagnostics.httpStatus === 400 || diagnostics.httpStatus === 404 || diagnostics.httpStatus === 422
}

/** Classify a user turn with a provider-compatible tool request and one JSON fallback. */
export async function classifyUserTurn(args: ClassifyUserTurnArgs): Promise<ClassifyUserTurnResult> {
  const { ctx, input } = args
  const timeoutMs = args.timeoutMs ?? 10_000
  const fetchImpl = args.fetchImpl ?? fetch

  if (isCodeExplainInput(input) || ctx.composerMode === 'ask') {
    return applyClassifyContextGates({
      intent: 'chat', isInGameVerifyRequest: false, skipFormalPlan: false,
      isUserSymptom: false, isSymptomResolved: false, isErrorReport: false,
      isGuiFeatureSymptom: false, verifyTarget: null, rationale: 'ask/代码解释 → chat',
      usedFallback: false, classificationSource: 'fast_path'
    }, ctx, input)
  }

  const endpoint = (args.apiConfig.endpoint || '').replace(/\/$/, '')
  if (!endpoint || !args.apiConfig.apiKey?.trim()) {
    return structuralClassifyFallback(input, ctx, classifierDiagnostics(args, 'tool_call', 'missing_config'))
  }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  args.abortSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('classify timeout')), timeoutMs)

  try {
    const first = await runClassifierAttempt(args, endpoint, controller, fetchImpl, false)
    let parsed = first.parsed
    let failure = first.diagnostics
    if (!parsed && !controller.signal.aborted && mayRetryAsJson(failure)) {
      const retry = await runClassifierAttempt(args, endpoint, controller, fetchImpl, true)
      parsed = retry.parsed
      failure = retry.diagnostics || failure
    }
    if (!parsed) return structuralClassifyFallback(input, ctx, failure)
    if (isStructuralErrorReport(input) && !parsed.isErrorReport) parsed.isErrorReport = true
    return applyClassifyContextGates(parsed, ctx, input)
  } finally {
    clearTimeout(timer)
    args.abortSignal?.removeEventListener('abort', onAbort)
  }
}
