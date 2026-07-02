import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { IconGamepad } from './Icon'
import { logger } from '../utils/logger'
import { parseMcLogs, PHASE_LABELS, PHASE_ORDER, phaseStepIndex, splitLogChunks } from '../utils/mc-phase-parser'
import { waitForMcPlaying } from '../utils/mc-wait-playing'

export type McExitReason = 'none' | 'normal' | 'crash' | 'manual' | 'start_failed'

interface McInstanceView {
  id: string
  name: string
  status: string
  projectPath: string
  startedAt: string | null
  crashedAt: string | null
  crashReportPath: string | null
  exitReason?: McExitReason
  logLength: number
}

import type { GameDevStatus, PhaseDevStatus } from '../types/dev-status'

interface McRuntimePanelProps {
  projectPath: string | null
  onAddCrashToChat: (crashContent: string) => void
  toolchainReady?: boolean
  onRuntimeStatusChange?: (game: GameDevStatus, phase: PhaseDevStatus | null) => void
}

export interface GameStartWaitResult {
  instanceId: string
  ok: boolean
  error?: string
}

export interface McRuntimePanelHandle {
  startDefaultForProject: () => Promise<void>
  startDefaultAndWait: () => Promise<GameStartWaitResult>
  stopAllRunning: () => Promise<void>
}

function statusBadge(inst: McInstanceView): { label: string; className: string } {
  const reason = inst.exitReason ?? 'none'
  if (inst.status === 'running') return { label: '运行中', className: 'mc-badge--running' }
  if (inst.status === 'starting' || inst.status === 'stopping') {
    return { label: inst.status === 'starting' ? '启动中' : '停止中', className: 'mc-badge--starting' }
  }
  if (inst.status === 'crashed' || reason === 'crash' || reason === 'start_failed') {
    return { label: reason === 'start_failed' ? '启动失败' : '已崩溃', className: 'mc-badge--crashed' }
  }
  if (reason === 'manual') return { label: '已手动停止', className: 'mc-badge--stopped' }
  if (reason === 'normal') return { label: '已正常退出', className: 'mc-badge--normal' }
  return { label: '已停止', className: 'mc-badge--stopped' }
}

const McRuntimePanel = forwardRef<McRuntimePanelHandle, McRuntimePanelProps>(
  ({ projectPath, onAddCrashToChat, toolchainReady = true, onRuntimeStatusChange }, ref) => {
    const [instances, setInstances] = useState<McInstanceView[]>([])
    const [logs, setLogs] = useState<Map<string, string[]>>(new Map())
    const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set())
    const [crashMessage, setCrashMessage] = useState<{ id: string; code: number; path: string | null } | null>(null)
    const instanceCounterRef = useRef(0)

    useEffect(() => {
      const unsubState = window.api.onMcStateChanged((id, state) => {
        const s = state as McInstanceView
        setInstances((prev) => {
          const existing = prev.findIndex((i) => i.id === id)
          if (existing >= 0) {
            const next = [...prev]
            next[existing] = s
            return next
          }
          return [...prev, s]
        })
      })

      const unsubLog = window.api.onMcLog((id, text) => {
        setLogs((prev) => {
          const next = new Map(prev)
          const existing = next.get(id) || []
          const newLines = text.split(/\r?\n/).filter((l) => l.length > 0)
          const updated = [...existing, ...(newLines.length > 0 ? newLines : [text])].slice(-500)
          next.set(id, updated)
          return next
        })
      })

      const unsubCrash = window.api.onMcCrashed((id, code, crashReportPath) => {
        setCrashMessage({ id, code, path: crashReportPath })
      })

      window.api.mcListInstances().then((list) => {
        setInstances(list as McInstanceView[])
      })

      return () => {
        unsubState()
        unsubLog()
        unsubCrash()
      }
    }, [])

    const projectInstances = projectPath
      ? instances.filter((i) => i.projectPath === projectPath)
      : instances

    const onRuntimeStatusChangeRef = useRef(onRuntimeStatusChange)
    onRuntimeStatusChangeRef.current = onRuntimeStatusChange
    const lastRuntimeStatusKeyRef = useRef('')

    useEffect(() => {
      if (!onRuntimeStatusChangeRef.current) return

      const active = projectInstances.find((i) =>
        i.status === 'running' || i.status === 'starting' || i.status === 'stopping'
      ) ?? projectInstances.find((i) =>
        i.status === 'crashed' || i.exitReason === 'crash' || i.exitReason === 'start_failed'
      )

      let game: GameDevStatus = { label: '', variant: 'idle' }
      let phase: PhaseDevStatus | null = null

      if (active) {
        const badge = statusBadge(active)
        const rawLogs = logs.get(active.id) || []
        const phaseInfo = parseMcLogs(rawLogs, active.status)
        if (active.status === 'running' && phaseInfo.phase === 'playing') {
          game = { label: '游戏运行中', variant: 'running' }
        } else if (active.status === 'running') {
          game = { label: phaseInfo.summaryLine || '正在启动游戏', variant: 'starting' }
        } else if (active.status === 'starting' || active.status === 'stopping') {
          game = { label: badge.label, variant: 'starting' }
        } else if (active.status === 'crashed' || active.exitReason === 'crash' || active.exitReason === 'start_failed') {
          game = { label: badge.label, variant: 'crashed' }
        }

        if (phaseInfo.summaryLine && active.status !== 'crashed') {
          phase = { label: phaseInfo.summaryLine }
        }
      }

      const statusKey = `${game.variant}|${game.label}|${phase?.label ?? ''}`
      if (lastRuntimeStatusKeyRef.current === statusKey) return
      lastRuntimeStatusKeyRef.current = statusKey
      onRuntimeStatusChangeRef.current(game, phase)
    }, [projectInstances, logs])

    const handleCreateInstance = useCallback(async () => {
      if (!projectPath) return
      instanceCounterRef.current += 1
      const name = `玩家 ${instanceCounterRef.current}`
      logger.mc('Creating instance', projectPath, name)
      const instance = await window.api.mcCreateInstance(projectPath, name)
      setCrashMessage(null)
      return instance
    }, [projectPath])

    const handleStart = useCallback(async (id: string) => {
      if (!toolchainReady) return
      setCrashMessage(null)
      await window.api.mcStart(id)
    }, [toolchainReady])

    const handleStop = useCallback(async (id: string) => {
      await window.api.mcStop(id)
    }, [])

    const handleDelete = useCallback(async (id: string) => {
      await window.api.mcDeleteInstance(id)
      setInstances((prev) => prev.filter((i) => i.id !== id))
      setLogs((prev) => { const next = new Map(prev); next.delete(id); return next })
      setExpandedDetails((prev) => { const next = new Set(prev); next.delete(id); return next })
      if (crashMessage?.id === id) setCrashMessage(null)
    }, [crashMessage])

    const startDefaultForProject = useCallback(async () => {
      if (!projectPath || !toolchainReady) return
      setCrashMessage(null)
      const running = projectInstances.find((i) => i.status === 'running' || i.status === 'starting')
      if (running) return
      await window.api.mcStartOrCreate(projectPath)
    }, [projectPath, toolchainReady, projectInstances])

    const startDefaultAndWait = useCallback(async (): Promise<GameStartWaitResult> => {
      if (!projectPath || !toolchainReady) {
        return { instanceId: '', ok: false, error: '项目未打开或构建环境未就绪' }
      }
      setCrashMessage(null)

      const running = projectInstances.find((i) => i.status === 'running' || i.status === 'starting')
      if (running) {
        const waitResult = await waitForMcPlaying({ instanceId: running.id })
        return {
          instanceId: running.id,
          ok: waitResult.ok,
          error: waitResult.error
        }
      }

      const res = await window.api.mcStartOrCreate(projectPath)
      if (!res.success) {
        return { instanceId: res.id || '', ok: false, error: res.error || '启动失败' }
      }
      const instanceId = res.id || ''
      if (!instanceId) {
        return { instanceId: '', ok: false, error: '未获取到游戏实例 ID' }
      }

      const waitResult = await waitForMcPlaying({ instanceId })
      return {
        instanceId,
        ok: waitResult.ok,
        error: waitResult.error
      }
    }, [projectPath, toolchainReady, projectInstances])

    const stopAllRunning = useCallback(async () => {
      await window.api.mcStopAll()
    }, [])

    useImperativeHandle(ref, () => ({
      startDefaultForProject,
      startDefaultAndWait,
      stopAllRunning
    }), [startDefaultForProject, startDefaultAndWait, stopAllRunning])

    const handleSendCrashToAi = useCallback(async () => {
      if (!crashMessage?.path) return
      const result = await window.api.mcGetCrashReport(crashMessage.path)
      if (result.success) {
        onAddCrashToChat(result.content || '')
        setCrashMessage(null)
      }
    }, [crashMessage, onAddCrashToChat])

    const toggleDetails = (id: string) => {
      setExpandedDetails((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const crashInst = crashMessage ? instances.find((i) => i.id === crashMessage.id) : null

    return (
      <div className="mc-runtime-panel">
        <div className="mc-runtime-header">
          <div>
            <div className="mc-runtime-title">游戏测试</div>
            <div className="mc-runtime-subtitle">启动 Minecraft 预览模组；多实例使用独立存档目录，可联机测试</div>
          </div>
          <button
            type="button"
            className="mc-btn mc-btn-new"
            onClick={() => void handleCreateInstance()}
            disabled={!projectPath || !toolchainReady}
            title={!toolchainReady ? '等待构建环境初始化完成' : '联机测试时可添加多个实例'}
          >
            + 新建实例
          </button>
        </div>

        {!projectPath && (
          <div className="mc-panel game-card mc-empty-state">
            <div className="mc-empty-icon"><IconGamepad size="lg" /></div>
            <p className="mc-dim">请先打开一个 Fabric 项目</p>
          </div>
        )}

        {projectPath && projectInstances.length === 0 && (
          <div className="mc-panel game-card mc-empty-state mc-empty-state--action">
            <div className="mc-empty-icon"><IconGamepad size="lg" /></div>
            <p className="mc-t">点击下方按钮开始测试模组</p>
            <p className="mc-empty-hint">将自动创建「玩家 1」实例；联机 mod 可再添加更多实例</p>
            <button
              type="button"
              className="mc-btn mc-btn--primary mc-btn-launch"
              onClick={() => void startDefaultForProject()}
              disabled={!toolchainReady}
            >
              启动游戏
            </button>
          </div>
        )}

        {crashMessage && crashInst && (
          <div className="mc-crash-banner">
            <span className="mc-crash-title">
              {crashInst.exitReason === 'start_failed' ? '启动失败' : '游戏崩溃了'}
            </span>
            {crashMessage.code >= 0 && (
              <span className="mc-crash-code">退出码 {crashMessage.code}</span>
            )}
            <div className="mc-crash-actions">
              {crashMessage.path && (
                <>
                  <button type="button" className="mc-btn mc-crash-btn" onClick={() => void handleSendCrashToAi()}>
                    发送给 AI 修复
                  </button>
                  <button
                    type="button"
                    className="mc-btn mc-crash-btn-secondary"
                    onClick={async () => {
                      const result = await window.api.mcGetCrashReport(crashMessage.path!)
                      if (result.success) {
                        const win = window.open('', '_blank')
                        if (win) win.document.body.textContent = result.content || ''
                      }
                    }}
                  >
                    查看报告
                  </button>
                </>
              )}
              <button type="button" className="mc-btn mc-crash-dismiss" onClick={() => setCrashMessage(null)}>×</button>
            </div>
          </div>
        )}

        <div className="mc-instance-list">
          {projectInstances.map((inst) => {
            const rawLogs = logs.get(inst.id) || []
            const instLogs = splitLogChunks(rawLogs)
            const phaseInfo = parseMcLogs(rawLogs, inst.status)
            const badge = statusBadge(inst)
            const isActive = inst.status === 'running' || inst.status === 'starting'
            const stepIdx = phaseStepIndex(phaseInfo.phase, inst.status)
            const showDetails = expandedDetails.has(inst.id)

            let exitSummary: string | null = null
            if (inst.status === 'stopped' && (inst.exitReason ?? 'none') === 'normal') {
              exitSummary = '游戏已正常关闭'
            } else if (inst.status === 'stopped' && (inst.exitReason ?? 'none') === 'manual') {
              exitSummary = '已手动停止游戏'
            }

            return (
              <div key={inst.id} className={`mc-panel mc-instance-card${isActive ? ' mc-instance-card--active' : ''}`}>
                <div className="mc-card-header">
                  <span className="mc-card-name">{inst.name}</span>
                  <span className={`mc-badge ${badge.className}`}>{badge.label}</span>
                </div>

                <div className="mc-phase-stepper">
                  {PHASE_ORDER.map((step, i) => {
                    const done = stepIdx > i
                    const current = stepIdx === i && (inst.status === 'starting' || inst.status === 'running' || inst.status === 'stopping')
                    return (
                      <React.Fragment key={step}>
                        <div className={`mc-phase-step${done ? ' mc-phase-step--done' : ''}${current ? ' mc-phase-step--current' : ''}`}>
                          <div className="mc-phase-dot" />
                          <span className="mc-phase-label">{PHASE_LABELS[step]}</span>
                        </div>
                        {i < PHASE_ORDER.length - 1 && (
                          <div className={`mc-phase-connector${done ? ' mc-phase-connector--done' : ''}`} />
                        )}
                      </React.Fragment>
                    )
                  })}
                </div>

                <p className={`mc-summary${phaseInfo.hasError ? ' mc-summary--error' : ''}${exitSummary && (inst.exitReason ?? 'none') === 'normal' ? ' mc-summary--success' : ''}`}>
                  {exitSummary || phaseInfo.summaryLine}
                </p>

                <div className="mc-card-actions">
                  {(inst.status === 'stopped' || inst.status === 'crashed') && (
                    <button
                      type="button"
                      className="mc-btn mc-btn--primary mc-btn-launch"
                      onClick={() => void handleStart(inst.id)}
                      disabled={!toolchainReady}
                    >
                      启动游戏
                    </button>
                  )}
                  {(inst.status === 'running' || inst.status === 'starting') && (
                    <button type="button" className="mc-btn mc-btn--red mc-btn-stop" onClick={() => void handleStop(inst.id)}>
                      停止游戏
                    </button>
                  )}
                  {inst.status === 'stopping' && (
                    <button type="button" className="mc-btn mc-btn--red mc-btn-stop" disabled>正在停止…</button>
                  )}
                  {!isActive && (
                    <button type="button" className="mc-btn mc-btn-delete" onClick={() => void handleDelete(inst.id)} title="删除实例">
                      删除
                    </button>
                  )}
                </div>

                <button
                  className="mc-details-toggle"
                  onClick={() => toggleDetails(inst.id)}
                  type="button"
                >
                  {showDetails ? '▾ 收起技术详情' : '▸ 查看技术详情'}
                  {instLogs.length > 0 && !showDetails && (
                    <span className="mc-details-count">（{instLogs.length} 行）</span>
                  )}
                </button>

                {showDetails && (
                  <div className="mc-details-log">
                    {instLogs.length === 0 ? (
                      <span className="mc-details-empty">暂无输出</span>
                    ) : (
                      instLogs.slice(-100).map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.includes('ERROR') || line.includes('FAILED') ? 'mc-log-line--error'
                              : line.includes('WARN') ? 'mc-log-line--warn'
                              : 'mc-log-line'
                          }
                        >
                          {line}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
)

McRuntimePanel.displayName = 'McRuntimePanel'

export default McRuntimePanel
