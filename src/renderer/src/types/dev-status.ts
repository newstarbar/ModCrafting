export interface BuildDevStatus {
  running: boolean
  failed?: boolean
}

export interface GameDevStatus {
  label: string
  variant: 'running' | 'starting' | 'crashed' | 'stopped' | 'idle'
}

export interface PhaseDevStatus {
  label: string
}

export type McRuntimeSlot =
  | { kind: 'idle' }
  | { kind: 'build'; label: string; running: boolean; failed?: boolean }
  | { kind: 'game'; label: string; variant: GameDevStatus['variant'] }
  | { kind: 'phase'; label: string }

export function pickMcRuntimeSlot(
  build: BuildDevStatus,
  game: GameDevStatus,
  phase: PhaseDevStatus | null
): McRuntimeSlot {
  if (build.running) {
    return { kind: 'build', label: '构建中', running: true }
  }
  if (build.failed) {
    return { kind: 'build', label: '构建失败', running: false, failed: true }
  }

  if (game.variant === 'running') {
    return { kind: 'game', label: game.label || '游戏运行中', variant: 'running' }
  }
  if (game.variant === 'starting') {
    return { kind: 'game', label: game.label || '启动中', variant: 'starting' }
  }
  if (game.variant === 'crashed') {
    return { kind: 'game', label: game.label || '已崩溃', variant: 'crashed' }
  }

  if (phase?.label) {
    return { kind: 'phase', label: phase.label }
  }

  if (game.variant === 'stopped' && game.label) {
    return { kind: 'game', label: game.label, variant: 'stopped' }
  }

  return { kind: 'idle' }
}
