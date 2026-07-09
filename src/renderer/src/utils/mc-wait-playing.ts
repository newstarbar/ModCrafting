import {
  formatMcLogTail,
  isMcHarnessReady,
  parseMcLogs,
  type McPhase
} from './mc-phase-parser.ts'

export interface WaitForMcPlayingOptions {
  instanceId: string
  timeoutMs?: number
  soakMs?: number
  abortSignal?: AbortSignal
}

export interface WaitForMcPlayingResult {
  ok: boolean
  phase: McPhase
  error?: string
  logTail?: string
}

export const MC_RUN_READY_SOAK_MS = 5000
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000

function isFailureStatus(status: string, exitReason?: string): boolean {
  if (status === 'crashed' || status === 'stopped') return true
  if (exitReason === 'crash' || exitReason === 'start_failed') return true
  return false
}

function failureMessage(lastStatus: string, lastExitReason: string | undefined, summary?: string): string {
  if (lastExitReason === 'start_failed') return '游戏启动失败'
  if (lastExitReason === 'crash' || lastStatus === 'crashed') return '游戏崩溃'
  return summary || '启动过程中出现错误'
}

function evaluateFailure(
  logChunks: string[],
  lastStatus: string,
  lastExitReason: string | undefined
): WaitForMcPlayingResult | null {
  const phaseInfo = parseMcLogs(logChunks, lastStatus)
  if (phaseInfo.hasError || phaseInfo.phase === 'error') {
    return {
      ok: false,
      phase: 'error',
      error: phaseInfo.summaryLine || '启动过程中出现错误',
      logTail: formatMcLogTail(logChunks)
    }
  }
  if (isFailureStatus(lastStatus, lastExitReason)) {
    return {
      ok: false,
      phase: 'error',
      error: failureMessage(lastStatus, lastExitReason, phaseInfo.summaryLine),
      logTail: formatMcLogTail(logChunks)
    }
  }
  return null
}

/** Wait until MC instance reaches harness-ready (main menu) + stable soak period. */
export function waitForMcRunReady(options: WaitForMcPlayingOptions): Promise<WaitForMcPlayingResult> {
  const {
    instanceId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    soakMs = MC_RUN_READY_SOAK_MS,
    abortSignal
  } = options
  const logChunks: string[] = []
  let lastStatus = 'starting'
  let lastExitReason: string | undefined
  let soakTimer: ReturnType<typeof window.setTimeout> | null = null

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: WaitForMcPlayingResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const clearSoak = (): void => {
      if (soakTimer != null) {
        window.clearTimeout(soakTimer)
        soakTimer = null
      }
    }

    const startSoak = (): void => {
      if (soakTimer != null) return
      soakTimer = window.setTimeout(() => {
        const failure = evaluateFailure(logChunks, lastStatus, lastExitReason)
        if (failure) {
          finish(failure)
          return
        }
        finish({ ok: true, phase: 'ready' })
      }, soakMs)
    }

    const check = (): void => {
      const failure = evaluateFailure(logChunks, lastStatus, lastExitReason)
      if (failure) {
        clearSoak()
        finish(failure)
        return
      }
      if (isMcHarnessReady(logChunks, lastStatus)) {
        startSoak()
      } else {
        clearSoak()
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
        error: `等待游戏启动超时（${Math.round(timeoutMs / 60000)} 分钟）`,
        logTail: formatMcLogTail(logChunks)
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
      clearSoak()
      abortSignal?.removeEventListener('abort', onAbort)
    }

    check()
  })
}

/** @deprecated Use waitForMcRunReady for harness / agent run-step advancement. */
export function waitForMcPlaying(options: WaitForMcPlayingOptions): Promise<WaitForMcPlayingResult> {
  return waitForMcRunReady(options)
}
