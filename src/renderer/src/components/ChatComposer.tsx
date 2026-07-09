import React, { useState } from 'react'
import { IconSend, IconSquare } from './Icon'
import QuickCreateBar from './QuickCreateBar'
import ComposerModeMenu from './ComposerModeMenu'
import ComposerModelMenu from './ComposerModelMenu'
import type { ComposerMode } from '../harness/turn-intent'

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
	model: string
	onModelChange: (modelId: string) => void
	onOpenApiSettings?: () => void
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
	model,
	onModelChange,
	onOpenApiSettings,
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
			{hasProject && onQuickTemplateSelect && (
				<QuickCreateBar disabled={disabled} onSelect={onQuickTemplateSelect} />
			)}

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
				{goalExpanded && (
					<div className="chat-input-composite__goal-expanded">
						<textarea
							className="chat-composer__goal chat-composer__goal--expanded"
							placeholder="本模组本轮要达成什么？（可选）"
							value={sessionGoal}
							onChange={(e) => onSessionGoalChange(e.target.value)}
							rows={2}
							disabled={disabled}
						/>
					</div>
				)}

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

				<div className="chat-input-composite__footer">
					{goalExpanded ? (
						<button
							type="button"
							className="chat-composer__goal-collapse"
							onClick={() => setGoalExpanded(false)}
							disabled={disabled}
						>
							收起目标
						</button>
					) : (
						<button
							type="button"
							className="chat-composer__goal chat-composer__goal--chip chat-composer__goal--footer"
							onClick={() => setGoalExpanded(true)}
							disabled={disabled}
							title="点击编辑会话目标"
						>
							<span className="chat-composer__goal-label">目标</span>
							{sessionGoal.trim() ? (
								<span className="chat-composer__goal-text">{sessionGoal.trim()}</span>
							) : (
								<span className="chat-composer__goal-text chat-composer__goal-text--empty">未设置</span>
							)}
						</button>
					)}

					<ComposerModeMenu
						value={composerMode}
						onChange={onComposerModeChange}
						disabled={isLoading || disabled}
					/>

					<div className="chat-input-composite__footer-spacer" />

					<ComposerModelMenu
						value={model}
						onChange={onModelChange}
						onOpenApiSettings={onOpenApiSettings}
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
		</div>
	)
}

export default ChatComposer
