import React, { useEffect, useMemo, useState } from 'react'
import type { ChatTurn } from '../utils/chat-turns'

export const EXPORT_TURN_LIMIT_OPTIONS = [3, 6, 10] as const
export type ExportTurnLimit = (typeof EXPORT_TURN_LIMIT_OPTIONS)[number]
export const DEFAULT_EXPORT_TURN_LIMIT: ExportTurnLimit = 6

export interface SessionExportPanelProps {
  turns: ChatTurn[]
  disabled?: boolean
  onConfirm: (selectedTurnIds: string[], limit: ExportTurnLimit) => void
  onCancel: () => void
}

function turnPreview(turn: ChatTurn): string {
  const text = (turn.user?.content || turn.assistant?.content || '').trim().replace(/\s+/g, ' ')
  if (!text) return turn.user?.attachments?.length ? '（仅附件）' : '（无内容）'
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

function turnTimeLabel(turn: ChatTurn): string {
  const ts = turn.user?.timestamp || turn.assistant?.timestamp
  if (!ts) return '无时间'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return '无时间'
  }
}

function turnStatusLabel(turn: ChatTurn): string {
  const status = turn.assistant?.turnStatus
  if (!status) return turn.assistant ? '进行中/未知' : '仅用户'
  return status
}

/** 打开面板时：默认全选，但若超过上限则只勾选最近 N 轮。 */
export function initialSelectedTurnIds(turns: ChatTurn[], limit: number): {
  ids: Set<string>
  truncated: boolean
} {
  if (turns.length <= limit) {
    return { ids: new Set(turns.map((t) => t.id)), truncated: false }
  }
  const recent = turns.slice(-limit)
  return { ids: new Set(recent.map((t) => t.id)), truncated: true }
}

/**
 * 导出会话轮次勾选面板：默认全选、数量上限、确认后由近到远导出。
 */
const SessionExportPanel: React.FC<SessionExportPanelProps> = ({
  turns,
  disabled = false,
  onConfirm,
  onCancel,
}) => {
  const [limit, setLimit] = useState<ExportTurnLimit>(DEFAULT_EXPORT_TURN_LIMIT)
  const [selected, setSelected] = useState<Set<string>>(() => initialSelectedTurnIds(turns, DEFAULT_EXPORT_TURN_LIMIT).ids)
  const [truncatedHint, setTruncatedHint] = useState(
    () => initialSelectedTurnIds(turns, DEFAULT_EXPORT_TURN_LIMIT).truncated
  )

  useEffect(() => {
    const next = initialSelectedTurnIds(turns, limit)
    setSelected(next.ids)
    setTruncatedHint(next.truncated)
  }, [turns, limit])

  const selectedCount = selected.size
  const canConfirm = selectedCount > 0 && !disabled

  const listedTurns = useMemo(() => {
    // 面板列表：由近到远，便于勾选最近轮次
    return [...turns].reverse()
  }, [turns])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else {
        if (next.size >= limit) return prev
        next.add(id)
      }
      return next
    })
    setTruncatedHint(false)
  }

  const selectAllWithinLimit = () => {
    const next = initialSelectedTurnIds(turns, limit)
    setSelected(next.ids)
    setTruncatedHint(next.truncated)
  }

  const clearAll = () => {
    setSelected(new Set())
    setTruncatedHint(false)
  }

  return (
    <div className="session-export-overlay" role="dialog" aria-label="导出会话轮次" tabIndex={-1}>
      <div className="session-export-panel">
        <div className="session-export-panel__hd">
          <div>
            <div className="session-export-panel__title">导出诊断 Markdown</div>
            <div className="session-export-panel__sub">
              勾选当前会话轮次 · 导出正文由近到远（最新在前）
            </div>
          </div>
          <button type="button" className="session-export-panel__close" onClick={onCancel} disabled={disabled}>
            ✕
          </button>
        </div>

        <div className="session-export-panel__toolbar">
          <label className="session-export-panel__limit">
            上限
            <select
              value={limit}
              disabled={disabled}
              onChange={(e) => setLimit(Number(e.target.value) as ExportTurnLimit)}
            >
              {EXPORT_TURN_LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  最近 {n} 轮
                </option>
              ))}
            </select>
          </label>
          <div className="session-export-panel__actions-inline">
            <button type="button" onClick={selectAllWithinLimit} disabled={disabled}>
              按上限全选
            </button>
            <button type="button" onClick={clearAll} disabled={disabled}>
              清空
            </button>
          </div>
          <span className="session-export-panel__count">
            已选 {selectedCount} / {turns.length}
          </span>
        </div>

        {truncatedHint && (
          <div className="session-export-panel__hint">已按上限截取最近 {limit} 轮</div>
        )}

        <div className="session-export-panel__list">
          {listedTurns.length === 0 ? (
            <div className="session-export-panel__empty">当前会话没有可导出的轮次</div>
          ) : (
            listedTurns.map((turn, index) => {
              const checked = selected.has(turn.id)
              const atCap = !checked && selected.size >= limit
              const chronIndex = turns.findIndex((t) => t.id === turn.id) + 1
              return (
                <label
                  key={turn.id}
                  className={`session-export-panel__row${checked ? ' is-selected' : ''}${atCap ? ' is-disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || atCap}
                    onChange={() => toggle(turn.id)}
                  />
                  <div className="session-export-panel__row-body">
                    <div className="session-export-panel__row-top">
                      <span className="session-export-panel__turn-idx">
                        第 {chronIndex} 轮 · 近→远 #{index + 1}
                      </span>
                      <span className="session-export-panel__turn-status">{turnStatusLabel(turn)}</span>
                    </div>
                    <div className="session-export-panel__row-preview">{turnPreview(turn)}</div>
                    <div className="session-export-panel__row-meta">{turnTimeLabel(turn)}</div>
                  </div>
                </label>
              )
            })
          )}
        </div>

        <div className="session-export-panel__footer">
          <button
            type="button"
            className="session-export-panel__btn session-export-panel__btn--ghost"
            onClick={onCancel}
            disabled={disabled}
          >
            取消
          </button>
          <button
            type="button"
            className="session-export-panel__btn session-export-panel__btn--confirm"
            disabled={!canConfirm}
            onClick={() => onConfirm([...selected], limit)}
          >
            导出已选 {selectedCount} 轮
          </button>
        </div>
      </div>
    </div>
  )
}

export default SessionExportPanel
