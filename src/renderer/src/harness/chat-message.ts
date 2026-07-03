export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: string
  content: string
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
    tool_calls: calls.map(modelToolCallToChatToolCall)
  }
}

export function toolResultMessage(call: Pick<ModelToolCall, 'id' | 'name'>, output: string): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.name,
    content: output
  }
}

export function appendToolRoundHistory(
  messages: ChatMessage[],
  streamContent: string,
  calls: ModelToolCall[],
  results: Map<string, { output: string }>,
  instruction?: string
): void {
  if (calls.length === 0) return
  messages.push(assistantToolCallMessage(streamContent, calls))
  for (const call of calls) {
    const result = results.get(call.id)
    messages.push(toolResultMessage(call, result?.output ?? ''))
  }
  if (instruction?.trim()) {
    messages.push({ role: 'system', content: instruction.trim() })
  }
}
