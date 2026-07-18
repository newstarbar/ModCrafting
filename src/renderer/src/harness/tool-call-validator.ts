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

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return '参数不符合工具 Schema'
  return errors
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`)
    .join('; ')
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

/** Enforce the exact schemas offered in the current model call.
 * Native calls and XML fallback calls pass through this same boundary. */
export function validateToolCalls(
  calls: ModelToolCall[],
  offeredSchemas: ToolSchema[]
): ValidatedToolCalls {
  const offered = new Map(offeredSchemas.map((schema) => [schema.name, schema]))
  const accepted: ModelToolCall[] = []
  const rejected = new Map<string, ToolResult>()

  for (const call of calls) {
    const schema = offered.get(call.name)
    if (!schema) {
      rejected.set(
        call.id,
        rejectedResult(call, 'tool_not_offered', '该工具不在当前阶段/步骤的白名单中')
      )
      continue
    }

    try {
      const parsed = JSON.parse(call.rawArguments || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejected.set(
          call.id,
          rejectedResult(call, 'invalid_tool_arguments', 'arguments 必须是 JSON object')
        )
        continue
      }
    } catch {
      const hint =
        call.name === 'write_file'
          ? 'arguments 不是合法 JSON（大文件易截断）。请改用 write_file 写骨架（短内容）+ 多次 edit_file 分段填充。'
          : 'arguments 不是合法 JSON'
      rejected.set(call.id, rejectedResult(call, 'invalid_tool_arguments', hint))
      continue
    }

    let validator: ValidateFunction
    try {
      validator = validatorFor(schema.parameters)
    } catch (error) {
      rejected.set(
        call.id,
        rejectedResult(call, 'invalid_tool_arguments', `工具 Schema 无效：${String(error)}`)
      )
      continue
    }
    if (!validator(call.args)) {
      rejected.set(
        call.id,
        rejectedResult(call, 'invalid_tool_arguments', formatErrors(validator.errors))
      )
      continue
    }
    accepted.push(call)
  }

  return { accepted, rejected }
}
