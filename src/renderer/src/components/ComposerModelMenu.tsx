import React, { useState, useRef, useEffect } from 'react'
import { MODEL_PRESETS, modelDisplayLabel } from '../config/model-presets'

interface ComposerModelMenuProps {
	value: string
	onChange: (modelId: string) => void
	onOpenApiSettings?: () => void
	disabled?: boolean
}

const ComposerModelMenu: React.FC<ComposerModelMenuProps> = ({
	value,
	onChange,
	onOpenApiSettings,
	disabled,
}) => {
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

	const inPresets = MODEL_PRESETS.some((p) => p.id === value)

	return (
		<div className="composer-menu composer-menu--model" ref={rootRef}>
			<button
				type="button"
				className="composer-menu-trigger composer-menu-trigger--model"
				disabled={disabled}
				aria-expanded={open}
				aria-haspopup="menu"
				title={value}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="composer-menu-trigger-text">{modelDisplayLabel(value)}</span>
				<span className="composer-menu-chevron" aria-hidden>▾</span>
			</button>
			{open && (
				<div className="composer-menu-popover" role="menu">
					{MODEL_PRESETS.map((preset) => (
						<button
							key={preset.id}
							type="button"
							role="menuitem"
							className={`composer-menu-item${value === preset.id ? ' composer-menu-item--active' : ''}`}
							onClick={() => {
								onChange(preset.id)
								setOpen(false)
							}}
						>
							<span className="composer-menu-item-label">{preset.label}</span>
							{value === preset.id && <span className="composer-menu-check" aria-hidden>✓</span>}
						</button>
					))}
					{!inPresets && value && (
						<div className="composer-menu-custom" role="presentation">
							当前：{value}
						</div>
					)}
					{onOpenApiSettings && (
						<button
							type="button"
							className="composer-menu-item composer-menu-item--footer"
							onClick={() => {
								setOpen(false)
								onOpenApiSettings()
							}}
						>
							自定义模型…
						</button>
					)}
				</div>
			)}
		</div>
	)
}

export default ComposerModelMenu
