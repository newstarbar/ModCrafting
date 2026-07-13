import { EventKind, type Event, type Sink } from './events.ts'

export interface OpenCodeAdapterOptions {
  sink: Sink
  onStatus?: (status: string) => void
  getModel?: () => string
}

export interface OpenCodeDelegateResult {
  ok: boolean
  sessionId?: string
  output?: string
  error?: string
  evidenceOk?: boolean
  changedPaths?: string[]
}

const ZEN_HINT =
  '请先在本机运行 opencode 登录 Zen（免费模型），或在工具面板关闭「用 OpenCode 写码」。'

/**
 * Bridges ModCrafting harness events to OpenCode server via main-process IPC.
 * Used in execute-phase write delegation.
 */
export class OpenCodeAdapter {
  private sink: Sink
  private onStatus?: (status: string) => void
  private getModel?: () => string
  private eventUnsub: (() => void) | null = null
  private sessionId: string | null = null
  private projectPath: string | null = null

  constructor(options: OpenCodeAdapterOptions) {
    this.sink = options.sink
    this.onStatus = options.onStatus
    this.getModel = options.getModel
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
    this.projectPath = projectPath
    const model = this.getModel?.() || 'opencode/deepseek-v4-flash-free'
    const state = await window.api.opencodeServerStart(projectPath, { model })
    if (!state.running) {
      const err = state.error || 'server start failed'
      const hint = /not installed|未检测|ENOENT|not found/i.test(err)
        ? err
        : `${err}。${ZEN_HINT}`
      return { ok: false, error: hint }
    }
    this.onStatus?.(`OpenCode 已就绪 (${state.version || 'ok'})`)
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
    if (typeof payload === 'string') {
      this.onStatus?.(`OpenCode: ${payload.slice(0, 80)}`)
      return
    }
    const evt = payload as { type?: string; properties?: Record<string, unknown> }
    const type = evt.type || ''
    const props = evt.properties || {}

    if (/tool/i.test(type)) {
      const name = String(props.name || props.tool || props.id || type)
      this.onStatus?.(`OpenCode: ${name}`)
      this.emit({
        kind: EventKind.Notice,
        notice: {
          level: 'info',
          text: `[OpenCode] ${type}: ${name}`
        }
      })
      return
    }

    if (/permission/i.test(type)) {
      this.emit({
        kind: EventKind.Notice,
        notice: {
          level: 'info',
          text: `[OpenCode] 权限请求：${JSON.stringify(props).slice(0, 300)}（依赖 OpenCode 默认策略）`
        }
      })
      return
    }

    if (type.includes('message') || type.includes('part')) {
      const text = String(props.text || props.content || props.delta || '')
      if (text) {
        this.emit({ kind: EventKind.Text, text })
      }
    }

    if (/error|fail/i.test(type)) {
      this.emit({
        kind: EventKind.Notice,
        notice: {
          level: 'warn',
          text: `[OpenCode] ${type}: ${JSON.stringify(props).slice(0, 400)}`
        }
      })
    }
  }

  private async snapshotSources(projectPath: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const roots = ['src', 'gradle']
    for (const root of roots) {
      await this.walkFiles(projectPath, root, map, 0)
    }
    // Also track fabric.mod.json
    try {
      const modJson = `${projectPath}/src/main/resources/fabric.mod.json`
      const res = await window.api.readFile(modJson)
      if (res.success && typeof res.content === 'string') {
        map.set('src/main/resources/fabric.mod.json', res.content)
      }
    } catch {
      // ignore
    }
    return map
  }

  private async walkFiles(
    projectPath: string,
    rel: string,
    map: Map<string, string>,
    depth: number
  ): Promise<void> {
    if (depth > 8 || map.size > 200) return
    try {
      const entries = await window.api.listDirectory(`${projectPath}/${rel}`)
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory) {
          if (entry.name === 'build' || entry.name === '.gradle' || entry.name === 'run') continue
          await this.walkFiles(projectPath, childRel, map, depth + 1)
        } else if (/\.(java|json|gradle|properties|kts)$/i.test(entry.name)) {
          const res = await window.api.readFile(`${projectPath}/${childRel}`)
          if (res.success && typeof res.content === 'string') {
            map.set(childRel.replace(/\\/g, '/'), res.content)
          }
        }
      }
    } catch {
      // missing dir
    }
  }

  private diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
    const changed: string[] = []
    for (const [path, content] of after) {
      if (before.get(path) !== content) changed.push(path)
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changed.push(path)
    }
    return changed
  }

  private async verifyTargetPath(projectPath: string, targetPath: string): Promise<boolean> {
    const abs = `${projectPath}/${targetPath.replace(/\\/g, '/')}`
    try {
      return await window.api.exists(abs)
    } catch {
      return false
    }
  }

  async delegateWriteTask(
    projectPath: string,
    instruction: string,
    targetPath?: string
  ): Promise<OpenCodeDelegateResult> {
    try {
      const server = await this.ensureServer(projectPath)
      if (!server.ok) return { ok: false, error: server.error }

      this.attachEvents()

      const before = await this.snapshotSources(projectPath)

      if (!this.sessionId) {
        const created = await window.api.opencodeSessionCreate('ModCrafting write delegate')
        if (!created.id) return { ok: false, error: created.error || 'session create failed' }
        this.sessionId = created.id
      }

      this.onStatus?.('OpenCode 执行中…')
      this.emit({ kind: EventKind.Phase, phase: 'execute_start' })

      const enriched =
        instruction +
        '\n\n约束：只修改当前 Fabric 模组项目内文件；优先最小改动；完成后确保目标路径存在。'

      const result = await window.api.opencodeSessionPrompt(this.sessionId, enriched, 'build')
      if (!result.ok) {
        const err = result.error || 'prompt failed'
        return {
          ok: false,
          sessionId: this.sessionId,
          error: /auth|login|unauthorized|401|403|zen/i.test(err) ? `${err}。${ZEN_HINT}` : err
        }
      }

      const output = typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data ?? {}).slice(0, 4000)

      const after = await this.snapshotSources(projectPath)
      const changedPaths = this.diffSnapshots(before, after)

      let evidenceOk = changedPaths.length > 0
      if (targetPath) {
        const exists = await this.verifyTargetPath(projectPath, targetPath)
        const touched = changedPaths.some(
          (p) => p.replace(/\\/g, '/') === targetPath.replace(/\\/g, '/') ||
            p.replace(/\\/g, '/').endsWith(targetPath.replace(/\\/g, '/'))
        )
        evidenceOk = exists && (touched || changedPaths.length > 0)
      }

      if (output) {
        this.emit({ kind: EventKind.Message, text: output })
      }

      if (!evidenceOk) {
        this.onStatus?.('OpenCode 无文件变更证据')
        return {
          ok: false,
          sessionId: this.sessionId,
          output,
          evidenceOk: false,
          changedPaths,
          error: targetPath
            ? `委托完成但未验证到目标文件变更：${targetPath}`
            : '委托完成但未检测到 src/ 下文件变更'
        }
      }

      this.onStatus?.(`OpenCode 已改 ${changedPaths.length} 个文件`)
      return {
        ok: true,
        sessionId: this.sessionId,
        output,
        evidenceOk: true,
        changedPaths
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: /fetch failed|ECONNREFUSED|unauthorized|401/i.test(msg) ? `${msg}。${ZEN_HINT}` : msg
      }
    }
  }

  async abort(): Promise<void> {
    if (this.sessionId) {
      await window.api.opencodeSessionAbort(this.sessionId).catch(() => {})
    }
    await this.stopServer().catch(() => {})
  }
}
