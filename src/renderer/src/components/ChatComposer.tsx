import React, { useRef, useState } from 'react'
import { IconSend, IconSquare, IconPaperclip, IconX } from './Icon'
import QuickCreateBar from './QuickCreateBar'
import ComposerModeMenu from './ComposerModeMenu'
import ComposerModelMenu, { type ProviderModelSelection } from './ComposerModelMenu'
import type { ComposerMode } from '../harness/turn-intent'
import type { ComposerAttachment } from '../context/context-ingress'
import { hasImageAttachment } from '../context/context-ingress'
import { isVisionCapableModel } from '../harness/chat-message'

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
	providerId: string
	modelId: string
	onProviderModelChange: (selection: ProviderModelSelection) => void
	onOpenApiSettings?: () => void
	onQuickTemplateSelect?: (templateId: string, name: string) => void
	attachments?: ComposerAttachment[]
	onRemoveAttachment?: (id: string) => void
	onAttachFiles?: () => void
	onPasteFiles?: (items: DataTransferItemList) => void
	onDropFiles?: (files: FileList) => void
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
	providerId,
	modelId,
	onProviderModelChange,
	onOpenApiSettings,
	onQuickTemplateSelect,
	attachments = [],
	onRemoveAttachment,
	onAttachFiles,
	onPasteFiles,
	onDropFiles,
}) => {
	const [goalExpanded, setGoalExpanded] = useState(false)
	const [dragOver, setDragOver] = useState(false)
	const compositeRef = useRef<HTMLDivElement>(null)

	const hasImages = hasImageAttachment(attachments)
	const visionOk = !hasImages || isVisionCapableModel(modelId, providerId)
	const canSend =
		!disabled &&
		!isLoading &&
		(Boolean(input.trim()) || attachments.length > 0) &&
		visionOk

	const placeholder = !toolchainReady
		? '等待构建环境就绪…'
		: !hasProject
			? '请先打开项目'
			: !visionOk
				? '当前模型不支持图片，请移除图片或切换视觉模型…'
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

			<div
				ref={compositeRef}
				className={`chat-input-composite${dragOver ? ' chat-input-composite--drag' : ''}`}
				onDragEnter={(e) => {
					e.preventDefault()
					if (disabled || !onDropFiles) return
					setDragOver(true)
				}}
				onDragOver={(e) => {
					e.preventDefault()
					if (disabled || !onDropFiles) return
					setDragOver(true)
				}}
				onDragLeave={(e) => {
					if (!compositeRef.current?.contains(e.relatedTarget as Node)) {
						setDragOver(false)
					}
				}}
				onDrop={(e) => {
					e.preventDefault()
					setDragOver(false)
					if (disabled || !onDropFiles || !e.dataTransfer.files?.length) return
					onDropFiles(e.dataTransfer.files)
				}}
			>
				{attachments.length > 0 && (
					<div className="chat-composer__attachments">
						{attachments.map((att) => (
							<div
								key={att.id}
								className={`chat-composer__attachment chat-composer__attachment--${att.kind}`}
							>
								{att.kind === 'image' ? (
									att.previewUrl ? (
										<img src={att.previewUrl} alt={att.name || '图片'} className="chat-composer__attachment-thumb" />
									) : (
										<span className="chat-composer__attachment-name">{att.name || '图片'}</span>
									)
								) : (
									<span className="chat-composer__attachment-name" title={att.path}>
										{att.name}
									</span>
								)}
								{onRemoveAttachment && (
									<button
										type="button"
										className="chat-composer__attachment-remove"
										onClick={() => onRemoveAttachment(att.id)}
										disabled={disabled}
										aria-label="移除附件"
									>
										<IconX size="sm" />
									</button>
								)}
							</div>
						))}
					</div>
				)}

				{!visionOk && (
					<div className="chat-composer__vision-warn">
						当前模型不支持图片理解，请移除图片或切换到视觉模型后再发送
					</div>
				)}

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
					onPaste={(e) => {
						const items = e.clipboardData?.items
						if (!items || !onPasteFiles) return
						const hasFile = Array.from(items).some((it) => it.kind === 'file')
						if (hasFile) {
							e.preventDefault()
							onPasteFiles(items)
						}
					}}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
							if (canSend) onSend()
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

					{onAttachFiles && (
						<button
							type="button"
							className="chat-composer__attach-btn"
							onClick={onAttachFiles}
							disabled={disabled || isLoading}
							title="添加附件"
						>
							<IconPaperclip size="sm" />
						</button>
					)}

					<ComposerModeMenu
						value={composerMode}
						onChange={onComposerModeChange}
						disabled={isLoading || disabled}
					/>

					<div className="chat-input-composite__footer-spacer" />

					<ComposerModelMenu
						providerId={providerId}
						modelId={modelId}
						onChange={onProviderModelChange}
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
								disabled={!canSend}
								title={!visionOk ? '当前模型不支持图片' : undefined}
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
