import React, { useState, useEffect, useCallback, useRef } from 'react'
import { MOD_TEMPLATES } from '../project/scaffold'
import { IconSquare, IconPackage, IconGhost, IconWrench } from './Icon'
import {
	type ModContent,
	scanProjectPreview,
	displayModField,
} from '../utils/project-preview-scan'

interface PreviewPanelProps {
	projectPath: string | null
	refreshKey?: number
	onTemplateClick?: (templateId: string, name: string) => void
	onContentClick?: (type: string, name: string, className?: string) => void
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({
	projectPath,
	refreshKey = 0,
	onTemplateClick,
	onContentClick,
}) => {
	const [modJson, setModJson] = useState<Record<string, unknown> | null>(null)
	const [contentList, setContentList] = useState<ModContent[]>([])
	const [gradleProps, setGradleProps] = useState<Record<string, string>>({})
	const [initialLoading, setInitialLoading] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const panelRef = useRef<HTMLDivElement>(null)
	const scrollTopRef = useRef(0)
	const hasLoadedRef = useRef(false)

	const scanProject = useCallback(async () => {
		if (!projectPath) {
			setModJson(null)
			setContentList([])
			setGradleProps({})
			hasLoadedRef.current = false
			return
		}

		scrollTopRef.current = panelRef.current?.scrollTop ?? 0
		if (!hasLoadedRef.current) setInitialLoading(true)
		else setRefreshing(true)

		try {
			const data = await scanProjectPreview(projectPath)
			setModJson(data.modJson)
			setGradleProps(data.gradleProps)
			setContentList(data.content)
			hasLoadedRef.current = true
		} finally {
			setInitialLoading(false)
			setRefreshing(false)
		}
	}, [projectPath])

	useEffect(() => {
		hasLoadedRef.current = false
		void scanProject()
	}, [scanProject, refreshKey])

	useEffect(() => {
		if (!projectPath) return undefined
		const interval = window.setInterval(scanProject, 30_000)
		return () => window.clearInterval(interval)
	}, [projectPath, scanProject])

	useEffect(() => {
		if (!initialLoading && !refreshing && panelRef.current) {
			panelRef.current.scrollTop = scrollTopRef.current
		}
	}, [contentList, initialLoading, refreshing])

	if (!projectPath) {
		return (
			<div className="preview-panel">
				<div className="preview-header">
					<div className="preview-title">项目预览</div>
					<div className="preview-subtitle">实时展示模组内容结构</div>
				</div>
				<div className="preview-empty">
					<p>请先打开一个项目</p>
				</div>
			</div>
		)
	}

	const blocks = contentList.filter((c) => c.type === 'block')
	const items = contentList.filter((c) => c.type === 'item')
	const entities = contentList.filter((c) => c.type === 'entity')
	const recipes = contentList.filter((c) => c.type === 'recipe')

	const categoryIcons: Record<string, React.FC<{ className?: string }>> = {
		block: IconSquare,
		item: IconPackage,
		entity: IconGhost,
		recipe: IconWrench,
	}

	const categoryNames: Record<string, string> = {
		block: '方块',
		item: '物品',
		entity: '实体',
		recipe: '配方',
	}

	const versionDisplay =
		displayModField(modJson?.version, gradleProps) !== '-'
			? displayModField(modJson?.version, gradleProps)
			: gradleProps.mod_version || '-'

	return (
		<div className="preview-panel" ref={panelRef}>
			<div className="preview-header">
				<div className="preview-header-row">
					<div>
						<div className="preview-title">项目预览</div>
						<div className="preview-subtitle">实时展示模组内容结构</div>
					</div>
					{refreshing && <span className="preview-refresh-badge">刷新中</span>}
				</div>
			</div>

			{initialLoading ? (
				<div className="preview-empty">
					<p>加载中…</p>
				</div>
			) : (
				<>
					{modJson && (
						<div className="preview-card">
							<div className="preview-card-title">模组信息</div>
							<div className="preview-info-grid">
								<div className="preview-info-item">
									<span className="preview-info-label">名称</span>
									<span className="preview-info-value">{displayModField(modJson.name, gradleProps)}</span>
								</div>
								<div className="preview-info-item">
									<span className="preview-info-label">Mod ID</span>
									<span className="preview-info-value">{displayModField(modJson.id, gradleProps)}</span>
								</div>
								<div className="preview-info-item">
									<span className="preview-info-label">版本</span>
									<span className="preview-info-value">{versionDisplay}</span>
								</div>
								<div className="preview-info-item">
									<span className="preview-info-label">Maven Group</span>
									<span className="preview-info-value">{gradleProps.maven_group || '-'}</span>
								</div>
								{gradleProps.minecraft_version && (
									<div className="preview-info-item">
										<span className="preview-info-label">Minecraft</span>
										<span className="preview-info-value">{gradleProps.minecraft_version}</span>
									</div>
								)}
								{gradleProps.loader_version && (
									<div className="preview-info-item">
										<span className="preview-info-label">Fabric Loader</span>
										<span className="preview-info-value">{gradleProps.loader_version}</span>
									</div>
								)}
							</div>
							{modJson.entrypoints && typeof modJson.entrypoints === 'object' && (
								<div className="preview-entrypoints">
									<span className="preview-info-label">入口点</span>
									{Object.entries(modJson.entrypoints as Record<string, unknown>).map(([key, value]) => (
										<div key={key} className="preview-entrypoint-item">
											<span className="preview-entrypoint-key">{key}</span>
											<span className="preview-entrypoint-value">{displayModField(value, gradleProps)}</span>
										</div>
									))}
								</div>
							)}
						</div>
					)}

					<div className="preview-card">
						<div className="preview-card-title">内容统计</div>
						<div className="preview-stats">
							{(['block', 'item', 'entity', 'recipe'] as const).map((type) => {
								const Icon = categoryIcons[type]
								const count = type === 'block' ? blocks.length : type === 'item' ? items.length : type === 'entity' ? entities.length : recipes.length
								return (
									<div key={type} className="preview-stat-item">
										<Icon className="preview-stat-icon" />
										<span className="preview-stat-count">{count}</span>
										<span className="preview-stat-label">{categoryNames[type]}</span>
									</div>
								)
							})}
						</div>
					</div>

					{blocks.length > 0 && (
						<ContentSection
							title="方块"
							items={blocks}
							onContentClick={onContentClick}
						/>
					)}

					{items.length > 0 && (
						<ContentSection
							title="物品"
							items={items}
							onContentClick={onContentClick}
						/>
					)}

					{entities.length > 0 && (
						<ContentSection
							title="实体"
							items={entities}
							onContentClick={onContentClick}
						/>
					)}

					{recipes.length > 0 && (
						<ContentSection
							title="配方"
							items={recipes}
							onContentClick={onContentClick}
						/>
					)}

					{blocks.length === 0 && items.length === 0 && entities.length === 0 && recipes.length === 0 && (
						<div className="preview-card">
							<div className="preview-card-title">快速模板</div>
							<div className="preview-templates">
								{MOD_TEMPLATES.map((template) => {
									const IconComponent = categoryIcons[template.category] || IconSquare
									return (
										<div
											key={template.id}
											className="preview-template-item"
											onClick={() => onTemplateClick?.(template.id, template.name)}
										>
											<IconComponent className="preview-template-icon" />
											<div className="preview-template-info">
												<span className="preview-template-name">{template.name}</span>
												<span className="preview-template-desc">{template.description}</span>
											</div>
										</div>
									)
								})}
							</div>
							<div className="preview-hint">在 AI 对话中输入「创建一个自定义方块」即可快速生成模板代码</div>
						</div>
					)}
				</>
			)}
		</div>
	)
}

function ContentSection({
	title,
	items,
	onContentClick,
}: {
	title: string
	items: ModContent[]
	onContentClick?: (type: string, name: string, className?: string) => void
}) {
	return (
		<div className="preview-card">
			<div className="preview-card-title">{title}</div>
			<div className="preview-content-list">
				{items.map((item) => (
					<div
						key={`${item.type}-${item.id}-${item.source}`}
						className="preview-content-item"
						onClick={() => onContentClick?.(item.type, item.id, item.className)}
					>
						<span className="preview-content-name">{item.id.replace(/_/g, ' ')}</span>
						{item.className && <span className="preview-content-class">{item.className}.java</span>}
						{!item.className && item.path && (
							<span className="preview-content-class">{item.path.split(/[/\\]/).slice(-3).join('/')}</span>
						)}
					</div>
				))}
			</div>
		</div>
	)
}

export default PreviewPanel
