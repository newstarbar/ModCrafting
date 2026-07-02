import { parseMcLogs, type McPhase } from './mc-phase-parser'

export interface WaitForMcPlayingOptions {
  instanceId: string
  timeoutMs?: number
  abortSignal?: AbortSignal
}

export interface WaitForMcPlayingResult {
  ok: boolean
  phase: McPhase
  error?: string
}

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

function isFailureStatus(status: string, exitReason?: string): boolean {
  if (status === 'crashed') return true
  if (exitReason === 'crash' || exitReason === 'start_failed') return true
  return false
}

function isPlayingPhase(phase: McPhase, status: string): boolean {
  if (status === 'running') return true
  return phase === 'playing'
}

/** Wait until MC instance reaches playing phase or fails/times out. */
export function waitForMcPlaying(options: WaitForMcPlayingOptions): Promise<WaitForMcPlayingResult> {
  const { instanceId, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal } = options
  const logChunks: string[] = []
  let lastStatus = 'starting'
  let lastExitReason: string | undefined

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: WaitForMcPlayingResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const check = (): void => {
      const phaseInfo = parseMcLogs(logChunks, lastStatus)
      if (phaseInfo.hasError || phaseInfo.phase === 'error') {
        finish({ ok: false, phase: 'error', error: phaseInfo.summaryLine || '启动过程中出现错误' })
        return
      }
      if (isFailureStatus(lastStatus, lastExitReason)) {
        finish({
          ok: false,
          phase: 'error',
          error: lastExitReason === 'start_failed' ? '游戏启动失败' : '游戏崩溃'
        })
        return
      }
      if (isPlayingPhase(phaseInfo.phase, lastStatus)) {
        finish({ ok: true, phase: 'playing' })
      }
    }

    const unsubLog = window.api.onMcLog((id, text) => {
      if (id !== instanceId) return
      logChunks.push(text)
      check()
    })

    const unsubState = window.api.onMcStateChanged((id, state) => {
      if (id !== instanceId) return
      const s = state as { status?: string; exitReason?: string }
      if (s.status) lastStatus = s.status
      if (s.exitReason) lastExitReason = s.exitReason
      check()
    })

    const timer = window.setTimeout(() => {
      const phaseInfo = parseMcLogs(logChunks, lastStatus)
      finish({
        ok: false,
        phase: phaseInfo.phase,
        error: `等待游戏启动超时（${Math.round(timeoutMs / 60000)} 分钟）`
      })
    }, timeoutMs)

    const onAbort = (): void => {
      finish({ ok: false, phase: 'error', error: '已取消等待游戏启动' })
    }

    if (abortSignal?.aborted) {
      onAbort()
      return
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      unsubLog()
      unsubState()
      window.clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
    }

    check()
  })
}
