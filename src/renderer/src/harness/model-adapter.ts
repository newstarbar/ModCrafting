import { buildProviderThinkingFields, getModelContextWindow, inferLlmProtocol } from '../../../shared/llm-providers.ts'
import type { ChatContentPart, ChatMessage } from './chat-message.ts'
import type { LlmProtocol, ModelCapabilities, NormalizedModelEvent, NormalizedToolCallEvent } from '../../../shared/harness-runtime.ts'

export interface ModelRequestInput {
  endpoint: string
  apiKey: string
  model: string
  providerId?: string
  protocol?: LlmProtocol
  messages: ChatMessage[]
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens: number
  /** Streaming is the default for the agent loop; classifiers use false. */
  stream?: boolean
}

export interface ModelAdapterOptions {
  endpoint: string
  model: string
  providerId?: string
  protocol?: LlmProtocol
}

export interface ModelAdapter {
  readonly capabilities: ModelCapabilities
  buildRequest(input: ModelRequestInput): { url: string; init: RequestInit }
  normalizeEvent(payload: unknown): NormalizedModelEvent[]
  normalizeError(error: unknown): Error
}

function optionValues(
  input: ModelAdapterOptions | string,
  model?: string,
  providerId?: string,
  protocol?: LlmProtocol
): ModelAdapterOptions {
  if (typeof input === 'string') return { endpoint: input, model: model || '', providerId, protocol }
  return input
}

function eventToolCall(call: Record<string, any>): NormalizedToolCallEvent {
  const providerIndex = Number.isInteger(call.index) ? Number(call.index) : undefined
  const providerId = typeof call.id === 'string' && call.id.trim() ? call.id : undefined
  const nameDelta = typeof call.function?.name === 'string'
    ? call.function.name
    : typeof call.name === 'string'
      ? call.name
      : undefined
  const argumentsDelta = typeof call.function?.arguments === 'string'
    ? call.function.arguments
    : typeof call.arguments === 'string'
      ? call.arguments
      : ''
  return { providerIndex, providerId, nameDelta, argumentsDelta }
}

function normalizeOpenAiPayload(payload: unknown): NormalizedModelEvent[] {
  const parsed = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>
  const events: NormalizedModelEvent[] = []
  const usage = parsed.usage
  if (usage) {
    events.push({
      type: 'usage',
      usage: {
        promptTokens: usage.prompt_tokens ?? usage.promptTokens,
        completionTokens: usage.completion_tokens ?? usage.completionTokens,
        totalTokens: usage.total_tokens ?? usage.totalTokens
      }
    })
  }

  const choice = parsed.choices?.[0]
  const delta = choice?.delta || {}
  if (choice?.finish_reason) events.push({ type: 'done', finishReason: String(choice.finish_reason) })
  if (delta.reasoning_content != null || delta.reasoning != null) {
    events.push({ type: 'reasoning_delta', reasoning: String(delta.reasoning_content ?? delta.reasoning) })
  }
  if (delta.content != null) events.push({ type: 'text_delta', text: String(delta.content) })

  for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    const call = eventToolCall(rawCall as Record<string, any>)
    // Providers usually send id/name only on the first chunk. Never synthesize
    // an ID from index here; correlation belongs to ToolCallAssembler.
    const isStart = Boolean(call.providerId || call.nameDelta)
    events.push({ type: isStart ? 'tool_call_start' : 'tool_call_delta', toolCall: call })
  }
  if (parsed.error) events.push({ type: 'error', error: String(parsed.error.message || parsed.error) })
  return events
}

function anthropicToolCall(block: Record<string, any>, index?: number): NormalizedToolCallEvent {
  return {
    providerIndex: Number.isInteger(index) ? Number(index) : undefined,
    providerId: typeof block.id === 'string' ? block.id : undefined,
    nameDelta: typeof block.name === 'string' ? block.name : undefined,
    argumentsDelta: ''
  }
}

function normalizeAnthropicPayload(payload: unknown): NormalizedModelEvent[] {
  const parsed = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>
  const events: NormalizedModelEvent[] = []
  const type = String(parsed.type || '')
  if (type === 'error') {
    events.push({ type: 'error', error: String(parsed.error?.message || parsed.message || 'Anthropic stream error') })
    return events
  }
  if (type === 'message_start' && parsed.message?.usage) {
    events.push({ type: 'usage', usage: { promptTokens: parsed.message.usage.input_tokens } })
  }
  if (type === 'content_block_start') {
    const block = parsed.content_block || {}
    if (block.type === 'tool_use') {
      events.push({ type: 'tool_call_start', toolCall: anthropicToolCall(block, parsed.index) })
    } else if (block.type === 'text') {
      events.push({ type: 'text_delta', text: String(block.text || '') })
    }
  }
  if (type === 'content_block_delta') {
    const delta = parsed.delta || {}
    if (delta.type === 'input_json_delta') {
      events.push({
        type: 'tool_call_delta',
        toolCall: {
          providerIndex: Number.isInteger(parsed.index) ? Number(parsed.index) : undefined,
          argumentsDelta: String(delta.partial_json || '')
        }
      })
    } else if (delta.type === 'text_delta') {
      events.push({ type: 'text_delta', text: String(delta.text || '') })
    } else if (delta.type === 'thinking_delta') {
      events.push({ type: 'reasoning_delta', reasoning: String(delta.thinking || '') })
    }
  }
  if (type === 'content_block_stop') {
    events.push({
      type: 'tool_call_end',
      toolCall: { providerIndex: Number.isInteger(parsed.index) ? Number(parsed.index) : undefined }
    })
  }
  if (type === 'message_delta') {
    const delta = parsed.delta || {}
    if (parsed.usage) events.push({ type: 'usage', usage: { completionTokens: parsed.usage.output_tokens } })
    if (delta.stop_reason) events.push({ type: 'done', finishReason: String(delta.stop_reason) })
  }
  if (type === 'message_stop') events.push({ type: 'done', finishReason: 'stop' })
  return events
}

function modelCapabilities(options: ModelAdapterOptions): ModelCapabilities {
  const protocol = inferLlmProtocol(options.endpoint, options.providerId, options.protocol)
  const lower = `${options.endpoint} ${options.model}`.toLowerCase()
  const vision = /vision|glm-4v|glm-5v|qwen-vl|gpt-4o|claude-3|gemini/i.test(lower)
  const reasoning = /reason|think|deepseek-r1|glm-5|o1|o3/i.test(lower)
  const nativeToolCalls = !/text-only|no-tools/i.test(lower)
  return {
    providerId: options.providerId,
    modelId: options.model,
    protocol,
    nativeToolCalls,
    nativeToolStreaming: nativeToolCalls,
    jsonSchema: nativeToolCalls,
    vision,
    streaming: true,
    reasoning,
    contextWindow: getModelContextWindow(options.model, options.providerId) || undefined,
    maxOutputTokens: 32_768,
    probedAt: Date.now()
  }
}

function sanitizeMessage(message: ChatMessage): Omit<ChatMessage, 'origin' | 'taskId' | 'phase'> {
  const { origin: _origin, taskId: _taskId, phase: _phase, ...rest } = message
  return rest
}

/**
 * openai-chat wire shape: internal `reasoningContent` becomes the provider's
 * `reasoning_content`. Only echoed when the turn actually produced reasoning —
 * inventing the field is as invalid as dropping it.
 */
function openAiChatMessage(message: ChatMessage): Record<string, unknown> {
  const { origin: _origin, taskId: _taskId, phase: _phase, reasoningContent, ...rest } = message
  return reasoningContent ? { ...rest, reasoning_content: reasoningContent } : rest
}

function anthropicContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string') return content
  return content.map((part: ChatContentPart) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = part.image_url.url
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    return match
      ? { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
      : { type: 'text', text: '[image]' }
  })
}

function parseCallArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function anthropicMessages(messages: ChatMessage[]): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: unknown }> } {
  let system: string | undefined
  const result: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const raw of messages) {
    const message = sanitizeMessage(raw)
    if (message.role === 'system') {
      system = [system, typeof message.content === 'string' ? message.content : JSON.stringify(message.content)].filter(Boolean).join('\n\n')
      continue
    }
    if (message.role === 'tool') {
      const last = result[result.length - 1]
      const toolBlock = {
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id || ''),
        content: typeof message.content === 'string' ? message.content : message.content
      }
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as any[]).every((item) => item.type === 'tool_result')) {
        ;(last.content as any[]).push(toolBlock)
      } else {
        result.push({ role: 'user', content: [toolBlock] })
      }
      continue
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks: unknown[] = []
      if (typeof message.content === 'string' && message.content.trim()) blocks.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseCallArgs(call.function.arguments) })
      }
      result.push({ role: 'assistant', content: blocks })
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    result.push({ role, content: anthropicContent(message.content) })
  }
  // Anthropic requires alternating user/assistant turns.  Tool results are
  // user content, so consecutive controller messages of the same role must
  // be coalesced before sending them to the provider.
  const merged: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const item of result) {
    const previous = merged[merged.length - 1]
    if (!previous || previous.role !== item.role) {
      merged.push(item)
      continue
    }
    const previousContent = Array.isArray(previous.content) ? previous.content : [{ type: 'text', text: String(previous.content ?? '') }]
    const currentContent = Array.isArray(item.content) ? item.content : [{ type: 'text', text: String(item.content ?? '') }]
    previous.content = [...previousContent, ...currentContent]
  }
  return { system, messages: merged }
}

function anthropicUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '')
  if (/\/v1\/messages$/i.test(normalized) || /\/messages$/i.test(normalized)) return normalized
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`
  return `${normalized}/v1/messages`
}

function openAiChatUrl(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`
}

/** Provider adapter for OpenAI-compatible chat and Anthropic Messages APIs. */
export function createModelAdapter(options: ModelAdapterOptions): ModelAdapter
export function createModelAdapter(endpoint: string, model: string, providerId?: string, protocol?: LlmProtocol): ModelAdapter
export function createModelAdapter(
  input: ModelAdapterOptions | string,
  model?: string,
  providerId?: string,
  protocol?: LlmProtocol
): ModelAdapter {
  const options = optionValues(input, model, providerId, protocol)
  const capabilities = modelCapabilities(options)
  return {
    capabilities,
    buildRequest(requestInput) {
      const requestProtocol = requestInput.protocol && requestInput.protocol !== 'auto'
        ? requestInput.protocol
        : capabilities.protocol || 'openai-chat'
      if (requestProtocol === 'anthropic-messages') {
        const converted = anthropicMessages(requestInput.messages)
        const stream = requestInput.stream !== false
        const body: Record<string, unknown> = {
          model: requestInput.model,
          max_tokens: requestInput.maxTokens,
          stream,
          messages: converted.messages,
          ...(requestInput.tools.length > 0 ? { tools: requestInput.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
          ...(requestInput.providerId === 'minimax' || capabilities.providerId === 'minimax' ? { temperature: 0.01 } : {})
        }
        if (converted.system) body.system = converted.system
        return {
          url: anthropicUrl(requestInput.endpoint),
          init: {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'anthropic-version': '2023-06-01',
              'x-api-key': requestInput.apiKey.trim(),
              Authorization: `Bearer ${requestInput.apiKey.trim()}`
            },
            body: JSON.stringify(body)
          }
        }
      }
      const stream = requestInput.stream !== false
      const body: Record<string, unknown> = {
        model: requestInput.model,
        messages: requestInput.messages.map(openAiChatMessage),
        stream,
        max_tokens: requestInput.maxTokens,
        ...(requestInput.providerId === 'minimax' || capabilities.providerId === 'minimax' ? { temperature: 0.01 } : {}),
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...buildProviderThinkingFields(requestInput.model)
      }
      if (requestInput.tools.length > 0 && capabilities.nativeToolCalls) {
        body.tools = requestInput.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
      }
      return {
        url: openAiChatUrl(requestInput.endpoint),
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${requestInput.apiKey.trim()}` },
          body: JSON.stringify(body)
        }
      }
    },
    normalizeEvent: capabilities.protocol === 'anthropic-messages' ? normalizeAnthropicPayload : normalizeOpenAiPayload,
    normalizeError(error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }
}

/** Pure capability probe used by routing/tests; it never calls an unconfigured provider. */
export function probeModelCapabilities(endpoint: string, model: string, providerId?: string, protocol?: LlmProtocol): ModelCapabilities {
  return modelCapabilities({ endpoint, model, providerId, protocol })
}
