/**
 * Optional LLM refinement for routing signals when rule extraction is ambiguous.
 * Fail-open: any error returns null so the caller keeps the rules decision.
 */

import type { ChatMessage } from './chat-message.ts'
import { createModelAdapter } from './model-adapter.ts'
import { parseToolCalls } from './tools.ts'
import { stripMinimaxProtocolTokens, stripThinkTags } from './model-output-normalizer.ts'
import type { LlmProtocol } from '../../../shared/harness-runtime.ts'
import {
  type RoutingSignals,
  type TaskDifficulty,
  type TaskTemplateId,
  TASK_TEMPLATE_IDS
} from '../../../shared/model-routing.ts'

const CLASSIFY_TOOL_NAME = 'classify_routing_signals'

const TEMPLATE_ENUM = TASK_TEMPLATE_IDS.filter((id) => id !== 'auto')

const CLASSIFY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    taskTemplateId: {
      type: 'string',
      enum: TEMPLATE_ENUM,
      description: 'Task template for multi-model role routing'
    },
    difficulty: {
      type: 'string',
      enum: ['simple', 'standard', 'complex'],
      description: 'Estimated implementation difficulty'
    },
    needsVision: {
      type: 'boolean',
      description: 'True when GUI / screenshot / visual review is required'
    },
    needsDebug: {
      type: 'boolean',
      description: 'True when crash, build failure, or bug diagnosis is central'
    },
    rationale: {
      type: 'string',
      description: 'One short Chinese sentence'
    }
  },
  required: ['taskTemplateId', 'difficulty', 'needsVision', 'needsDebug', 'rationale']
}

const SYSTEM_PROMPT = `你是 ModCrafting 的模型路由信号分类器。只通过工具 ${CLASSIFY_TOOL_NAME} 返回结构化判断，不要输出其它正文。
根据用户需求判断任务模板、难度、是否需要视觉审查、是否需要诊断。
模板含义：feature=新功能；bugfix=修 bug；ui=界面/GUI；build=构建环境；minecraft=方块/物品/实体/配方等；refactor=重构迁移；knowledge=知识问答/文档。
难度：simple=短小明确；standard=常规多步；complex=架构级/多模块/高风险。`

export interface ClassifyRoutingSignalsArgs {
  apiConfig: { endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol }
  input: string
  seed: RoutingSignals
  abortSignal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function parseRoutingSignalToolArgs(raw: unknown, seed: RoutingSignals): RoutingSignals | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const template = String(obj.taskTemplateId || '')
  if (!TEMPLATE_ENUM.includes(template as Exclude<TaskTemplateId, 'auto'>)) return null
  const difficulty = String(obj.difficulty || '')
  if (difficulty !== 'simple' && difficulty !== 'standard' && difficulty !== 'complex') return null
  return {
    taskTemplateId: template as Exclude<TaskTemplateId, 'auto'>,
    difficulty: difficulty as TaskDifficulty,
    needsVision: typeof obj.needsVision === 'boolean' ? obj.needsVision : seed.needsVision,
    needsDebug: typeof obj.needsDebug === 'boolean' ? obj.needsDebug : seed.needsDebug,
    ambiguous: false,
    confidence: 'high'
  }
}

function parseJsonContent(text: unknown): unknown {
  if (typeof text !== 'string') return null
  const cleaned = stripThinkTags(stripMinimaxProtocolTokens(text)).trim()
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : cleaned).trim()
  try {
    return JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function extractToolCallArgs(data: unknown): unknown {
  const msg = (data as { choices?: Array<{ message?: { tool_calls?: unknown; content?: unknown } }> })?.choices?.[0]?.message
  if (msg?.tool_calls) {
    const calls = parseToolCalls(typeof msg.tool_calls === 'string' ? msg.tool_calls : JSON.stringify(msg.tool_calls))
    const hit = calls.find((call) => call.name === CLASSIFY_TOOL_NAME) || calls[0]
    if (hit?.arguments) {
      try {
        return typeof hit.arguments === 'string' ? JSON.parse(hit.arguments) : hit.arguments
      } catch {
        return parseJsonContent(String(hit.arguments))
      }
    }
  }
  const anthropic = data as { content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }> }
  for (const block of anthropic.content || []) {
    if (block.type === 'tool_use' && (!block.name || block.name === CLASSIFY_TOOL_NAME)) return block.input ?? null
  }
  const anthropicText = (anthropic.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('\n')
  if (anthropicText) return parseJsonContent(anthropicText)
  return parseJsonContent(msg?.content)
}

/** Refine ambiguous routing signals with the router model. Returns null on any failure. */
export async function classifyRoutingSignals(args: ClassifyRoutingSignalsArgs): Promise<RoutingSignals | null> {
  const fetchImpl = args.fetchImpl || fetch
  const timeoutMs = args.timeoutMs ?? 12_000
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  args.abortSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const adapter = createModelAdapter({
      endpoint: args.apiConfig.endpoint,
      model: args.apiConfig.model,
      providerId: args.apiConfig.providerId,
      protocol: args.apiConfig.protocol
    })
    const request = adapter.buildRequest({
      endpoint: args.apiConfig.endpoint,
      apiKey: args.apiConfig.apiKey,
      model: args.apiConfig.model,
      providerId: args.apiConfig.providerId,
      protocol: args.apiConfig.protocol,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            input: args.input.slice(0, 4000),
            seed: args.seed
          })
        }
      ] as ChatMessage[],
      tools: [{
        name: CLASSIFY_TOOL_NAME,
        description: 'Classify routing signals for multi-model role binding',
        parameters: CLASSIFY_TOOL_PARAMETERS
      }],
      maxTokens: 300,
      stream: false
    })
    const response = await fetchImpl(request.url, { ...request.init, signal: controller.signal })
    if (!response.ok) return null
    const data = await response.json()
    return parseRoutingSignalToolArgs(extractToolCallArgs(data), args.seed)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    args.abortSignal?.removeEventListener('abort', onAbort)
  }
}
