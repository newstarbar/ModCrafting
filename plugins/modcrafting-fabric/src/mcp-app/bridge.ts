/**
 * Minimal AppBridge for MCP Apps widgets.
 *
 * Deliberately dependency-free (the widget bundle must not reference anything outside the
 * package) and deliberately tolerant: hosts differ in where they put the tool result, so instead
 * of hard-coding one envelope we search the incoming message for a structuredContent-shaped
 * object. The widget never calls back into the server, so no request/response machinery is needed.
 */
export type Payload = Record<string, unknown>

const isObject = (value: unknown): value is Payload => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function findPayload(value: unknown, depth = 0): Payload | undefined {
  if (depth > 5 || !isObject(value)) return undefined
  if (isObject(value.structuredContent)) return value.structuredContent
  if (isObject(value.result)) { const found = findPayload(value.result, depth + 1); if (found) return found }
  if (isObject(value.params)) { const found = findPayload(value.params, depth + 1); if (found) return found }
  if (isObject(value.data)) { const found = findPayload(value.data, depth + 1); if (found) return found }
  if (isObject(value.message)) { const found = findPayload(value.message, depth + 1); if (found) return found }
  return undefined
}

function applyTheme(theme: unknown) {
  if (theme !== 'light' && theme !== 'dark') return
  document.documentElement.style.colorScheme = theme
  document.body.dataset.theme = theme
}

export function connectWidget(render: (payload: Payload) => void) {
  const handle = (candidate: unknown) => {
    const payload = findPayload(candidate)
    if (payload) render(payload)
  }
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    if (!isObject(data)) return
    const method = typeof data.method === 'string' ? data.method : ''
    if (/host-context-changed|theme/i.test(method)) {
      const params = isObject(data.params) ? data.params : data
      applyTheme(params.theme ?? (isObject(params.hostContext) ? params.hostContext.theme : undefined))
    }
    handle(data)
  })
  // Best-effort handshake: if the host speaks the AppBridge protocol it will answer with the
  // current tool result; if it does not, the widget simply stays in its placeholder state.
  try {
    window.parent?.postMessage({ jsonrpc: '2.0', id: 'modcrafting-init', method: 'ui/initialize', params: { protocolVersion: '1.0', appInfo: { name: 'modcrafting-widget', version: '1' } } }, '*')
  } catch { /* sandbox without a parent */ }
  const injected = (window as unknown as { __MODCRAFTING_TOOL_RESULT__?: unknown }).__MODCRAFTING_TOOL_RESULT__
  if (injected) handle(injected)
}
