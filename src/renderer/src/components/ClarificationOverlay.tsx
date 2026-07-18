import React, { useMemo, useState } from 'react'

export interface ClarificationOverlayProps {
	question: string
	options: string[]
	disabled?: boolean
	onConfirm: (answer: string) => void
	onCancel?: () => void
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const QUESTION_COLLAPSE_CHARS = 160

/**
 * Covers the chat composer while clarification is pending.
 * Select an option (or type custom text), then confirm to resume the turn.
 */
const ClarificationOverlay: React.FC<ClarificationOverlayProps> = ({
	question,
	options,
	disabled = false,
	onConfirm,
	onCancel,
}) => {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(
		options.length > 0 ? 0 : -1
	)
	const [otherText, setOtherText] = useState('')
	const [questionExpanded, setQuestionExpanded] = useState(false)

	const questionNeedsCollapse = question.trim().length > QUESTION_COLLAPSE_CHARS
	const questionShown =
		questionNeedsCollapse && !questionExpanded
			? `${question.trim().slice(0, QUESTION_COLLAPSE_CHARS)}…`
			: question

	const answer = useMemo(() => {
		if (selectedIndex === null) return ''
		if (selectedIndex === -1) return otherText.trim()
		return (options[selectedIndex] || '').trim()
	}, [selectedIndex, otherText, options])

	const canConfirm = Boolean(answer) && !disabled

	const handleConfirm = (override?: string) => {
		const finalAnswer = (override ?? answer).trim()
		if (!finalAnswer || disabled) return
		onConfirm(finalAnswer)
	}

	return (
		<div
			className="clarification-overlay"
			role="dialog"
			aria-label="AI 需要你的确认"
			tabIndex={-1}
			onKeyDown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey && selectedIndex !== -1 && canConfirm) {
					e.preventDefault()
					handleConfirm()
				}
			}}
		>
			<div className="clarification-overlay__panel">
				<div className="clarification-overlay__hd">
					<span className="clarification-overlay__icon">?</span>
					<span>AI 需要你的确认</span>
				</div>
				<p className="clarification-overlay__hint-top">
					仅需你做偏好选择；实现细节由 AI 自行处理
				</p>
				<div className="clarification-overlay__question" title={question}>
					{questionShown}
				</div>
				{questionNeedsCollapse && (
					<button
						type="button"
						className="clarification-overlay__expand"
						disabled={disabled}
						onClick={() => setQuestionExpanded((v) => !v)}
					>
						{questionExpanded ? '收起' : '展开全文'}
					</button>
				)}

				{options.length > 0 ? (
					<div className="clarification-overlay__options">
						{options.map((opt, i) => (
							<button
								key={`${i}-${opt}`}
								type="button"
								className={`clarification-overlay__option${selectedIndex === i ? ' is-selected' : ''}`}
								disabled={disabled}
								title={opt}
								onClick={() => setSelectedIndex(i)}
								onDoubleClick={() => handleConfirm(opt)}
							>
								<span className="clarification-overlay__letter">{LETTERS[i] || String(i + 1)}</span>
								<span className="clarification-overlay__option-text">{opt}</span>
							</button>
						))}
						<button
							type="button"
							className={`clarification-overlay__option clarification-overlay__option--other${selectedIndex === -1 ? ' is-selected' : ''}`}
							disabled={disabled}
							onClick={() => setSelectedIndex(-1)}
						>
							<span className="clarification-overlay__letter">其他</span>
							<span className="clarification-overlay__option-text">自定义回答</span>
						</button>
					</div>
				) : null}

				{(options.length === 0 || selectedIndex === -1) && (
					<textarea
						className="clarification-overlay__textarea"
						placeholder={options.length === 0 ? '输入你的回答…' : '输入其他回答…'}
						value={otherText}
						disabled={disabled}
						rows={3}
						onChange={(e) => {
							setOtherText(e.target.value)
							if (selectedIndex !== -1) setSelectedIndex(-1)
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
								e.preventDefault()
								handleConfirm()
							}
						}}
					/>
				)}

				<div className="clarification-overlay__footer">
					{onCancel ? (
						<button
							type="button"
							className="clarification-overlay__btn clarification-overlay__btn--ghost"
							disabled={disabled}
							onClick={onCancel}
						>
							稍后
						</button>
					) : (
						<span className="clarification-overlay__hint">
							双击选项或选中后按 Enter 可直接继续
						</span>
					)}
					<button
						type="button"
						className="clarification-overlay__btn clarification-overlay__btn--confirm"
						disabled={!canConfirm}
						onClick={() => handleConfirm()}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								handleConfirm()
							}
						}}
					>
						确认并继续
					</button>
				</div>
			</div>
		</div>
	)
}

export default ClarificationOverlay
