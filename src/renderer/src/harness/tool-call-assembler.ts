import type { FinalizedToolCall, LlmProtocol, NormalizedModelEvent, NormalizedToolCallEvent, ProviderProtocolDiagnostic } from '../../../shared/harness-runtime.ts'

interface MutableToolCall {
  order: number
  providerIndex?: number
  providerId?: string
  name: string
  rawArguments: string
  ended: boolean
}

function looksUnclosedJson(raw: string): boolean {
  const text = raw.trim()
  if (!text) return true
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    if (ch === '}' || ch === ']') depth--
  }
  return inString || depth > 0
}

export interface ToolCallAssemblerOptions {
  protocol?: LlmProtocol
  modelId?: string
  providerId?: string
}

/**
 * Correlates provider stream fragments before the Agent sees a tool call.
 * OpenAI-compatible providers commonly send `id`/`name` only on the first
 * chunk and `index`/argument fragments afterwards.  Both identifiers are
 * aliases for one mutable record; neither is replaced by a synthetic ID.
 */
export class ToolCallAssembler {
  private readonly byIndex = new Map<number, MutableToolCall>()
  private readonly byId = new Map<string, MutableToolCall>()
  private readonly records: MutableToolCall[] = []
  private readonly diagnostics: ProviderProtocolDiagnostic[] = []
  private readonly options: ToolCallAssemblerOptions

  constructor(options: ToolCallAssemblerOptions = {}) {
    this.options = options
  }

  private merge(target: MutableToolCall, source: MutableToolCall): MutableToolCall {
    if (target === source) return target
    if (target.providerIndex == null) target.providerIndex = source.providerIndex
    if (!target.providerId) target.providerId = source.providerId
    if (!target.name) target.name = source.name
    if (source.rawArguments) target.rawArguments += source.rawArguments
    target.ended = target.ended || source.ended
    const sourceIndex = this.records.indexOf(source)
    if (sourceIndex >= 0) this.records.splice(sourceIndex, 1)
    if (target.providerIndex != null) this.byIndex.set(target.providerIndex, target)
    if (target.providerId) this.byId.set(target.providerId, target)
    return target
  }

  private resolve(ref: NormalizedToolCallEvent): MutableToolCall {
    const byIndex = ref.providerIndex == null ? undefined : this.byIndex.get(ref.providerIndex)
    const byId = ref.providerId ? this.byId.get(ref.providerId) : undefined
    let record = byIndex || byId
    // Some XML/legacy providers omit both identifiers but stream one tool call
    // at a time. Continue the newest open record instead of creating one
    // synthetic record per argument chunk; a local ID is generated only at
    // finish(). Parallel calls without any correlation key remain inherently
    // ambiguous and are reported as one sequential stream.
    if (!record && ref.providerIndex == null && !ref.providerId) {
      record = [...this.records].reverse().find((candidate) => !candidate.ended)
    }
    // A few OpenAI-compatible gateways put the id/name in the first chunk
    // but omit its index, then put only the index on subsequent argument
    // chunks.  When there is exactly one unindexed call still open, the
    // index is an alias for that record.  If several calls are open we leave
    // them separate rather than guessing across parallel tool calls.
    if (!record && ref.providerIndex != null && !ref.providerId) {
      const unindexedOpen = this.records.filter((candidate) => !candidate.ended && candidate.providerIndex == null)
      if (unindexedOpen.length === 1) record = unindexedOpen[0]
    }
    if (byIndex && byId && byIndex !== byId) record = this.merge(byIndex, byId)
    if (!record) {
      record = {
        order: this.records.length,
        providerIndex: ref.providerIndex,
        providerId: ref.providerId,
        name: '',
        rawArguments: '',
        ended: false
      }
      this.records.push(record)
    }
    if (ref.providerIndex != null) {
      const existing = this.byIndex.get(ref.providerIndex)
      record = existing && existing !== record ? this.merge(existing, record) : record
      this.byIndex.set(ref.providerIndex, record)
      record.providerIndex = ref.providerIndex
    }
    if (ref.providerId) {
      const existing = this.byId.get(ref.providerId)
      record = existing && existing !== record ? this.merge(existing, record) : record
      this.byId.set(ref.providerId, record)
      record.providerId = ref.providerId
    }
    return record
  }

  add(event: NormalizedModelEvent): void {
    if (!event.toolCall || !event.type.startsWith('tool_call_')) return
    const record = this.resolve(event.toolCall)
    const name = event.toolCall.nameDelta || ''
    if (name) {
      // OpenAI sends the complete name once; providers that stream the name
      // send a prefix. Avoid duplicating a repeated complete name.
      if (!record.name) record.name = name
      else if (record.name !== name && !name.startsWith(record.name)) record.name += name
    }
    if (event.toolCall.argumentsDelta) record.rawArguments += event.toolCall.argumentsDelta
    if (event.type === 'tool_call_end') record.ended = true
  }

  private diagnostic(record: MutableToolCall, kind: ProviderProtocolDiagnostic['kind'], message: string): void {
    this.diagnostics.push({
      id: `${kind}:${record.providerIndex ?? record.providerId ?? record.order}`,
      providerId: this.options.providerId,
      modelId: this.options.modelId || 'unknown',
      protocol: this.options.protocol,
      kind,
      message,
      toolName: record.name || undefined,
      providerIndex: record.providerIndex,
      providerCallId: record.providerId,
      rawArgumentLength: record.rawArguments.length,
      createdAt: Date.now()
    })
  }

  finish(finishReason?: string): FinalizedToolCall[] {
    const truncated = finishReason === 'length' || finishReason === 'max_tokens'
    return [...this.records]
      .sort((a, b) => a.providerIndex != null && b.providerIndex != null
        ? a.providerIndex - b.providerIndex
        : a.order - b.order)
      .map((record, index) => {
        const id = record.providerId || `${this.options.providerId || 'provider'}_tool_${record.providerIndex ?? index}`
        const rawArguments = record.rawArguments
        const incompleteReason = truncated
          ? `Provider stopped at output limit while assembling ${record.name || 'unknown'} tool arguments.`
          : !record.name
            ? 'Provider emitted tool arguments without a tool name.'
            : !rawArguments.trim()
              ? `Provider emitted ${record.name} without argument JSON.`
              : undefined
        if (incompleteReason) {
          this.diagnostic(record, 'arguments_incomplete', incompleteReason)
          return {
            id,
            name: record.name,
            args: {},
            rawArguments: rawArguments || '{}',
            protocol: this.options.protocol,
            providerIndex: record.providerIndex,
            providerId: record.providerId,
            complete: false,
            failureKind: 'arguments_incomplete'
          } satisfies FinalizedToolCall
        }
        try {
          const parsed = JSON.parse(rawArguments) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be an object')
          return {
            id,
            name: record.name,
            args: parsed as Record<string, unknown>,
            rawArguments,
            protocol: this.options.protocol,
            providerIndex: record.providerIndex,
            providerId: record.providerId,
            complete: true
          } satisfies FinalizedToolCall
        } catch (error) {
          const failureKind = looksUnclosedJson(rawArguments) ? 'arguments_incomplete' : 'arguments_invalid'
          this.diagnostic(record, failureKind, String(error))
          return {
            id,
            name: record.name,
            args: {},
            rawArguments,
            protocol: this.options.protocol,
            providerIndex: record.providerIndex,
            providerId: record.providerId,
            complete: false,
            failureKind
          } satisfies FinalizedToolCall
        }
      })
  }

  getDiagnostics(): ProviderProtocolDiagnostic[] {
    return [...this.diagnostics]
  }
}

export function assembleToolCalls(
  events: NormalizedModelEvent[],
  options?: ToolCallAssemblerOptions,
  finishReason?: string
): FinalizedToolCall[] {
  const assembler = new ToolCallAssembler(options)
  for (const event of events) assembler.add(event)
  return assembler.finish(finishReason)
}
