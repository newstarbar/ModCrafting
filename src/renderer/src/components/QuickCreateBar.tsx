import React from 'react'
import { MOD_TEMPLATES } from '../project/scaffold'
import { IconSquare, IconPackage, IconGhost, IconWrench } from './Icon'

const CATEGORY_ICONS: Record<string, React.FC<{ className?: string; size?: 'sm' | 'md' | 'lg' }>> = {
	block: IconSquare,
	item: IconPackage,
	entity: IconGhost,
	recipe: IconWrench,
	structure: IconSquare,
}

interface QuickCreateBarProps {
	disabled?: boolean
	onSelect: (templateId: string, name: string) => void
}

const QuickCreateBar: React.FC<QuickCreateBarProps> = ({ disabled, onSelect }) => {
	return (
		<div className="chat-composer__quick-create" aria-label="快捷创建">
			<span className="chat-composer__quick-create-label">快捷创建</span>
			<div className="chat-composer__quick-create-scroll">
				{MOD_TEMPLATES.map((template) => {
					const Icon = CATEGORY_ICONS[template.category] || IconSquare
					return (
						<button
							key={template.id}
							type="button"
							className="chat-composer__quick-create-chip"
							disabled={disabled}
							title={template.description}
							onClick={() => onSelect(template.id, template.name)}
						>
							<Icon size="sm" className="chat-composer__quick-create-icon" />
							<span>{template.name.replace(/^自定义/, '')}</span>
						</button>
					)
				})}
			</div>
		</div>
	)
}

export default QuickCreateBar
