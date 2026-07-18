import React, { useMemo, useState } from 'react'

export interface ClarificationOverlayProps {
	question: string
	options: string[]
	disabled?: boolean
	onConfirm: (answer: string) => void
	onCancel?: () => void
}

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

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

	const answer = useMemo(() => {
		if (selectedIndex === null) return ''
		if (selectedIndex === -1) return otherText.trim()
		return (options[selectedIndex] || '').trim()
	}, [selectedIndex, otherText, options])

	const canConfirm = Boolean(answer) && !disabled

	const handleConfirm = () => {
		if (!canConfirm) return
		onConfirm(answer)
	}

	return (
		<div className="clarification-overlay" role="dialog" aria-label="AI 需要你的确认">
			<div className="clarification-overlay__panel">
				<div className="clarification-overlay__hd">
					<span className="clarification-overlay__icon">?</span>
					<span>AI 需要你的确认</span>
				</div>
				<div className="clarification-overlay__question">{question}</div>

				{options.length > 0 ? (
					<div className="clarification-overlay__options">
						{options.map((opt, i) => (
							<button
								key={`${i}-${opt}`}
								type="button"
								className={`clarification-overlay__option${selectedIndex === i ? ' is-selected' : ''}`}
								disabled={disabled}
								onClick={() => setSelectedIndex(i)}
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
						<span className="clarification-overlay__hint">选择或填写后确认，将直接继续对话</span>
					)}
					<button
						type="button"
						className="clarification-overlay__btn clarification-overlay__btn--confirm"
						disabled={!canConfirm}
						onClick={handleConfirm}
					>
						确认并继续
					</button>
				</div>
			</div>
		</div>
	)
}

export default ClarificationOverlay
