import React from 'react'
import { IconChevronLeft, IconChevronRight } from './Icon'

interface PanelExpandRailProps {
	side: 'left' | 'right'
	onExpand: () => void
}

const PanelExpandRail: React.FC<PanelExpandRailProps> = ({ side, onExpand }) => {
	const isLeft = side === 'left'

	return (
		<div className={`panel-expand-rail panel-expand-rail--${side}`}>
			<button
				type="button"
				className="panel-expand-rail__btn"
				onClick={onExpand}
				title={isLeft ? '展开左侧面板' : '展开右侧面板'}
				aria-label={isLeft ? '展开左侧面板' : '展开右侧面板'}
			>
				{isLeft ? <IconChevronRight size="sm" /> : <IconChevronLeft size="sm" />}
			</button>
		</div>
	)
}

export default PanelExpandRail
