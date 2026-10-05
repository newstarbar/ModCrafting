import React, { useEffect } from 'react'
import {
  CONTEXT_CATEGORY_LABELS,
  formatContextBytes,
  type ContextAttribution
} from '../utils/context-attribution'
import { formatTokensK } from '../utils/usage'
import { IconX } from './Icon'

interface ContextBreakdownProps {
  attribution: ContextAttribution
  /** Cache split from API usage, used for the billed-vs-window view. */
  cacheHitTokens?: number
  cacheMissTokens?: number
  /** Viewport anchor computed by StatusBar; rendered through a portal. */
  anchor: { top: number; left: number }
  onClose: () => void
}

const pct = (share: number): string => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`

const ContextBreakdown: React.FC<ContextBreakdownProps> = ({
  attribution,
  cacheHitTokens = 0,
  cacheMissTokens = 0,
  anchor,
  onClose
}) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const billed = attribution.promptTokens * (1 - Math.min(
    0.99,
    cacheHitTokens + cacheMissTokens > 0
      ? cacheHitTokens / (cacheHitTokens + cacheMissTokens)
      : 0
  ))
  const billedPercent = attribution.windowTokens > 0
    ? Math.min(100, Math.round((billed / attribution.windowTokens) * 100))
    : 0

  return (
    <div
      className="context-breakdown"
      role="dialog"
      aria-label="上下文占用归因"
      style={{
        position: 'fixed',
        top: anchor.top,
        left: anchor.left,
        transform: 'translate(-100%, -100%)'
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="context-breakdown__header">
        <span className="context-breakdown__title mc-t">上下文占用归因</span>
        <button type="button" className="context-breakdown__close" onClick={onClose} title="关闭">
          <IconX size="sm" />
        </button>
      </div>

      <div className="context-breakdown__summary">
        <span>prompt <b>{formatTokensK(attribution.promptTokens)}</b></span>
        <span>窗口 <b>{formatTokensK(attribution.windowTokens)}</b></span>
        <span>占用 <b>{attribution.percent}%</b></span>
        {(cacheHitTokens + cacheMissTokens) > 0 && (
          <span title="缓存命中部分按更低单价计费；此处仅按 token 折算等效占用">
            计费等效 <b>{billedPercent}%</b>
          </span>
        )}
        <span className={attribution.anchored ? 'context-breakdown__tag context-breakdown__tag--api' : 'context-breakdown__tag context-breakdown__tag--est'}>
          {attribution.anchored ? '已按 API usage 锚定' : '仅本地估算（无 API usage）'}
        </span>
      </div>

      <table className="context-breakdown__table">
        <thead>
          <tr><th>分类</th><th>Token</th><th>占比</th><th>字节</th></tr>
        </thead>
        <tbody>
          {attribution.categories.map((slice) => (
            <tr key={slice.category} className={`context-breakdown__row context-breakdown__row--${slice.category}`}>
              <td>
                <span className={`context-breakdown__swatch context-breakdown__swatch--${slice.category}`} />
                {CONTEXT_CATEGORY_LABELS[slice.category]}
              </td>
              <td>{formatTokensK(slice.tokens)}</td>
              <td>{pct(slice.share)}</td>
              <td>{slice.bytes > 0 ? formatContextBytes(slice.bytes) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {attribution.unaccountedTokens > 0 && (
        <p className="context-breakdown__note">
          未归类 {pct(attribution.unaccountedShare)} —— 逐轮步骤注入与工具 schema 不随控制器快照持久化，无法精确拆分。
        </p>
      )}

      {attribution.duplicates.length > 0 && (
        <section className="context-breakdown__section">
          <h4 className="context-breakdown__section-title">
            重复内容 · 浪费 {formatTokensK(attribution.duplicateWasteTokens)}（{pct(attribution.duplicateShare)}）
          </h4>
          <ul className="context-breakdown__list">
            {attribution.duplicates.map((group) => (
              <li key={`${group.fingerprint}-${group.exact}`} className="context-breakdown__dup">
                <span className={`context-breakdown__badge context-breakdown__badge--${group.exact ? 'exact' : 'near'}`}>
                  {group.exact ? '完全相同' : '近似'} ×{group.count}
                </span>
                <span className="context-breakdown__waste">-{formatTokensK(group.wastedTokens)}</span>
                <span className="context-breakdown__roles" title={group.roles.join(' / ')}>{group.roles.slice(0, 3).join(' / ')}</span>
                <code className="context-breakdown__sample">{group.sample.slice(0, 80)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="context-breakdown__section">
        <h4 className="context-breakdown__section-title">最大的 {attribution.topMessages.length} 条消息</h4>
        <ul className="context-breakdown__list">
          {attribution.topMessages.map((message) => (
            <li key={`${message.index}-${message.category}`} className="context-breakdown__top">
              <span className="context-breakdown__idx">[{message.index}]</span>
              <span className="context-breakdown__who">{message.role}{message.name ? `/${message.name}` : ''}</span>
              <span className="context-breakdown__tok">{formatTokensK(message.tokens)}</span>
              <code className="context-breakdown__sample">{message.preview.slice(0, 72)}</code>
            </li>
          ))}
        </ul>
      </section>

      {attribution.byTool.length > 0 && (
        <section className="context-breakdown__section">
          <h4 className="context-breakdown__section-title">工具结果体积</h4>
          <ul className="context-breakdown__list context-breakdown__list--tools">
            {attribution.byTool.map((tool) => (
              <li key={tool.name}>
                <code>{tool.name}</code>
                <span>{formatTokensK(tool.tokens)} · {tool.count} 次</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="context-breakdown__disclaimer">
        Token 绝对值为按 API prompt_tokens 锚定的估算（中文按 1 字 ≈ 1 token），未使用官方分词器。
      </p>
    </div>
  )
}

export default ContextBreakdown
