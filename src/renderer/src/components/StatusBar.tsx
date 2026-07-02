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

const StatusBar: React.FC<StatusBarProps> = ({
  usage,
  running,
  modelLabel,
  toolchain,
  toolchainProgress,
  toolchainPercent
}) => {
  const formatTokens = (n: number): string => (n > 0 ? n.toLocaleString() : '-')
  const formatCost = (n: number): string => (n > 0 ? `￥${n.toFixed(4)}` : '-')

  const envReady = toolchain
    && toolchain.jdk === 'ready'
    && toolchain.gradle === 'ready'
    && toolchain.deps === 'ready'

  const envText = toolchainPercent !== undefined
    ? `初始化 ${toolchainPercent}%`
    : envReady
      ? '环境就绪'
      : toolchainProgress || '环境检查中'

  const xpPercent = usage.contextPercent > 0
    ? Math.min(100, usage.contextPercent)
    : running
      ? 35
      : 0

  return (
    <div className="statusbar">
      <span className={`dot ${running ? 'dot-busy' : 'dot-idle'}`} />
      <span className="mc-t">{running ? '运行中' : '就绪'}</span>
      <span className="stat-sep">|</span>
      <span className="stat mc-dim">{modelLabel || 'ModCrafting'}</span>

      {usage.sessionTokens > 0 && (
        <>
          <span className="stat-sep">|</span>
          <span className="stat" title="会话累计 Token">
            <span className="stat-label">会话</span>
            <span className="stat-value">{formatTokens(usage.sessionTokens)}</span>
          </span>
        </>
      )}

      {usage.cost > 0 && (
        <>
          <span className="stat-sep">|</span>
          <span className="stat" title="费用估算">
            <span className="stat-value">{formatCost(usage.cost)}</span>
          </span>
        </>
      )}

      {toolchain && (
        <>
          <span className="stat-sep">|</span>
          <span
            className="stat"
            title={toolchainProgress || 'JDK · Gradle · 离线依赖'}
          >
            <span className={`stat-value ${envReady ? 'stat-good' : toolchainPercent !== undefined ? 'stat-ok' : ''}`}>
              {envText}
            </span>
          </span>
        </>
      )}

      {xpPercent > 0 && (
        <span className="statusbar-xp" title={`上下文占用约 ${xpPercent}%`}>
          <i style={{ width: `${xpPercent}%` }} />
        </span>
      )}

      <span className="statusbar-tail mc-dim">
        {usage.turnTokens > 0 && (
          <span title="本轮 Token">{formatTokens(usage.turnTokens)} tok</span>
        )}
        {cacheHitRate(usage.turnCacheHitTokens, usage.turnCacheMissTokens) !== null && (
          <span title="缓存命中率">
            缓存 {cacheHitRate(usage.turnCacheHitTokens, usage.turnCacheMissTokens)!.toFixed(0)}%
          </span>
        )}
      </span>
    </div>
  )
}

export default StatusBar
