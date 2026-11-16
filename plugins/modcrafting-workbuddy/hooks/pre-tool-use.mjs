#!/usr/bin/env node
/**
 * PreToolUse hook: keep the "one explicit session per task" rule enforceable, and ask once before
 * operations that can destroy user-visible state.
 *
 * It only ever *adds* sessionId. Overwriting projectPath, spec, command or any other semantic
 * field from a hook would let a stale cache silently redirect a real action.
 *
 * When no session is known it stays silent on purpose: the MCP server returns SESSION_REQUIRED
 * with a remediation the model can act on, which is more useful than an opaque hook denial.
 */
import { dataRoot, guarded, readPayload } from './lib/context.mjs'
import { HIGH_RISK, NEEDS_SESSION, isUuid, readState, usableSession } from './lib/tools.mjs'

/** Host tool names are namespaced: mcp__modcrafting-fabric__<tool>. */
function toolName(raw) {
  if (typeof raw !== 'string') return ''
  const index = raw.lastIndexOf('__')
  return index >= 0 ? raw.slice(index + 2) : raw
}

guarded(async () => {
  const payload = await readPayload()
  const name = toolName(payload.tool_name ?? payload.toolName)
  if (!name) return
  const root = dataRoot()
  const input = { ...(payload.tool_input ?? payload.toolInput ?? payload.arguments ?? {}) }

  let modified
  if (NEEDS_SESSION.has(name) && !isUuid(input.sessionId)) {
    const state = readState(root)
    if (state && usableSession(root, state.sessionId)) { input.sessionId = state.sessionId; modified = input }
  }

  const reason = HIGH_RISK[name]
  if (!modified && !reason) return

  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    ...(reason ? { permissionDecision: 'ask', permissionDecisionReason: reason } : {}),
    ...(modified ? { modifiedInput: modified } : {})
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput }))
})
