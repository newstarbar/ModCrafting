import React, { useState, useRef, useEffect } from 'react'
import type { ComposerMode } from '../harness/turn-intent'

const MODE_OPTIONS: { id: ComposerMode; label: string; hint: string }[] = [
	{ id: 'agent', label: 'Agent', hint: '自动规划并执行' },
	{ id: 'plan', label: 'Plan', hint: '仅生成计划，确认后执行' },
	{ id: 'ask', label: 'Ask', hint: '问答模式，不调用工具' },
]

interface ComposerModeMenuProps {
	value: ComposerMode
	onChange: (mode: ComposerMode) => void
	disabled?: boolean
}

const ComposerModeMenu: React.FC<ComposerModeMenuProps> = ({ value, onChange, disabled }) => {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return undefined
		const onDocClick = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false)
			}
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false)
		}
		document.addEventListener('mousedown', onDocClick)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('mousedown', onDocClick)
			document.removeEventListener('keydown', onKey)
		}
	}, [open])

	const current = MODE_OPTIONS.find((o) => o.id === value) ?? MODE_OPTIONS[0]

	return (
		<div className="composer-menu" ref={rootRef}>
			<button
				type="button"
				className="composer-menu-trigger"
				disabled={disabled}
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((v) => !v)}
			>
				<span>{current.label}</span>
				<span className="composer-menu-chevron" aria-hidden>▾</span>
			</button>
			{open && (
				<div className="composer-menu-popover" role="menu">
					{MODE_OPTIONS.map((opt) => (
						<button
							key={opt.id}
							type="button"
							role="menuitem"
							className={`composer-menu-item${value === opt.id ? ' composer-menu-item--active' : ''}`}
							onClick={() => {
								onChange(opt.id)
								setOpen(false)
							}}
						>
							<div className="composer-menu-item-main">
								<span className="composer-menu-item-label">{opt.label}</span>
								<span className="composer-menu-item-hint">{opt.hint}</span>
							</div>
							{value === opt.id && <span className="composer-menu-check" aria-hidden>✓</span>}
						</button>
					))}
				</div>
			)}
		</div>
	)
}

export default ComposerModeMenu
