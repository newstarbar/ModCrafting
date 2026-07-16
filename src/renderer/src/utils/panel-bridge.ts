import type { McPhase } from './mc-phase-parser'

export type RightPanelTab = 'game' | 'advanced'

export interface BuildPanelResult {
  ok: boolean
  exitCode: number
  failed: boolean
}

export interface GamePanelResult {
  ok: boolean
  instanceId: string
  phase: McPhase
  error?: string
}

export type BuildProgressCallback = (chunk: string) => void

export interface PanelBridgeHandlers {
  runBuild: () => Promise<BuildPanelResult>
  startGameAndWait: () => Promise<GamePanelResult>
  switchTab: (tab: RightPanelTab) => void
}

let handlers: PanelBridgeHandlers | null = null
let lastBuildLogText = ''
let activeBuildProgress: BuildProgressCallback | null = null

export function setLastBuildLogText(text: string): void {
  lastBuildLogText = text
}

export function getLastBuildLogText(): string {
  return lastBuildLogText
}

/** Forward Gradle/panel build chunks into the active chat tool card. */
export function emitBuildProgress(chunk: string): void {
  if (!chunk || !activeBuildProgress) return
  activeBuildProgress(chunk.endsWith('\n') ? chunk : `${chunk}\n`)
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(resolve, ms)
      return
    }
    resolve()
  })
}

export function registerPanelBridge(next: PanelBridgeHandlers | null): void {
  handlers = next
}

export function isPanelBridgeRegistered(): boolean {
  return handlers !== null
}

export async function runBuildViaPanel(onProgress?: BuildProgressCallback): Promise<BuildPanelResult> {
  if (!handlers) {
    return { ok: false, exitCode: 1, failed: true }
  }
  const prev = activeBuildProgress
  activeBuildProgress = onProgress || null
  handlers.switchTab('advanced')
  await delayMs(150)
  onProgress?.('开始构建…\n')
  try {
    return await handlers.runBuild()
  } finally {
    activeBuildProgress = prev
  }
}

export async function startGameViaPanel(): Promise<GamePanelResult> {
  if (!handlers) {
    return { ok: false, instanceId: '', phase: 'error', error: 'Panel bridge not registered' }
  }
  handlers.switchTab('game')
  await delayMs(150)
  return handlers.startGameAndWait()
}
