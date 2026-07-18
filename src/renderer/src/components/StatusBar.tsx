import React from 'react'
import {
  cacheHitMissForDisplay,
  contextWindowLimit,
  effectiveCacheHitRate,
  formatContextLimit,
  formatCostCny,
  formatTokensK,
  type UsageStats
} from '../utils/usage'
import type { McRuntimeSlot } from '../types/dev-status'
import type { ProjectVersions } from '../utils/project-versions'
import { formatProjectVersions } from '../utils/project-versions'

interface StatusBarProps {
  usage: UsageStats
  /** Lifetime spend for the current project (CNY). */
  projectCost?: number
  /** DeepSeek account balance label, e.g. ￥110.00 */
  deepseekBalanceLabel?: string | null
  running: boolean
  providerLabel?: string
  modelId?: string
  providerId?: string
  toolchain?: { jdk: string; gradle: string; deps?: string }
  toolchainProgress?: string
  toolchainPercent?: number
  projectVersions?: ProjectVersions | null
  mcRuntime?: McRuntimeSlot
}

function contextLevelClass(percent: number): string {
  if (percent > 80) return 'statusbar-context-bar--danger'
  if (percent >= 50) return 'statusbar-context-bar--warn'
  return 'statusbar-context-bar--safe'
}

const StatusBar: React.FC<StatusBarProps> = ({
  usage,
  projectCost = 0,
  deepseekBalanceLabel,
  running,
  providerLabel,
  modelId,
  providerId,
  toolchain,
  toolchainProgress,
  toolchainPercent,
  projectVersions,
  mcRuntime
}) => {
  const envReady = toolchain
    && toolchain.jdk === 'ready'
    && toolchain.gradle === 'ready'
    && toolchain.deps === 'ready'

  const envText = toolchainPercent !== undefined
    ? `初始化 ${toolchainPercent}%`
    : envReady
      ? '环境就绪'
      : toolchainProgress || '环境检查中'

  const contextLimit = contextWindowLimit(modelId, providerId)
  const contextLimitLabel = formatContextLimit(contextLimit)
  const xpPercent = Math.min(100, Math.max(0, usage.contextPercent))
  const contextTitle = xpPercent > 80
    ? `上下文占用约 ${xpPercent}%（即将满载）`
    : `上下文占用约 ${xpPercent}%（prompt ${usage.lastPromptTokens.toLocaleString()} / ${contextLimit.toLocaleString()}）`

  const { hit: cacheHit, miss: cacheMiss } = cacheHitMissForDisplay(
    usage.turnCacheHitTokens,
    usage.turnCacheMissTokens,
    usage.cacheHitTokens,
    usage.cacheMissTokens
  )
  const hitRate = effectiveCacheHitRate(
    usage.turnCacheHitTokens,
    usage.turnCacheMissTokens,
    usage.cacheHitTokens,
    usage.cacheMissTokens
  )
  const cacheTitle = hitRate !== null
    ? `缓存命中率 ${hitRate.toFixed(0)}%（命中 ${formatTokensK(cacheHit)} / 未命中 ${formatTokensK(cacheMiss)}）`
    : '缓存命中率（暂无 API 数据）'

  const sessionTitle = usage.sessionTokens > 0
    ? `会话累计 ${usage.sessionTokens.toLocaleString()} tokens（API usage）`
    : '会话累计 Token'

  const sessionCost = usage.cost
  const displayProjectCost = Math.max(projectCost, sessionCost)
  const projectCostTitle = displayProjectCost > 0
    ? `当前项目累计花费约 ￥${displayProjectCost.toFixed(4)}（API token × 官网单价估算）`
    : '当前项目累计花费（API token × 官网单价估算）'
  const sessionCostTitle = sessionCost > 0
    ? `当前会话花费约 ￥${sessionCost.toFixed(4)}（API token × 官网单价估算）`
    : '当前会话花费（API token × 官网单价估算）'

  const versionsText = projectVersions ? formatProjectVersions(projectVersions) : null

  return (
    <div className="statusbar">
      <span className="statusbar-agent">
        <span className={`dot ${running ? 'dot-busy' : 'dot-idle'}`} />
        <span className="mc-t">{running ? '运行中' : '就绪'}</span>
      </span>

      <span className="stat-sep">|</span>
      <span className="statusbar-model stat mc-dim">{providerLabel || 'ModCrafting'}</span>

      {deepseekBalanceLabel && (
        <>
          <span className="stat-sep">|</span>
          <span className="statusbar-metrics stat" title="DeepSeek 账户余额（GET /user/balance）">
            <span className="stat-label">余额</span>
            <span className="stat-value">{deepseekBalanceLabel}</span>
          </span>
        </>
      )}

      <span className="stat-sep">|</span>
      <span className="statusbar-metrics stat" title={sessionTitle}>
        <span className="stat-label">会话</span>
        <span className="stat-value">{formatTokensK(usage.sessionTokens)}</span>
      </span>

      <span className="stat-sep">|</span>
      <span className="statusbar-metrics stat" title={projectCostTitle}>
        <span className="stat-label">项目</span>
        <span className="stat-value">{formatCostCny(displayProjectCost)}</span>
      </span>

      <span className="stat-sep">|</span>
      <span className="statusbar-metrics stat" title={sessionCostTitle}>
        <span className="stat-label">本会话</span>
        <span className="stat-value">{formatCostCny(sessionCost)}</span>
      </span>

      <span className="stat-sep">|</span>
      <span className="statusbar-context stat" title={contextTitle}>
        <span className="stat-label">上下文</span>
        <span className="stat-value">{contextLimitLabel}</span>
        <span className="stat-label">·</span>
        <span className="stat-value">{xpPercent}%</span>
        <span className={`statusbar-context-bar ${contextLevelClass(xpPercent)}`}>
          <span className="statusbar-context-bar__frame">
            <span className="statusbar-context-bar__track">
              <span
                className="statusbar-context-bar__fill"
                style={{ width: `${xpPercent > 0 ? Math.max(xpPercent, 4) : 0}%` }}
              />
            </span>
          </span>
        </span>
      </span>

      <span className="stat-sep">|</span>
      <span className="statusbar-cache stat" title={cacheTitle}>
        <span className="stat-label">命中</span>
        <span className="stat-value">{hitRate !== null ? `${hitRate.toFixed(0)}%` : '—'}</span>
      </span>

      {projectVersions && (
        <>
          <span className="stat-sep">|</span>
          <span className="statusbar-mc statusbar-mc-versions stat mc-dim" title={versionsText || undefined}>
            {versionsText}
          </span>
        </>
      )}

      {mcRuntime && mcRuntime.kind !== 'idle' && (
        <>
          <span className="stat-sep">|</span>
          <span
            className={`statusbar-mc statusbar-mc-runtime stat ${
              mcRuntime.kind === 'build' && mcRuntime.failed
                ? 'stat-bad'
                : mcRuntime.kind === 'game' && mcRuntime.variant === 'crashed'
                  ? 'stat-bad'
                  : mcRuntime.kind === 'build' || mcRuntime.kind === 'game'
                    ? 'stat-good'
                    : 'stat-ok'
            }`}
            title="项目运行状态"
          >
            <span className="stat-value">{mcRuntime.label}</span>
          </span>
        </>
      )}

      {toolchain && (
        <span className="statusbar-env stat" title={toolchainProgress || 'JDK · Gradle · 离线依赖'}>
          <span className={`stat-value ${envReady ? 'stat-good' : toolchainPercent !== undefined ? 'stat-ok' : ''}`}>
            {envText}
          </span>
        </span>
      )}
    </div>
  )
}

export default StatusBar
