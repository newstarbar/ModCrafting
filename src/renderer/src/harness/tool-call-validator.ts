import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import type { ModelToolCall } from './chat-message.ts'
import type { ToolResult } from './tools.ts'

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ValidatedToolCalls {
  accepted: ModelToolCall[]
  rejected: Map<string, ToolResult>
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validatorCache = new WeakMap<object, ValidateFunction>()

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = schema as object
  const cached = validatorCache.get(key)
  if (cached) return cached
  const validator = ajv.compile(schema)
  validatorCache.set(key, validator)
  return validator
}

function formatErrors(errors: ErrorObject[] | null | undefined, toolName?: string): string {
  if (!errors?.length) return '参数不符合工具 Schema'
  const detail = errors
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`)
    .join('; ')
  if (toolName === 'submit_plan' && errors.some((error) => /^\/steps\/\d+$/.test(error.instancePath) && error.keyword === 'type')) {
    return `${detail}。steps 的每一项必须是 JSON 对象，不能是字符串；合法示例：` +
      `{"steps":[{"kind":"write","description":"实现功能","targetPath":"src/main/java/.../Feature.java","evidence":"文件写入成功"}]}`
  }
  return detail
}

function parseEmbeddedObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const EMBEDDED_STEP_FIELDS = ['kind', 'description', 'targetPath', 'evidence'] as const

function integerFromProvider(value: unknown): unknown {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return value
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : value
}

function normalizeGameAssertion(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, changed: false }
  const assertion: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  let changed = false
  for (const field of ['afterAction', 'minResult', 'countAtLeast', 'x', 'y', 'z'] as const) {
    const next = integerFromProvider(assertion[field])
    if (next !== assertion[field]) { assertion[field] = next; changed = true }
  }
  return { value: changed ? assertion : value, changed }
}

function normalizeGameActions(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) return { value, changed: false }
  let changed = false
  const actions = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const action: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
    const ms = integerFromProvider(action.ms)
    if (ms !== action.ms) { action.ms = ms; changed = true }
    if (action.action === 'key') { action.action = 'key_press'; changed = true }
    return action
  })
  return { value: changed ? actions : value, changed }
}

/** MiniMax-compatible fallback for nested step values. Some compatible
 * endpoints keep the outer arguments as JSON but serialize each array item as
 * either XML fields or a comma-separated key=value record. Only known fields
 * are accepted; a missing kind/description keeps the value invalid so the
 * schema can report it instead of guessing. */
export function parseEmbeddedPlanStep(value: unknown): Record<string, unknown> | null {
  const json = parseEmbeddedObject(value)
  if (json) return json
  if (typeof value !== 'string') return null
  const text = value.trim()

  const xml: Record<string, unknown> = {}
  for (const field of EMBEDDED_STEP_FIELDS) {
    const match = text.match(new RegExp(`<${field}>\\s*([\\s\\S]*?)\\s*</${field}>`, 'i'))
    if (match?.[1]?.trim()) xml[field] = match[1].trim()
  }
  if (typeof xml.kind === 'string' && typeof xml.description === 'string') return xml

  const assignments: Record<string, unknown> = {}
  const fieldPattern = /(?:^|,\s*)(kind|description|targetPath|evidence)\s*=\s*([\s\S]*?)(?=,\s*(?:kind|description|targetPath|evidence)\s*=|$)/gi
  let match: RegExpExecArray | null
  while ((match = fieldPattern.exec(text)) !== null) {
    const field = match[1]
    const fieldValue = match[2]?.trim()
    if (fieldValue) assignments[field] = fieldValue
  }
  return typeof assignments.kind === 'string' && typeof assignments.description === 'string'
    ? assignments
    : null
}

/** Some OpenAI-compatible providers encode nested array objects as JSON strings.
 *  Also coerces acceptanceContract.version to the integer 1 required by the schema:
 *  MiniMax-M3 in native tool_calls serializes `1` as the string `"1"`, which fails
 *  the `const: 1` check and traps the model in a version-error loop. */
export function normalizeToolCallArguments(call: ModelToolCall): ModelToolCall {
  if (call.name !== 'submit_plan' || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return call
  const args: Record<string, unknown> = { ...call.args }
  let changed = false

  const contract = args.acceptanceContract
  if (contract && typeof contract === 'object' && !Array.isArray(contract)) {
    const normalizedContract: Record<string, unknown> = { ...(contract as Record<string, unknown>) }
    const v = normalizedContract.version
    if (v === '1' || v === 1) {
      if (v !== 1) {
        normalizedContract.version = 1
        changed = true
      }
    }
    if (Array.isArray(normalizedContract.requirements)) {
      let requirementsChanged = false
      normalizedContract.requirements = normalizedContract.requirements.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
        const requirement = { ...(raw as Record<string, unknown>) }
        const oracle = requirement.oracle
        if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) return raw
        const normalizedOracle = { ...(oracle as Record<string, unknown>) }
        const assertion = normalizeGameAssertion(normalizedOracle.assertion)
        if (!assertion.changed) return raw
        normalizedOracle.assertion = assertion.value
        requirement.oracle = normalizedOracle
        requirementsChanged = true
        return requirement
      })
      if (requirementsChanged) changed = true
    }
    if (changed) args.acceptanceContract = normalizedContract
  }

  const gameTest = args.gameTest
  if (gameTest && typeof gameTest === 'object' && !Array.isArray(gameTest)) {
    const normalizedGameTest: Record<string, unknown> = { ...(gameTest as Record<string, unknown>) }
    let gameTestChanged = false
    const actions = normalizeGameActions(normalizedGameTest.actions)
    if (actions.changed) { normalizedGameTest.actions = actions.value; gameTestChanged = true }
    if (Array.isArray(normalizedGameTest.assertions)) {
      let assertionsChanged = false
      normalizedGameTest.assertions = normalizedGameTest.assertions.map((assertion) => {
        const normalized = normalizeGameAssertion(assertion)
        if (normalized.changed) assertionsChanged = true
        return normalized.value
      })
      if (assertionsChanged) gameTestChanged = true
    }
    if (gameTestChanged) { args.gameTest = normalizedGameTest; changed = true }
  }

  const steps = args.steps
  if (Array.isArray(steps)) {
    const normalizedSteps = steps.map((step) => {
      const parsed = parseEmbeddedPlanStep(step)
      if (!parsed) return step
      changed = true
      return parsed
    })
    if (changed) args.steps = normalizedSteps
  }

  if (!changed) return call
  return { ...call, args, rawArguments: JSON.stringify(args) }
}

function rejectedResult(
  call: ModelToolCall,
  errorKind: 'tool_not_offered' | 'invalid_tool_arguments',
  detail: string
): ToolResult {
  const output = `blocked: [${errorKind}] 工具 "${call.name}" 未执行：${detail}`
  return {
    output,
    error: output,
    durationMs: 0,
    ok: false,
    toolName: call.name,
    args: call.args,
    exitCode: null,
    errorKind
  }
}

export interface ToolCallContext {
  /** 当前阶段，影响错误消息中的操作指导 */
  phase?: 'plan' | 'execute'
  /** 当前步骤标题（execute 阶段），用于错误消息定位 */
  stepTitle?: string
}

/** 工具不在白名单时，生成阶段感知的明确错误消息（含允许工具列表 + 操作指导） */
function rejectedNotOfferedResult(
  call: ModelToolCall,
  offeredSchemas: ToolSchema[],
  context?: ToolCallContext
): ToolResult {
  const phase = context?.phase ?? 'execute'
  // 排除 complete_step 避免噪音；保留 submit_plan 让 AI 知道可以提交计划
  const allowedNames = offeredSchemas
    .map(s => s.name)
    .filter(n => n !== 'complete_step')
  const allowedList = allowedNames.length > 0 ? allowedNames.join(', ') : '（无）'

  let detail: string
  if (phase === 'plan') {
    const writeTools = ['write_file', 'edit_file', 'delete_file', 'trigger_build', 'run_command']
    const mcTools = ['mc_screenshot', 'mc_inspect', 'mc_command', 'mc_input', 'mc_ensure_test_world', 'mc_ensure_cheats', 'mc_inventory', 'mc_world', 'mc_chat']
    if (writeTools.includes(call.name)) {
      detail = `当前处于计划阶段，禁止写入/编辑/删除文件或触发构建。计划阶段仅允许只读工具：${allowedList}。\n` +
        `请直接输出结构化计划文本（每步一行，格式：N. [kind] 标题 — 目标路径），不要调用 ${call.name}。`
    } else if (mcTools.includes(call.name)) {
      detail = `当前处于计划阶段，禁止操作游戏。计划阶段仅允许只读工具：${allowedList}。\n` +
        `请直接输出结构化计划文本，不要调用 ${call.name}。`
    } else {
      detail = `当前处于计划阶段，该工具不在允许列表中。允许的只读工具：${allowedList}。\n` +
        `请直接输出结构化计划文本，或改用允许的工具。`
    }
  } else {
    const stepInfo = context?.stepTitle ? `当前步骤：${context.stepTitle}。` : ''
    detail = `${stepInfo}工具 "${call.name}" 不在当前步骤的白名单中。当前允许的工具：${allowedList}。\n` +
      `请改用允许的工具；若当前步骤无需工具调用，可调用 complete_step 推进到下一步骤。`
  }

  const output = `blocked: [tool_not_offered] ${detail}`
  return {
    output,
    error: output,
    durationMs: 0,
    ok: false,
    toolName: call.name,
    args: call.args,
    exitCode: null,
    errorKind: 'tool_not_offered'
  }
}

/** Enforce the exact schemas offered in the current model call.
 * Native calls and XML fallback calls pass through this same boundary. */
export function validateToolCalls(
  calls: ModelToolCall[],
  offeredSchemas: ToolSchema[],
  context?: ToolCallContext
): ValidatedToolCalls {
  const offered = new Map(offeredSchemas.map((schema) => [schema.name, schema]))
  const accepted: ModelToolCall[] = []
  const rejected = new Map<string, ToolResult>()

  for (const call of calls) {
    const normalizedCall = normalizeToolCallArguments(call)
    const schema = offered.get(normalizedCall.name)
    if (!schema) {
      rejected.set(
        normalizedCall.id,
        rejectedNotOfferedResult(normalizedCall, offeredSchemas, context)
      )
      continue
    }

    try {
      const parsed = JSON.parse(normalizedCall.rawArguments || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejected.set(
          normalizedCall.id,
          rejectedResult(normalizedCall, 'invalid_tool_arguments', 'arguments 必须是 JSON object')
        )
        continue
      }
    } catch {
      const hint =
        normalizedCall.name === 'write_file' || normalizedCall.name === 'edit_file'
          ? 'arguments 不是合法 JSON（大文件易截断）。整文件重写请：① write_file 短骨架（overwrite=true，内容建议 <80 行）；② 多次 edit_file，每次 new_string 只加一小段方法/字段。禁止再次提交整文件 JSON；此问题与文档无关，不要 fabric_docs_search。'
          : 'arguments 不是合法 JSON'
      rejected.set(normalizedCall.id, rejectedResult(normalizedCall, 'invalid_tool_arguments', hint))
      continue
    }

    let validator: ValidateFunction
    try {
      validator = validatorFor(schema.parameters)
    } catch (error) {
      rejected.set(
        call.id,
        rejectedResult(normalizedCall, 'invalid_tool_arguments', `工具 Schema 无效：${String(error)}`)
      )
      continue
    }
    if (!validator(normalizedCall.args)) {
      rejected.set(
        normalizedCall.id,
        rejectedResult(normalizedCall, 'invalid_tool_arguments', formatErrors(validator.errors, normalizedCall.name))
      )
      continue
    }
    accepted.push(normalizedCall)
  }

  return { accepted, rejected }
}
