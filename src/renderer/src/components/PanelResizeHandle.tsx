import React, { useState } from 'react'

interface PanelResizeHandleProps {
	side: 'left' | 'right'
	onPointerDown: (clientX: number) => void
	disabled?: boolean
}

const PanelResizeHandle: React.FC<PanelResizeHandleProps> = ({
	side,
	onPointerDown,
	disabled = false,
}) => {
	const [active, setActive] = useState(false)

	if (disabled) return null

	return (
		<div
			className={`panel-resize-handle panel-resize-handle--${side}${active ? ' panel-resize-handle--active' : ''}`}
			role="separator"
			aria-orientation="vertical"
			aria-label={side === 'left' ? '调整左侧面板宽度' : '调整右侧面板宽度'}
			onPointerDown={(e) => {
				if (e.button !== 0) return
				e.preventDefault()
				setActive(true)
				onPointerDown(e.clientX)
				const target = e.currentTarget
				target.setPointerCapture(e.pointerId)
				const onUp = () => {
					setActive(false)
					target.releasePointerCapture(e.pointerId)
					target.removeEventListener('pointerup', onUp)
					target.removeEventListener('pointercancel', onUp)
				}
				target.addEventListener('pointerup', onUp)
				target.addEventListener('pointercancel', onUp)
			}}
		/>
	)
}

export default PanelResizeHandle
