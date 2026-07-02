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

export interface PanelBridgeHandlers {
  runBuild: () => Promise<BuildPanelResult>
  startGameAndWait: () => Promise<GamePanelResult>
  switchTab: (tab: RightPanelTab) => void
}

let handlers: PanelBridgeHandlers | null = null

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

export async function runBuildViaPanel(): Promise<BuildPanelResult> {
  if (!handlers) {
    return { ok: false, exitCode: 1, failed: true }
  }
  handlers.switchTab('advanced')
  await delayMs(150)
  return handlers.runBuild()
}

export async function startGameViaPanel(): Promise<GamePanelResult> {
  if (!handlers) {
    return { ok: false, instanceId: '', phase: 'error', error: 'Panel bridge not registered' }
  }
  handlers.switchTab('game')
  await delayMs(150)
  return handlers.startGameAndWait()
}
