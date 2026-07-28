import React, { useEffect, useRef, useState } from 'react'
import { IconSend, IconSquare, IconPaperclip, IconX, IconExpand } from './Icon'
import QuickCreateBar from './QuickCreateBar'
import ComposerModeMenu from './ComposerModeMenu'
import ComposerModelMenu, { type ProviderModelSelection } from './ComposerModelMenu'
import type { ComposerMode } from '../harness/turn-intent'
import type { ComposerAttachment } from '../context/context-ingress'
import { hasImageAttachment } from '../context/context-ingress'
import { isVisionCapableModel } from '../harness/chat-message'
import { ContextChipList, type ContextChipData } from './ContextChip'

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
	chips?: ContextChipData[]
	onRemoveChip?: (id: string) => void
}

const MIN_COMPOSER_HEIGHT = 44
const MAX_COMPOSER_RATIO = 0.6

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
	chips = [],
	onRemoveChip,
}) => {
	const [goalExpanded, setGoalExpanded] = useState(false)
	const [dragOver, setDragOver] = useState(false)
	const [fullscreen, setFullscreen] = useState(false)
	const [composerHeight, setComposerHeight] = useState<number | null>(null)
	const compositeRef = useRef<HTMLDivElement>(null)
	const resizeStartRef = useRef<{ startY: number; startH: number } | null>(null)

	const hasImages = hasImageAttachment(attachments)
	const visionOk = !hasImages || isVisionCapableModel(modelId, providerId)
	const hasChips = chips.length > 0
	const canSend =
		!disabled &&
		!isLoading &&
		(Boolean(input.trim()) || attachments.length > 0 || hasChips) &&
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

	// 拖拽调整输入框高度：向上拖增大，向下拖减小
	const onResizeStart = (e: React.PointerEvent) => {
		if (e.button !== 0) return
		e.preventDefault()
		const startH = compositeRef.current?.offsetHeight ?? MIN_COMPOSER_HEIGHT
		resizeStartRef.current = { startY: e.clientY, startH }
		document.body.style.cursor = 'row-resize'
		document.body.style.userSelect = 'none'
	}

	useEffect(() => {
		const onMove = (e: PointerEvent) => {
			if (!resizeStartRef.current) return
			const delta = resizeStartRef.current.startY - e.clientY
			const maxH = Math.max(MIN_COMPOSER_HEIGHT, window.innerHeight * MAX_COMPOSER_RATIO)
			const newH = Math.max(
				MIN_COMPOSER_HEIGHT,
				Math.min(maxH, resizeStartRef.current.startH + delta)
			)
			setComposerHeight(newH)
		}
		const onUp = () => {
			if (resizeStartRef.current) {
				resizeStartRef.current = null
				document.body.style.cursor = ''
				document.body.style.userSelect = ''
			}
		}
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', onUp)
		return () => {
			window.removeEventListener('pointermove', onMove)
			window.removeEventListener('pointerup', onUp)
		}
	}, [])

	// 全屏编辑：ESC 关闭
	useEffect(() => {
		if (!fullscreen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				setFullscreen(false)
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [fullscreen])

	const handleFullscreenSend = () => {
		setFullscreen(false)
		if (canSend) onSend()
	}

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
				className={`chat-input-composite${dragOver ? ' chat-input-composite--drag' : ''}${composerHeight ? ' chat-input-composite--resized' : ''}`}
				style={composerHeight ? { height: composerHeight } : undefined}
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
				<div
					className="composer-resize-handle"
					onPointerDown={onResizeStart}
					role="separator"
					aria-orientation="horizontal"
					aria-label="拖拽调整输入框大小"
					title="拖拽调整输入框大小"
				/>

				{hasChips && onRemoveChip && (
					<ContextChipList chips={chips} onRemove={onRemoveChip} />
				)}

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

					<button
						type="button"
						className="composer-expand-btn"
						onClick={() => setFullscreen(true)}
						disabled={disabled}
						title="全屏编辑（ESC 退出）"
						aria-label="全屏编辑"
					>
						<IconExpand size="sm" />
					</button>

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

			{fullscreen && (
				<div
					className="composer-fullscreen-overlay"
					onClick={(e) => {
						if (e.target === e.currentTarget) setFullscreen(false)
					}}
				>
					<div className="composer-fullscreen-modal">
						<div className="composer-fullscreen-header">
							<span className="composer-fullscreen-title">全屏编辑</span>
							<div className="composer-fullscreen-header-actions">
								<span className="composer-fullscreen-hint">ESC 退出 · Enter 发送</span>
								<button
									type="button"
									className="composer-fullscreen-close"
									onClick={() => setFullscreen(false)}
									title="关闭"
									aria-label="关闭"
								>
									<IconX size="sm" />
								</button>
							</div>
						</div>
						<textarea
							className="composer-fullscreen-textarea"
							placeholder={placeholder}
							value={input}
							onChange={(e) => onInputChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault()
									handleFullscreenSend()
								}
							}}
							autoFocus
						/>
						<div className="composer-fullscreen-footer">
							<span className="composer-fullscreen-counter">
								{input.length} 字
							</span>
							<div className="composer-fullscreen-footer-actions">
								<button
									type="button"
									className="mc-btn"
									onClick={() => setFullscreen(false)}
								>
									关闭
								</button>
								<button
									type="button"
									className="mc-btn mc-btn--primary"
									onClick={handleFullscreenSend}
									disabled={!canSend}
								>
									<IconSend size="sm" /> 发送
								</button>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

export default ChatComposer
