import React, { useState } from 'react'
import { IconSend, IconSquare } from './Icon'
import QuickCreateBar from './QuickCreateBar'
import type { ComposerMode } from '../harness/turn-intent'

const MODE_OPTIONS: { id: ComposerMode; label: string; hint: string }[] = [
  { id: 'agent', label: 'Agent', hint: '自动规划并执行' },
  { id: 'plan', label: 'Plan', hint: '仅生成计划，确认后执行' },
  { id: 'ask', label: 'Ask', hint: '问答模式，不调用工具' }
]

export interface ChatComposerProps {
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  onCancel: () => void
  isLoading: boolean
  disabled: boolean
  composerMode: ComposerMode
  onComposerModeChange: (mode: ComposerMode) => void
  sessionGoal: string
  onSessionGoalChange: (goal: string) => void
  planReady: boolean
  onExecutePlan: () => void
  toolchainReady: boolean
  hasProject: boolean
  onQuickTemplateSelect?: (templateId: string, name: string) => void
}

const ChatComposer: React.FC<ChatComposerProps> = ({
  input,
  onInputChange,
  onSend,
  onCancel,
  isLoading,
  disabled,
  composerMode,
  onComposerModeChange,
  sessionGoal,
  onSessionGoalChange,
  planReady,
  onExecutePlan,
  toolchainReady,
  hasProject,
  onQuickTemplateSelect,
}) => {
  const [goalExpanded, setGoalExpanded] = useState(false)

  const placeholder = !toolchainReady
    ? '等待构建环境就绪…'
    : !hasProject
      ? '请先打开项目'
      : composerMode === 'ask'
        ? '提问或请求解释…'
        : composerMode === 'plan'
          ? '描述功能，生成实施计划…'
          : '描述功能或问题…'

  return (
    <div className="chat-composer">
      <div className="chat-composer__goal-wrap">
        {goalExpanded ? (
          <textarea
            className="chat-composer__goal chat-composer__goal--expanded"
            placeholder="本模组本轮要达成什么？（可选）"
            value={sessionGoal}
            onChange={(e) => onSessionGoalChange(e.target.value)}
            rows={2}
            disabled={disabled}
          />
        ) : (
          <button
            type="button"
            className="chat-composer__goal chat-composer__goal--chip"
            onClick={() => setGoalExpanded(true)}
            disabled={disabled}
            title="点击编辑会话目标"
          >
            <span className="chat-composer__goal-label">目标</span>
            <span className="chat-composer__goal-text">
              {sessionGoal.trim() || '点击设置本轮开发目标（可选）'}
            </span>
          </button>
        )}
        {goalExpanded && (
          <button
            type="button"
            className="chat-composer__goal-collapse"
            onClick={() => setGoalExpanded(false)}
          >
            收起
          </button>
        )}
      </div>

      {hasProject && onQuickTemplateSelect && (
        <QuickCreateBar
          disabled={disabled}
          onSelect={onQuickTemplateSelect}
        />
      )}

      <div className="chat-composer__modes" role="tablist" aria-label="对话模式">
        {MODE_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={composerMode === opt.id}
            className={`chat-composer__mode${composerMode === opt.id ? ' chat-composer__mode--active' : ''}`}
            onClick={() => onComposerModeChange(opt.id)}
            disabled={isLoading}
            title={opt.hint}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {planReady && composerMode === 'plan' && (
        <div className="chat-composer__execute-bar">
          <span className="chat-composer__execute-hint">计划已就绪，确认后开始执行</span>
          <button
            type="button"
            className="mc-btn mc-btn--primary"
            onClick={onExecutePlan}
            disabled={isLoading || !hasProject}
          >
            执行计划
          </button>
        </div>
      )}

      <div className="chat-input-composite">
        <textarea
          className="chat-input-composite__field"
          placeholder={placeholder}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          disabled={disabled}
        />
        <div className="chat-input-composite__actions">
          {isLoading ? (
            <button type="button" className="mc-btn mc-btn--red chat-send-btn" onClick={onCancel}>
              <IconSquare size="sm" /> 停止
            </button>
          ) : (
            <button
              type="button"
              className="mc-btn mc-btn--primary chat-send-btn"
              onClick={onSend}
              disabled={disabled || !input.trim()}
            >
              <IconSend size="sm" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ChatComposer
