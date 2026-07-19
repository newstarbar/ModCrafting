import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { parseAnyError, buildRepairPrompt, summarizeBuildOutput, type ParsedError } from '../utils/log-parser'
import { logger } from '../utils/logger'
import { emitBuildProgress } from '../utils/panel-bridge'

interface BottomPanelProps {
  projectPath: string | null
  onAddToChatContext: (text: string) => void
  toolchainReady?: boolean
  onBuildStatusChange?: (status: { running: boolean; failed?: boolean }) => void
}

export interface BuildRunResult {
  exitCode: number
  failed: boolean
}

export interface BottomPanelHandle {
  runBuild: () => Promise<BuildRunResult>
  stopProcess: () => Promise<void>
  getBuildLogText: () => string
}

const BottomPanel = forwardRef<BottomPanelHandle, BottomPanelProps>(
  ({ projectPath, onAddToChatContext, toolchainReady = true, onBuildStatusChange }, ref) => {
    const [logs, setLogs] = useState<string[]>([])
    const [buildLogsExpanded, setBuildLogsExpanded] = useState(false)
    const [terminalExpanded, setTerminalExpanded] = useState(false)
    const [terminalId, setTerminalId] = useState<string | null>(null)
    const [processRunning, setProcessRunning] = useState(false)
    const [detectedErrors, setDetectedErrors] = useState<ParsedError[]>([])
    const [exportedJar, setExportedJar] = useState<{ path: string; name: string } | null>(null)
    const [exporting, setExporting] = useState(false)
    const terminalRef = useRef<HTMLDivElement>(null)
    const xtermRef = useRef<Terminal | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    const logRef = useRef<HTMLDivElement>(null)
    const terminalMountedRef = useRef(false)
    const buildLogLinesRef = useRef<string[]>([])

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
      if (!terminalExpanded) {
        if (xtermRef.current) {
          xtermRef.current.dispose()
          xtermRef.current = null
          fitAddonRef.current = null
        }
        return
      }
      initXterm()
      const fitFn = (): void => {
        try { fitAddonRef.current?.fit() } catch { /* ignore */ }
      }
      const timer = setTimeout(fitFn, 50)
      window.addEventListener('resize', fitFn)
      return () => {
        clearTimeout(timer)
        window.removeEventListener('resize', fitFn)
        if (xtermRef.current) {
          xtermRef.current.dispose()
          xtermRef.current = null
          fitAddonRef.current = null
        }
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
      if (!projectPath || !terminalExpanded) {
        if (!terminalExpanded) {
          setTerminalId(null)
          terminalMountedRef.current = false
        }
        return
      }

      let cancelled = false
      const initTerminal = async (): Promise<void> => {
        const id = await window.api.terminalCreate(projectPath)
        if (cancelled) {
          await window.api.terminalKill(id)
          return
        }
        logger.terminal('Terminal session created', id)
        setTerminalId(id)
        terminalMountedRef.current = true
      }

      void initTerminal()

      return () => {
        cancelled = true
        terminalMountedRef.current = false
        setTerminalId((prev) => {
          if (prev) void window.api.terminalKill(prev)
          return null
        })
      }
    }, [projectPath, terminalExpanded])

    useEffect(() => {
      setExportedJar(null)
    }, [projectPath])

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

    const resetBuildSession = useCallback(() => {
      buildLogLinesRef.current = []
      setLogs([])
      setDetectedErrors([])
      setBuildLogsExpanded(true)
    }, [])

    const addLog = useCallback((level: 'info' | 'warn' | 'error', message: string) => {
      const timestamp = new Date().toLocaleTimeString()
      const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`
      buildLogLinesRef.current = [...buildLogLinesRef.current, line]
      setLogs(buildLogLinesRef.current)
      emitBuildProgress(line)
    }, [])

    const appendBuildOutput = useCallback((text: string, level: 'info' | 'warn' | 'error' = 'info') => {
      if (text) emitBuildProgress(text.endsWith('\n') ? text : `${text}\n`)
      for (const line of text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)) {
        const timestamp = new Date().toLocaleTimeString()
        const formatted = `[${timestamp}] [${level.toUpperCase()}] ${line}`
        buildLogLinesRef.current = [...buildLogLinesRef.current, formatted]
      }
      setLogs(buildLogLinesRef.current)
      if (terminalExpanded && xtermRef.current && text) {
        xtermRef.current.write(text.replace(/\r?\n/g, '\r\n'))
      }
    }, [terminalExpanded])

    const runBuild = useCallback(async (): Promise<BuildRunResult> => {
      if (!projectPath) {
        addLog('warn', '请先打开项目')
        return { exitCode: 1, failed: true }
      }
      if (!toolchainReady) {
        addLog('warn', '构建环境尚未就绪，请等待初始化完成')
        return { exitCode: 1, failed: true }
      }

      resetBuildSession()
      setExportedJar(null)
      logger.terminal('Build started', { projectPath })
      setProcessRunning(true)
      onBuildStatusChange?.({ running: true, failed: false })
      addLog('info', '开始构建…')
      addLog('info', '正在准备构建环境与 Gradle…')

      const unsub = window.api.onCommandOutput((text) => appendBuildOutput(text.trimEnd()))
      let buildFailed = false
      let exitCode = 0
      try {
        const res = await window.api.runGradleTask(projectPath, 'build')
        exitCode = res.exitCode ?? 0
        if (res.usedOnlineFallback) addLog('info', '已联网下载缺失依赖，后续可离线构建')
        if (res.exitCode !== 0) {
          buildFailed = true
          addLog('error', `构建失败 (退出码 ${res.exitCode})`)
          if (res.output?.trim()) appendBuildOutput(res.output.trim().slice(-4000), 'error')
          setBuildLogsExpanded(true)
        } else {
          addLog('info', '构建完成')
        }
      } catch (err) {
        buildFailed = true
        exitCode = 1
        addLog('error', String(err))
        setBuildLogsExpanded(true)
      } finally {
        unsub()
        setProcessRunning(false)
        onBuildStatusChange?.({ running: false, failed: buildFailed })
      }
      return { exitCode, failed: buildFailed }
    }, [projectPath, toolchainReady, addLog, appendBuildOutput, onBuildStatusChange, resetBuildSession])

    const stopProcess = useCallback(async () => {
      if (!terminalId) return
      await sendCtrlC(2)
      setProcessRunning(false)
      addLog('info', '已发送停止信号')
    }, [terminalId, addLog])

    const runExportJar = useCallback(async () => {
      if (!projectPath) {
        addLog('warn', '请先打开项目')
        return
      }
      if (!toolchainReady) {
        addLog('warn', '构建环境尚未就绪，请等待初始化完成')
        return
      }

      setExportedJar(null)
      setExporting(true)
      resetBuildSession()
      logger.terminal('Export jar started', { projectPath })
      setProcessRunning(true)
      onBuildStatusChange?.({ running: true, failed: false })
      addLog('info', '开始导出模组包…')
      addLog('info', '正在执行 gradlew build…')

      const unsub = window.api.onCommandOutput((text) => appendBuildOutput(text.trimEnd()))
      let buildFailed = false
      try {
        const res = await window.api.runGradleTask(projectPath, 'build')
        if (res.usedOnlineFallback) addLog('info', '已联网下载缺失依赖，后续可离线构建')
        if (res.exitCode !== 0) {
          buildFailed = true
          addLog('error', `导出失败：构建未通过 (退出码 ${res.exitCode})`)
          if (res.output?.trim()) appendBuildOutput(res.output.trim().slice(-4000), 'error')
          setBuildLogsExpanded(true)
          return
        }

        const found = await window.api.findExportJar(projectPath)
        if (!found.success || !found.jarPath || !found.jarName) {
          buildFailed = true
          addLog('error', found.error || '构建成功但未找到可导出的 jar')
          setBuildLogsExpanded(true)
          return
        }

        setExportedJar({ path: found.jarPath, name: found.jarName })
        addLog('info', `导出就绪：${found.jarName}`)
        addLog('info', found.jarPath)
      } catch (err) {
        buildFailed = true
        addLog('error', String(err))
        setBuildLogsExpanded(true)
      } finally {
        unsub()
        setProcessRunning(false)
        setExporting(false)
        onBuildStatusChange?.({ running: false, failed: buildFailed })
      }
    }, [projectPath, toolchainReady, addLog, appendBuildOutput, onBuildStatusChange, resetBuildSession])

    const openExportedJarFolder = useCallback(async () => {
      if (!exportedJar) return
      const res = await window.api.showItemInFolder(exportedJar.path)
      if (!res.success) {
        addLog('error', res.error || '无法打开所在文件夹')
      }
    }, [exportedJar, addLog])

    const saveExportedJarAs = useCallback(async () => {
      if (!exportedJar) return
      const res = await window.api.exportJar(exportedJar.path, exportedJar.name)
      if (res.cancelled) {
        addLog('info', '已取消另存为')
        return
      }
      if (!res.success) {
        addLog('error', res.error || '另存为失败')
        return
      }
      addLog('info', `已另存为：${res.path}`)
    }, [exportedJar, addLog])

    useImperativeHandle(ref, () => ({
      runBuild,
      stopProcess,
      getBuildLogText: () => buildLogLinesRef.current.join('\n')
    }), [runBuild, stopProcess])

    const autoFix = () => {
      if (detectedErrors.length === 0) return
      onAddToChatContext(buildRepairPrompt(detectedErrors, buildLogLinesRef.current.join('\n')))
      addLog('info', `已将 ${detectedErrors.length} 个错误发送给 AI 分析`)
    }

    const busy = processRunning || exporting
    const buildSummary = processRunning && !exporting
      ? '正在构建模组…'
      : exporting
        ? '正在导出模组包…'
        : logs.some((line) => line.includes('[ERROR]'))
          ? '构建失败，请展开查看详情'
          : exportedJar
            ? '模组包已就绪，可打开文件夹或另存为'
            : logs.some((line) => line.includes('构建完成'))
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
                disabled={busy || !toolchainReady || !projectPath}
              >
                {processRunning && !exporting ? '构建中…' : '构建'}
              </button>
              {busy && (
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
                        onClick={() => onAddToChatContext(`--- 构建日志 ---\n${summarizeBuildOutput(logs.join('\n'), 30)}`)}
                      >
                        发送给 AI
                      </button>
                      <button
                        type="button"
                        className="mc-btn"
                        style={{ fontSize: '11px' }}
                        onClick={resetBuildSession}
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

          <div className="advanced-section advanced-section--export">
            <div className="advanced-section-header">
              <span className="advanced-section-title mc-t">导出模组包</span>
            </div>
            <p className="advanced-hint mc-dim">
              执行完整构建并定位可发布的 JAR（排除 sources / dev / javadoc）。成功后可打开所在文件夹，或另存到其他位置。
            </p>
            <div className="advanced-toolbar">
              <button
                type="button"
                className="mc-btn mc-btn--primary advanced-build-btn"
                onClick={() => void runExportJar()}
                disabled={busy || !toolchainReady || !projectPath}
              >
                {exporting ? '导出中…' : '导出 JAR'}
              </button>
            </div>
            {exportedJar && (
              <div className="advanced-export-result">
                <p className="advanced-export-name mc-t">{exportedJar.name}</p>
                <p className="advanced-export-path mc-dim" title={exportedJar.path}>
                  {exportedJar.path}
                </p>
                <div className="advanced-toolbar advanced-toolbar--export-actions">
                  <button
                    type="button"
                    className="mc-btn"
                    onClick={() => void openExportedJarFolder()}
                  >
                    打开所在文件夹
                  </button>
                  <button
                    type="button"
                    className="mc-btn"
                    onClick={() => void saveExportedJarAs()}
                  >
                    另存为…
                  </button>
                </div>
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
