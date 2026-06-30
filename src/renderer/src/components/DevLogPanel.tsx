import React, { useState, useEffect, useRef, useCallback } from 'react'

// Capture all logger output
const logBuffer: Array<{ time: string; tag: string; msg: string; data?: string }> = []
const MAX_LOGS = 1000

// Override console.log to capture ModCrafting logs
const originalLog = console.log
console.log = function (...args: unknown[]) {
  originalLog.apply(console, args)
  const first = String(args[0] || '')
  if (first.startsWith('%c[')) {
    const match = first.match(/\[(\w+)\]\s(.+)/)
    if (match) {
      logBuffer.push({
        time: new Date().toLocaleTimeString(),
        tag: match[1],
        msg: match[2],
        data: args.slice(1)
          .filter((a) => typeof a !== 'string' || !/^color:/.test(a))
          .map((a) => {
          try { return typeof a === 'object' ? JSON.stringify(a, null, 2).slice(0, 200) : String(a) }
          catch { return String(a) }
        }).join(' ')
      })
      if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS)
    }
  }
}

const tagColors: Record<string, string> = {
  api: '#89b4fa', tool: '#a6e3a1', stream: '#f9e2af',
  agent: '#cba6f7', file: '#94e2d5', error: '#f38ba8',
  ipc: '#fab387', mc: '#74c7ec', terminal: '#a6adc8'
}

const DevLogPanel: React.FC = () => {
  const [logs, setLogs] = useState<typeof logBuffer>([])
  const [filter, setFilter] = useState<string>('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Poll log buffer
  useEffect(() => {
    const interval = setInterval(() => {
      setLogs([...logBuffer])
    }, 300)
    return () => clearInterval(interval)
  }, [])

  // Auto scroll
  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [logs, autoScroll])

  const copyAll = useCallback(() => {
    const text = logs
      .filter((l) => filter === 'all' || l.tag === filter)
      .map((l) => `[${l.time}] [${l.tag}] ${l.msg} ${l.data || ''}`)
      .join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [logs, filter])

  const tags = ['all', ...new Set(logs.map((l) => l.tag))]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#0d1117', color: '#c9d1d9' }}>
      {/* Toolbar */}
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #30363d', display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#8b949e' }}>🐛 调试日志</span>
        <div style={{ display: 'flex', gap: '2px', flexWrap: 'wrap' }}>
          {tags.slice(0, 10).map((t) => (
            <button key={t} onClick={() => setFilter(t)}
              style={{
                padding: '1px 6px', fontSize: '10px', border: 'none', borderRadius: '3px', cursor: 'pointer',
                background: filter === t ? (tagColors[t] || '#58a6ff') : '#21262d',
                color: filter === t ? '#000' : '#8b949e'
              }}>
              {t === 'all' ? '全部' : t} {t !== 'all' && `(${logs.filter((l) => l.tag === t).length})`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: '10px', color: '#8b949e', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
        <button onClick={copyAll}
          style={{ padding: '2px 8px', fontSize: '10px', border: '1px solid #30363d', borderRadius: '4px', cursor: 'pointer', background: '#21262d', color: '#c9d1d9' }}>
          {copied ? '✅ 已复制' : '📋 复制全部'}
        </button>
        <button onClick={() => { logBuffer.splice(0); setLogs([]) }}
          style={{ padding: '2px 8px', fontSize: '10px', border: '1px solid #30363d', borderRadius: '4px', cursor: 'pointer', background: '#21262d', color: '#c9d1d9' }}>
          🗑️ 清空
        </button>
      </div>
      {/* Log content */}
      <div ref={ref} style={{
        flex: 1, overflow: 'auto', fontFamily: "'Cascadia Code', 'Fira Code', monospace", fontSize: '11px', lineHeight: 1.7, padding: '4px 8px', userSelect: 'text'
      }}>
        {logs.length === 0 ? (
          <div style={{ padding: '24px', color: '#484f58', textAlign: 'center' }}>等待日志...</div>
        ) : (
          logs
            .filter((l) => filter === 'all' || l.tag === filter)
            .map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px' }}>
                <span style={{ color: '#484f58', flexShrink: 0, width: '70px' }}>{l.time}</span>
                <span style={{ color: tagColors[l.tag] || '#8b949e', flexShrink: 0, width: '50px' }}>[{l.tag}]</span>
                <span style={{ color: l.tag === 'error' ? '#f38ba8' : '#c9d1d9', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {l.msg} {l.data || ''}
                </span>
              </div>
            ))
        )}
      </div>
    </div>
  )
}

export default DevLogPanel
