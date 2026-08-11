import type { ToolResult } from './tools.ts'

function normalizeRejectedDetail(value: string): string {
  const fragments = value
    .replace(/\/steps\/\d+/g, '/steps/*')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  return [...new Set(fragments)].sort().join(';')
}

export function rejectedToolCallSignature(results: Iterable<ToolResult>): string {
  return [...results]
    .map((result) => `${result.toolName || 'unknown'}:${result.errorKind || 'rejected'}:${normalizeRejectedDetail(result.output)}`)
    .sort()
    .join('|')
}
