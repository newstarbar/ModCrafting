import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { DisplayMessage } from '../types/display-message'
import type { PlanStep } from './TaskPlan'
import type { ChatTurn } from '../utils/chat-turns'
import { formatMessageTime, messagePlainText, turnShareText } from '../utils/message-text'

interface MessageFooterProps {
  role: 'user' | 'assistant'
  message: DisplayMessage
  turn: ChatTurn
  isLoading?: boolean
  onRetry?: (turnId: string) => void
  onRollback?: (msgId: string) => void
  canRollback?: boolean
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const statusIcon: Record<PlanStep['status'], string> = {
  completed: '✓',
  running: '◐',
  error: '✕',
  pending: '○'
}

const statusLabel: Record<PlanStep['status'], string> = {
  completed: '完成',
  running: '进行中',
  error: '失败',
  pending: '待办'
}

const MessageFooter: React.FC<MessageFooterProps> = ({
  role,
  message,
  turn,
  isLoading = false,
  onRetry,
  onRollback,
  canRollback = false
}) => {
  const [feedback, setFeedback] = useState('')
  const timerRef = useRef<number | null>(null)

  const showFeedback = useCallback((text: string) => {
    setFeedback(text)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setFeedback(''), 2000)
  }, [])

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
  }, [])

  const isStreaming = role === 'assistant' && Boolean(message.isStreaming && !message.turnStatus)
  const canRetry = role === 'assistant' && Boolean(turn.user) && !isStreaming && !isLoading

  const handleCopy = async () => {
    const ok = await copyText(messagePlainText(message))
    showFeedback(ok ? '已复制' : '复制失败')
  }

  const handleShare = async () => {
    const ok = await copyText(turnShareText(turn.user, turn.assistant))
    showFeedback(ok ? '已复制，可粘贴分享' : '复制失败')
  }

  const handleRetry = () => {
    if (!canRetry || !onRetry || !turn.user) return
    onRetry(turn.id)
  }

  // Hide footer entirely during streaming
  if (isStreaming) return null

  const plan = message.embeddedPlan
  const hasPlan = role === 'assistant' && plan != null && plan.length > 0
  const doneCount = hasPlan ? plan!.filter(s => s.status === 'completed').length : 0
  const totalCount = hasPlan ? plan!.length : 0

  return (
    <div className="bubble-ft">
      {hasPlan && (
        <>
          <div className="bubble-ft__task-status">
            <div className="bubble-ft__task-header">
              <span className="bubble-ft__task-title">任务进度</span>
              <span className="bubble-ft__task-count">{doneCount}/{totalCount} 已完成</span>
            </div>
            {plan!.map((step) => (
              <div key={step.id} className={`bubble-ft__step bubble-ft__step--${step.status}`}>
                <span className="bubble-ft__step-id">{step.id}</span>
                <span className="bubble-ft__step-icon">{statusIcon[step.status]}</span>
                <span className="bubble-ft__step-desc">{step.description}</span>
                <span className="bubble-ft__step-status">{statusLabel[step.status]}</span>
              </div>
            ))}
          </div>
          <div className="bubble-ft__separator" />
        </>
      )}
      <span className="bubble-ft__time">{formatMessageTime(message.timestamp)}</span>
      {feedback ? (
        <span className="bubble-ft__feedback">{feedback}</span>
      ) : (
        <span className="bubble-ft__actions">
          <button type="button" className="bubble-ft__btn" onClick={() => void handleCopy()}>
            复制
          </button>
          {role === 'assistant' && (
            <>
              <span className="bubble-ft__dot">·</span>
              <button type="button" className="bubble-ft__btn" onClick={() => void handleShare()}>
                转发
              </button>
              {turn.user && (
                <>
                  <span className="bubble-ft__dot">·</span>
                  <button
                    type="button"
                    className="bubble-ft__btn"
                    onClick={handleRetry}
                    disabled={!canRetry}
                  >
                    重试
                  </button>
                </>
              )}
            </>
          )}
          {role === 'user' && canRollback && (
            <>
              <span className="bubble-ft__dot">·</span>
              <button
                type="button"
                className="bubble-ft__btn bubble-ft__btn--rollback"
                onClick={() => onRollback?.(message.id)}
                disabled={isLoading}
              >
                回滚
              </button>
            </>
          )}
        </span>
      )}
    </div>
  )
}

export default MessageFooter
