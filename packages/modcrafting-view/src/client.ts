import type { BrowserAction } from '../../../plugins/modcrafting-fabric/src/browser-server.ts'
import type { CoreRuntimeState } from '../../modcrafting-core/src/contracts.ts'

const parameters = new URLSearchParams(location.hash.slice(1))
export const initialProject = parameters.get('project') || ''
export const initialView = parameters.get('view') || 'overview'
export const initialBackendId = parameters.get('backendId') || sessionStorage.getItem('modcrafting-view-backend') || ''
const fragment = parameters.get('token')
if (fragment) { sessionStorage.setItem('modcrafting-view-token', fragment); history.replaceState(null, '', location.pathname) }
if (initialBackendId) sessionStorage.setItem('modcrafting-view-backend', initialBackendId)
let activeSessionId = parameters.get('sessionId') || sessionStorage.getItem('modcrafting-view-session') || ''
if (activeSessionId) sessionStorage.setItem('modcrafting-view-session', activeSessionId)
const token = sessionStorage.getItem('modcrafting-view-token') || ''
let generation = 0
const inFlight = new Set<AbortController>()
export const currentSession = () => activeSessionId
export async function request<T>(route: string, action?: BrowserAction): Promise<T> {
  const requestGeneration = generation, controller = new AbortController(); inFlight.add(controller)
  const response = await fetch(route, { method: action ? 'POST' : 'GET', signal: controller.signal, headers: { authorization: `Bearer ${token}`, 'x-modcrafting-backend': initialBackendId, 'x-modcrafting-session': activeSessionId, ...(action ? { 'content-type': 'application/json' } : {}) }, body: action ? JSON.stringify(action) : undefined }).finally(() => inFlight.delete(controller))
  const value = await response.json()
  if (requestGeneration !== generation) throw new DOMException('已切换任务会话，忽略旧请求结果。', 'AbortError')
  if (!response.ok || value.ok === false) throw Error(`${value.code || value.data?.code || 'OPERATION_FAILED'}: ${value.error || value.data?.error || JSON.stringify(value)}`)
  return value
}
export const action = <T,>(value: BrowserAction) => request<T>('/api/action', value)
export async function uploadTextureSource(file: File): Promise<{ sourceToken: string; size: number }> {
  const response = await fetch('/api/texture-source', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-modcrafting-backend': initialBackendId, 'x-modcrafting-session': activeSessionId, 'content-type': 'image/png' },
    body: file
  })
  const value = await response.json()
  if (!response.ok || value.ok === false) throw Error(`${value.code || 'OPERATION_FAILED'}: ${value.error || JSON.stringify(value)}`)
  return value
}
export const state = () => request<CoreRuntimeState>('/api/state')
export async function selectSession(sessionId: string): Promise<boolean> {
  const selected = await action<{ readOnly: boolean }>({ operation: 'select_session', sessionId })
  generation++
  for (const controller of inFlight) controller.abort()
  inFlight.clear()
  activeSessionId = sessionId
  sessionStorage.setItem('modcrafting-view-session', sessionId)
  return selected.readOnly
}
