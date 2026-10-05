import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  cacheHitMissForDisplay,
  contextWindowLimit,
  effectiveCacheHitRate,
  formatContextLimit,
  formatCostCny,
  formatTokensK,
  workingContextWindow,
  type UsageStats
} from '../utils/usage'
import {
  CONTEXT_CATEGORY_LABELS,
  isContextDuplicateNotable,
  type ContextAttribution
} from '../utils/context-attribution'
import ContextBreakdown from './ContextBreakdown'
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
  /** Category split of the last real prompt. Absent → the bar falls back to a single fill. */
  attribution?: ContextAttribution | null
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
  mcRuntime,
  attribution = null
}) => {
  // The status bar is a scroll container (overflow-x), which clips any
  // absolutely positioned child, so the popover is portalled to <body>.
  const contextAnchorRef = useRef<HTMLSpanElement>(null)
  const [breakdownOpen, setBreakdownOpen] = useState(false)
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 })

  const syncPopoverPosition = useCallback(() => {
    const el = contextAnchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const popoverWidth = Math.min(480, window.innerWidth - 24)
    // Anchored by its right edge; keep the box inside the viewport.
    const right = Math.max(Math.min(rect.right, window.innerWidth - 12), popoverWidth + 12)
    setPopoverPos({ top: rect.top - 8, left: right })
  }, [])

  const toggleBreakdown = useCallback(() => {
    setBreakdownOpen((open) => {
      if (!open) syncPopoverPosition()
      return !open
    })
  }, [syncPopoverPosition])

  useEffect(() => {
    if (!breakdownOpen) return
    if (!attribution) setBreakdownOpen(false)
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.statusbar-context') || target?.closest('.context-breakdown')) return
      setBreakdownOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBreakdownOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', syncPopoverPosition)
    window.addEventListener('scroll', syncPopoverPosition, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', syncPopoverPosition)
      window.removeEventListener('scroll', syncPopoverPosition, true)
    }
  }, [breakdownOpen, attribution, syncPopoverPosition])

  const envReady = toolchain
    && toolchain.jdk === 'ready'
    && toolchain.gradle === 'ready'
    && toolchain.deps === 'ready'

  const envText = toolchainPercent !== undefined
    ? `初始化 ${toolchainPercent}%`
    : envReady
      ? '环境就绪'
      : toolchainProgress || '环境检查中'

  const claimedLimit = contextWindowLimit(modelId, providerId)
  const workingLimit = workingContextWindow(modelId, providerId)
  const contextLimitLabel = formatContextLimit(workingLimit)
  const xpPercent = Math.min(100, Math.max(0, usage.contextPercent))
  const claimedNote =
    claimedLimit !== workingLimit
      ? `；模型标称 ${formatContextLimit(claimedLimit)}`
      : ''
  const contextTitle = xpPercent > 80
    ? `上下文占用约 ${xpPercent}%（即将满载 / 有效窗口 ${workingLimit.toLocaleString()}）`
    : `上下文占用约 ${xpPercent}%（prompt ${usage.lastPromptTokens.toLocaleString()} / 有效窗口 ${workingLimit.toLocaleString()}${claimedNote}）`

  const duplicateNote = attribution && attribution.duplicateShare > 0.02
    ? `；重复内容约 ${Math.round(attribution.duplicateShare * 100)}%`
    : ''
  const segments = attribution?.categories?.length ? attribution.categories : null

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
    ? `当前项目累计花费约 ￥${displayProjectCost.toFixed(4)}（API token × 中文官网人民币单价）`
    : '当前项目累计花费（API token × 中文官网人民币单价）'
  const sessionCostTitle = sessionCost > 0
    ? `当前会话花费约 ￥${sessionCost.toFixed(4)}（API token × 中文官网人民币单价）`
    : '当前会话花费（API token × 中文官网人民币单价）'

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
      <span
        ref={contextAnchorRef}
        className={`statusbar-context stat${attribution ? ' statusbar-context--clickable' : ''}`}
        title={`${contextTitle}${duplicateNote}`}
        role={attribution ? 'button' : undefined}
        tabIndex={attribution ? 0 : undefined}
        aria-expanded={attribution ? breakdownOpen : undefined}
        aria-label={attribution ? '上下文占用归因' : undefined}
        onClick={attribution ? toggleBreakdown : undefined}
        onKeyDown={attribution
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                toggleBreakdown()
              }
            }
          : undefined}
      >
        <span className="stat-label">上下文</span>
        <span className="stat-value">{contextLimitLabel}</span>
        <span className="stat-label">·</span>
        <span className="stat-value">{xpPercent}%</span>
        <span className={`statusbar-context-bar ${contextLevelClass(xpPercent)}`}>
          <span className="statusbar-context-bar__frame">
            <span className="statusbar-context-bar__track">
              {segments ? (
                <span
                  className="statusbar-context-segments"
                  style={{ width: `${xpPercent > 0 ? Math.max(xpPercent, 3) : 0}%` }}
                >
                  {segments.map((slice) => (
                    <span
                      key={slice.category}
                      className={`statusbar-context-seg statusbar-context-seg--${slice.category}`}
                      style={{ flexGrow: slice.share, flexShrink: 0 }}
                      title={`${CONTEXT_CATEGORY_LABELS[slice.category]} 占 prompt ${Math.round(slice.share * 100)}%`}
                    />
                  ))}
                </span>
              ) : (
                <span
                  className="statusbar-context-bar__fill"
                  style={{ width: `${xpPercent > 0 ? Math.max(xpPercent, 4) : 0}%` }}
                />
              )}
            </span>
          </span>
        </span>
        {isContextDuplicateNotable(attribution) && (
          <span
            className="statusbar-context-dup"
            title={`重复内容约占可见上下文 ${Math.round((attribution?.duplicateShare || 0) * 100)}%`}
          >
            重复 {Math.round((attribution?.duplicateShare || 0) * 100)}%
          </span>
        )}
        {attribution && <span className={`statusbar-context-caret${breakdownOpen ? ' is-open' : ''}`}>▸</span>}
      </span>
      {breakdownOpen && attribution && createPortal(
        <ContextBreakdown
          attribution={attribution}
          cacheHitTokens={usage.cacheHitTokens}
          cacheMissTokens={usage.cacheMissTokens}
          anchor={popoverPos}
          onClose={() => setBreakdownOpen(false)}
        />,
        document.body
      )}

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
