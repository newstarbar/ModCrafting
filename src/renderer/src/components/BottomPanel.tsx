import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { parseAnyError, buildRepairPrompt, type ParsedError } from '../utils/log-parser'
import { logger } from '../utils/logger'

interface BottomPanelProps {
  projectPath: string | null
  onAddToChatContext: (text: string) => void
  toolchainReady?: boolean
}

export interface BottomPanelHandle {
  runBuild: () => Promise<void>
  stopProcess: () => Promise<void>
}

const BottomPanel = forwardRef<BottomPanelHandle, BottomPanelProps>(
  ({ projectPath, onAddToChatContext, toolchainReady = true }, ref) => {
    const [logs, setLogs] = useState<string[]>([])
    const [buildLogsExpanded, setBuildLogsExpanded] = useState(false)
    const [terminalExpanded, setTerminalExpanded] = useState(false)
    const [terminalId, setTerminalId] = useState<string | null>(null)
    const [processRunning, setProcessRunning] = useState(false)
    const [detectedErrors, setDetectedErrors] = useState<ParsedError[]>([])
    const terminalRef = useRef<HTMLDivElement>(null)
    const xtermRef = useRef<Terminal | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const logRef = useRef<HTMLDivElement>(null)
    const terminalMountedRef = useRef(false)

    const sendCtrlC = async (count = 1): Promise<void> => {
      if (!terminalId) return
      for (let i = 0; i < count; i++) {
        await window.api.terminalWrite(terminalId, '\x03')
        if (i < count - 1) await new Promise((r) => setTimeout(r, 150))
      }
    }

    const initXterm = useCallback(() => {
      if (!terminalRef.current || xtermRef.current) return

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 12,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        theme: {
          background: '#0d1117',
          foreground: '#c9d1d9',
          cursor: '#c9d1d9',
          selectionBackground: '#264f78'
        }
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(terminalRef.current)
      fitAddon.fit()

      xtermRef.current = term
      fitAddonRef.current = fitAddon

      term.onData((data) => {
        if (terminalId) window.api.terminalWrite(terminalId, data)
      })

      term.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.key === 'C') {
          const selection = term.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection)
            term.clearSelection()
            event.preventDefault()
            return false
          }
        }
        return true
      })
    }, [terminalId])

    useEffect(() => {
      if (!terminalExpanded) return
      initXterm()
      const fitFn = (): void => {
        try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      }
      const timer = setTimeout(fitFn, 50)
      window.addEventListener('resize', fitFn)
      return () => {
        clearTimeout(timer)
        window.removeEventListener('resize', fitFn)
      }
    }, [terminalExpanded, initXterm])

    useEffect(() => {
      if (!terminalExpanded || !terminalId || !xtermRef.current) return
      xtermRef.current.write(`\x1b[32mModCrafting 命令行\x1b[0m\r\n`)
      xtermRef.current.write(`\x1b[36m工作目录: ${projectPath}\x1b[0m\r\n\r\n`)
    }, [terminalExpanded, terminalId, projectPath])

    useEffect(() => {
      const unsub = window.api.onTerminalData((id, data) => {
        if (id === terminalId && xtermRef.current) {
          xtermRef.current.write(data)
          if (data.includes('BUILD SUCCESSFUL') || data.includes('BUILD FAILED')) {
            setProcessRunning(false)
          }
        }
      })
      return unsub
    }, [terminalId])

    useEffect(() => {
      if (!projectPath || !terminalExpanded) return

      const initTerminal = async (): Promise<void> => {
        if (terminalId) await window.api.terminalKill(terminalId)
        const id = await window.api.terminalCreate(projectPath)
        logger.terminal('Terminal session created', id)
        setTerminalId(id)
        terminalMountedRef.current = true
      }

      void initTerminal()

      return () => {
        if (terminalMountedRef.current && terminalId) {
          void window.api.terminalKill(terminalId)
        }
      }
    }, [projectPath, terminalExpanded])

    useEffect(() => {
      if (buildLogsExpanded && logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight
      }
    }, [logs, buildLogsExpanded])

    useEffect(() => {
      const errors: ParsedError[] = []
      for (const line of logs) {
        const parsed = parseAnyError(line)
        if (parsed) errors.push(parsed)
      }
      setDetectedErrors(errors)
    }, [logs])

    const addLog = useCallback((level: 'info' | 'warn' | 'error', message: string) => {
      const timestamp = new Date().toLocaleTimeString()
      setLogs((prev) => [...prev, `[${timestamp}] [${level.toUpperCase()}] ${message}`])
    }, [])

    const appendBuildOutput = useCallback((text: string, level: 'info' | 'warn' | 'error' = 'info') => {
      for (const line of text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)) {
        addLog(level, line)
      }
      if (terminalExpanded && xtermRef.current && text) {
        xtermRef.current.write(text.replace(/\r?\n/g, '\r\n'))
      }
    }, [addLog, terminalExpanded])

    const runBuild = useCallback(async () => {
      if (!projectPath) {
        addLog('warn', '请先打开项目')
        return
      }
      if (!toolchainReady) {
        addLog('warn', '构建环境尚未就绪，请等待初始化完成')
        return
      }

      logger.terminal('Build started', { projectPath })
      setProcessRunning(true)
      addLog('info', '开始构建…')

      const unsub = window.api.onCommandOutput((text) => appendBuildOutput(text.trimEnd()))
      try {
        const res = await window.api.runGradleTask(projectPath, 'build')
        if (res.usedOnlineFallback) addLog('info', '已联网下载缺失依赖，后续可离线构建')
        if (res.exitCode !== 0) {
          addLog('error', `构建失败 (退出码 ${res.exitCode})`)
          if (res.output?.trim()) appendBuildOutput(res.output.trim().slice(-4000), 'error')
          setBuildLogsExpanded(true)
        } else {
          addLog('info', '构建完成')
        }
      } catch (err) {
        addLog('error', String(err))
        setBuildLogsExpanded(true)
      } finally {
        unsub()
        setProcessRunning(false)
      }
    }, [projectPath, toolchainReady, addLog, appendBuildOutput])

    const stopProcess = useCallback(async () => {
      if (!terminalId) return
      await sendCtrlC(2)
      setProcessRunning(false)
      addLog('info', '已发送停止信号')
    }, [terminalId, addLog])

    useImperativeHandle(ref, () => ({ runBuild, stopProcess }), [runBuild, stopProcess])

    const autoFix = () => {
      if (detectedErrors.length === 0) return
      onAddToChatContext(buildRepairPrompt(detectedErrors, logs.join('\n')))
      addLog('info', `已将 ${detectedErrors.length} 个错误发送给 AI 分析`)
    }

    const lastLog = logs.length > 0 ? logs[logs.length - 1] : null
    const buildSummary = processRunning
      ? '正在构建模组…'
      : lastLog?.includes('[ERROR]')
        ? '构建失败，请展开查看详情'
        : lastLog?.includes('构建完成')
          ? '上次构建已成功完成'
          : '仅编译检查，不启动游戏'

    return (
      <div className="advanced-panel">
        <div className="advanced-card mc-panel">
          <div className="advanced-section">
            <div className="advanced-section-header">
              <span className="advanced-section-title mc-t">编译检查</span>
              {!toolchainReady && (
                <span className="advanced-waiting">环境初始化中…</span>
              )}
            </div>
            <p className="advanced-hint mc-dim">检查代码能否成功编译（不启动游戏）。日常测试请使用「游戏」面板。</p>
            <div className="advanced-toolbar">
              <button
                type="button"
                className="mc-btn mc-btn--primary advanced-build-btn"
                onClick={() => void runBuild()}
                disabled={processRunning || !toolchainReady || !projectPath}
              >
                {processRunning ? '构建中…' : '构建'}
              </button>
              {processRunning && (
                <button type="button" className="mc-btn mc-btn--red" onClick={() => void stopProcess()}>
                  停止
                </button>
              )}
            </div>
            <p className="advanced-build-summary mc-dim">{buildSummary}</p>

            {logs.length > 0 && (
              <div className="advanced-collapsible">
                <button
                  type="button"
                  className="advanced-collapse-toggle mc-dim"
                  onClick={() => setBuildLogsExpanded((v) => !v)}
                >
                  {buildLogsExpanded ? '▾ 收起构建记录' : '▸ 查看构建记录'}
                  <span className="advanced-collapse-meta">（{logs.length} 条）</span>
                </button>
                {buildLogsExpanded && (
                  <div className="advanced-build-logs">
                    <div className="advanced-build-logs-toolbar">
                      {detectedErrors.length > 0 && (
                        <button type="button" className="mc-btn advanced-fix-btn" onClick={autoFix}>
                          发送错误给 AI ({detectedErrors.length})
                        </button>
                      )}
                      <button
                        type="button"
                        className="mc-btn"
                        style={{ fontSize: '11px', marginLeft: 'auto' }}
                        onClick={() => onAddToChatContext(`--- 构建日志 ---\n${logs.slice(-50).join('\n')}`)}
                      >
                        发送给 AI
                      </button>
                      <button
                        type="button"
                        className="mc-btn"
                        style={{ fontSize: '11px' }}
                        onClick={() => setLogs([])}
                      >
                        清空
                      </button>
                    </div>
                    <div className="advanced-build-logs-content term" ref={logRef}>
                      {logs.map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.includes('[ERROR]') || line.includes('FAILED') ? 'log-error'
                              : line.includes('[WARN]') ? 'log-warn' : ''
                          }
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="advanced-section advanced-section--terminal">
          <button
            type="button"
            className="advanced-collapse-toggle advanced-terminal-toggle"
            onClick={() => setTerminalExpanded((v) => !v)}
          >
            {terminalExpanded ? '▾ 收起命令行' : '▸ 展开命令行（开发者）'}
          </button>
          {terminalExpanded && (
            <div className="advanced-terminal-wrap">
              <div ref={terminalRef} className="advanced-terminal" />
            </div>
          )}
        </div>
      </div>
    )
  }
)

BottomPanel.displayName = 'BottomPanel'

export default BottomPanel
