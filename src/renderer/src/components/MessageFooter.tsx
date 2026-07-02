import React, { useState, useCallback, useEffect, useRef } from 'react'
import type { DisplayMessage } from '../types/display-message'
import type { ChatTurn } from '../utils/chat-turns'
import { formatMessageTime, messagePlainText, turnShareText } from '../utils/message-text'

interface MessageFooterProps {
  role: 'user' | 'assistant'
  message: DisplayMessage
  turn: ChatTurn
  isLoading?: boolean
  onRetry?: (turnId: string) => void
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const MessageFooter: React.FC<MessageFooterProps> = ({
  role,
  message,
  turn,
  isLoading = false,
  onRetry
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

  return (
    <div className="bubble-ft">
      <span className="bubble-ft__time">{formatMessageTime(message.timestamp)}</span>
      {feedback ? (
        <span className="bubble-ft__feedback">{feedback}</span>
      ) : (
        <span className="bubble-ft__actions">
          <button type="button" className="bubble-ft__btn" onClick={() => void handleCopy()}>
            复制
          </button>
          {role === 'assistant' && !isStreaming && (
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
        </span>
      )}
    </div>
  )
}

export default MessageFooter
