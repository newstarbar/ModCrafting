import React from 'react'
import { cacheHitRate, type UsageStats } from '../utils/usage'

interface StatusBarProps {
  usage: UsageStats
  running: boolean
  modelLabel?: string
  toolchain?: { jdk: string; gradle: string; deps?: string }
  toolchainProgress?: string
  toolchainPercent?: number
}

const jdkLabel: Record<string, string> = {
  ready: 'JDK ✓',
  bundled: 'JDK 复制中',
  missing: 'JDK ✗'
}

const gradleLabel: Record<string, string> = {
  ready: 'Gradle ✓',
  incomplete: 'Gradle 不完整',
  missing: 'Gradle ✗'
}

const depsLabel: Record<string, string> = {
  ready: '离线依赖 ✓',
  missing: '离线依赖 ✗'
}

const StatusBar: React.FC<StatusBarProps> = ({ usage, running, modelLabel, toolchain, toolchainProgress, toolchainPercent }) => {
  const turnRate = cacheHitRate(usage.turnCacheHitTokens, usage.turnCacheMissTokens)
  const sessionRate = cacheHitRate(usage.cacheHitTokens, usage.cacheMissTokens)

  const formatTokens = (n: number): string => n > 0 ? n.toLocaleString() : '-'
  const formatCost = (n: number): string => n > 0 ? `$${n.toFixed(4)}` : '-'
  const formatRate = (rate: number | null): string => rate !== null ? `${rate.toFixed(1)}%` : '-'

  const rateClass = (rate: number | null): string => {
    if (rate === null) return 'stat-empty'
    if (rate >= 80) return 'stat-good'
    if (rate >= 50) return 'stat-ok'
    return 'stat-bad'
  }

  const envReady = toolchain
    && toolchain.jdk === 'ready'
    && toolchain.gradle === 'ready'
    && toolchain.deps === 'ready'

  const envSummary = toolchain
    ? `${jdkLabel[toolchain.jdk] || toolchain.jdk} · ${gradleLabel[toolchain.gradle] || toolchain.gradle}${toolchain.deps ? ` · ${depsLabel[toolchain.deps] || toolchain.deps}` : ''}`
    : ''

  return (
    <div className="statusbar">
      <span className="stat" title="模型">
        <span className={`dot ${running ? 'dot-busy' : ''}`} />
        <span className="stat-label">{modelLabel || 'ModCrafting'}</span>
      </span>

      <span className="stat" title="会话累计 Token">
        <span className="stat-label">会话</span>
        <b>{formatTokens(usage.sessionTokens)}</b>
      </span>

      <span className="stat" title="当前轮次累计 Token（含工具多步调用）">
        <span className="stat-label">本轮</span>
        <b className={usage.turnTokens > 0 ? '' : 'stat-empty'}>{formatTokens(usage.turnTokens)}</b>
      </span>

      <span className="stat" title="本轮缓存命中率">
        <span className="stat-label">缓存</span>
        <b className={rateClass(turnRate)}>{formatRate(turnRate)}</b>
      </span>

      <span className="stat" title="会话平均缓存命中率">
        <span className="stat-label">平均</span>
        <b className={rateClass(sessionRate)}>{formatRate(sessionRate)}</b>
      </span>

      <span className="stat" title="已完成对话轮次">
        <span className="stat-label">轮次</span>
        <b>{usage.turns > 0 ? `${usage.turns}` : '-'}</b>
      </span>

      <span className="stat" title="最近一次请求的 Prompt 占上下文窗口比例">
        <span className="stat-label">上下文</span>
        <b className={usage.contextPercent > 80 ? 'stat-bad' : usage.contextPercent > 50 ? 'stat-ok' : ''}>
          {usage.contextPercent > 0 ? `${usage.contextPercent}%` : '-'}
        </b>
      </span>

      <span className="stat" title="会话累计费用估算（美元）">
        <span className="stat-label">费用</span>
        <b>{formatCost(usage.cost)}</b>
      </span>

      {toolchain && (
        <span className="stat" title={toolchainProgress || '内置构建环境状态（JDK · Gradle · 离线 Fabric 依赖）'}>
          <span className="stat-label">环境</span>
          <b className={envReady ? 'stat-good' : toolchain.jdk === 'missing' || toolchain.deps === 'missing' ? 'stat-bad' : 'stat-ok'}>
            {toolchainPercent !== undefined
              ? `初始化 ${toolchainPercent}%`
              : toolchainProgress || envSummary}
          </b>
        </span>
      )}
    </div>
  )
}

export default StatusBar
