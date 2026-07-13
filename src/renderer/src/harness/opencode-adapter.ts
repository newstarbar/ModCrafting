import { EventKind, type Event, type Sink } from './events.ts'

export interface OpenCodeAdapterOptions {
  sink: Sink
  onStatus?: (status: string) => void
}

export interface OpenCodeDelegateResult {
  ok: boolean
  sessionId?: string
  output?: string
  error?: string
}

/**
 * Bridges ModCrafting harness events to OpenCode server via main-process IPC.
 * Used in execute-phase write delegation (Phase 4 PoC).
 */
export class OpenCodeAdapter {
  private sink: Sink
  private onStatus?: (status: string) => void
  private eventUnsub: (() => void) | null = null
  private sessionId: string | null = null

  constructor(options: OpenCodeAdapterOptions) {
    this.sink = options.sink
    this.onStatus = options.onStatus
  }

  private emit(event: Event): void {
    this.sink.emit(event)
  }

  async detect(): Promise<{ installed: boolean; version?: string; error?: string }> {
    return window.api.opencodeDetect()
  }

  async openExternal(projectPath: string): Promise<{ success: boolean; error?: string }> {
    return window.api.opencodeOpenProject(projectPath)
  }

  async ensureServer(projectPath: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    this.onStatus?.('启动 OpenCode 服务…')
    const state = await window.api.opencodeServerStart(projectPath)
    if (!state.running) {
      return { ok: false, error: state.error || 'server start failed' }
    }
    return { ok: true, url: state.url }
  }

  async stopServer(): Promise<void> {
    this.detachEvents()
    await window.api.opencodeServerStop()
    this.sessionId = null
  }

  attachEvents(): void {
    this.detachEvents()
    this.eventUnsub = window.api.onOpenCodeEvent((payload) => {
      this.handleServerEvent(payload)
    })
  }

  detachEvents(): void {
    this.eventUnsub?.()
    this.eventUnsub = null
  }

  private handleServerEvent(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const evt = payload as { type?: string; properties?: Record<string, unknown> }
    const type = evt.type || ''
    const props = evt.properties || {}

    if (type.includes('message') || type.includes('part')) {
      const text = String(props.text || props.content || props.delta || '')
      if (text) {
        this.emit({ kind: EventKind.Text, text })
      }
    }

    if (type.includes('tool') || type.includes('permission')) {
      this.emit({
        kind: EventKind.Notice,
        notice: {
          level: 'info',
          text: `[OpenCode] ${type}: ${JSON.stringify(props).slice(0, 500)}`
        }
      })
    }
  }

  async delegateWriteTask(projectPath: string, instruction: string): Promise<OpenCodeDelegateResult> {
    try {
      const server = await this.ensureServer(projectPath)
      if (!server.ok) return { ok: false, error: server.error }

      this.attachEvents()

      if (!this.sessionId) {
        const created = await window.api.opencodeSessionCreate('ModCrafting write delegate')
        if (!created.id) return { ok: false, error: created.error || 'session create failed' }
        this.sessionId = created.id
      }

      this.onStatus?.('OpenCode 执行中…')
      this.emit({ kind: EventKind.Phase, phase: 'execute_start' })

      const result = await window.api.opencodeSessionPrompt(this.sessionId, instruction, 'build')
      if (!result.ok) {
        return { ok: false, sessionId: this.sessionId, error: result.error }
      }

      const output = typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data ?? {}).slice(0, 4000)

      this.emit({ kind: EventKind.Message, text: output })
      return { ok: true, sessionId: this.sessionId, output }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async abort(): Promise<void> {
    if (this.sessionId) {
      await window.api.opencodeSessionAbort(this.sessionId).catch(() => {})
    }
  }
}
