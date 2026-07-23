export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI-compatible multimodal content parts. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: string
  content: string | ChatContentPart[]
  /** Internal provenance; stripped before sending to providers. */
  origin?: 'user' | 'assistant' | 'tool' | 'harness'
  taskId?: string
  phase?: 'chat' | 'plan' | 'execute'
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

/** Tool call from the model stream (native function calling or text fallback). */
export interface ModelToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  rawArguments: string
}

export function modelToolCallToChatToolCall(call: ModelToolCall): ChatToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.rawArguments || JSON.stringify(call.args)
    }
  }
}

export function assistantToolCallMessage(content: string, calls: ModelToolCall[]): ChatMessage {
  return {
    role: 'assistant',
    content: content || '',
    origin: 'assistant',
    tool_calls: calls.map(modelToolCallToChatToolCall)
  }
}

export function toolResultMessage(
  call: Pick<ModelToolCall, 'id' | 'name'>,
  output: string,
  image?: { base64: string; mimeType?: string }
): ChatMessage {
  if (image?.base64) {
    const mime = image.mimeType || 'image/png'
    const parts: ChatContentPart[] = [
      { type: 'text', text: output },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${image.base64}` } }
    ]
    return {
      role: 'tool',
      origin: 'tool',
      tool_call_id: call.id,
      name: call.name,
      content: parts
    }
  }
  return {
    role: 'tool',
    origin: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content: output
  }
}

export function contentAsText(content: string | ChatContentPart[] | undefined | null): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('\n')
}

export function isVisionCapableModel(model: string | undefined | null): boolean {
  if (!model) return false
  const m = model.toLowerCase()
  return (
    m.includes('gpt-4o') ||
    m.includes('gpt-4.1') ||
    m.includes('gpt-5') ||
    m.includes('claude-3') ||
    m.includes('claude-4') ||
    m.includes('claude-sonnet') ||
    m.includes('claude-opus') ||
    m.includes('gemini') ||
    m.includes('vision') ||
    m.includes('qwen-vl') ||
    m.includes('qwen2.5-vl') ||
    m.includes('glm-4v') ||
    m.includes('internvl')
  )
}

export function appendToolRoundHistory(
  messages: ChatMessage[],
  streamContent: string,
  calls: ModelToolCall[],
  results: Map<string, { output: string; imageBase64?: string; imageMimeType?: string }>,
  instruction?: string,
  opts?: { visionModel?: boolean }
): string | undefined {
  if (calls.length === 0) return instruction?.trim() || undefined
  messages.push(assistantToolCallMessage(streamContent, calls))
  for (const call of calls) {
    const result = results.get(call.id)
    const image =
      opts?.visionModel && result?.imageBase64
        ? { base64: result.imageBase64, mimeType: result.imageMimeType }
        : undefined
    messages.push(toolResultMessage(call, result?.output ?? '', image))
  }
  // Instruction is returned for the caller to attach ephemerally (e.g. next
  // user/workflow prompt). Do not push role:system into history — that breaks
  // prompt-cache prefixes.
  return instruction?.trim() || undefined
}
