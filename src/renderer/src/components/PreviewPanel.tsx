import React, { useState, useEffect, useCallback, useRef } from "react";
import { MOD_TEMPLATES } from "../project/scaffold";
import { IconSquare, IconPackage, IconGhost, IconWrench } from "./Icon";

interface ModContent {
	type: "block" | "item" | "entity" | "recipe";
	name: string;
	className?: string;
	displayName?: string;
}

interface PreviewPanelProps {
	projectPath: string | null;
	onTemplateClick?: (templateId: string, name: string) => void;
	onContentClick?: (type: string, name: string, className?: string) => void;
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({ projectPath, onTemplateClick, onContentClick }) => {
	const [modJson, setModJson] = useState<Record<string, unknown> | null>(null);
	const [contentList, setContentList] = useState<ModContent[]>([]);
	const [gradleProps, setGradleProps] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const scrollTopRef = useRef(0);

	const scanProject = useCallback(async () => {
		if (!projectPath) {
			setModJson(null);
			setContentList([]);
			setGradleProps({});
			return;
		}

		scrollTopRef.current = panelRef.current?.scrollTop ?? 0;
		setLoading(true);
		try {
			const jsonRes = await window.api.readFile(`${projectPath}/src/main/resources/fabric.mod.json`);
			if (jsonRes.success && jsonRes.content) {
				try {
					setModJson(JSON.parse(jsonRes.content));
				} catch {
					setModJson(null);
				}
			} else {
				setModJson(null);
			}

			const propsRes = await window.api.readFile(`${projectPath}/gradle.properties`);
			if (propsRes.success && propsRes.content) {
				const props: Record<string, string> = {};
				for (const line of propsRes.content.split("\n")) {
					if (line.trim() && !line.startsWith("#")) {
						const [key, value] = line.split("=");
						if (key && value !== undefined) props[key.trim()] = value.trim();
					}
				}
				setGradleProps(props);
			}

			const content: ModContent[] = [];
			const javaDir = `${projectPath}/src/main/java`;
			try {
				const javaEntries = await window.api.listDirectory(javaDir);
				const scanDir = async (dir: string, pkgParts: string[]): Promise<void> => {
					const entries = await window.api.listDirectory(dir);
					for (const entry of entries) {
						if (entry.isDirectory) {
							await scanDir(entry.path, [...pkgParts, entry.name]);
						} else if (entry.name.endsWith(".java")) {
							const fileName = entry.name.replace(".java", "");
							const res = await window.api.readFile(entry.path);
							if (res.success && res.content) {
								const code = res.content;
								if (code.includes("extends Block")) {
									content.push({ type: "block", name: fileName.replace("Block", "").toLowerCase(), className: fileName });
								} else if (code.includes("extends Item") && !code.includes("extends BlockItem")) {
									content.push({ type: "item", name: fileName.replace("Item", "").toLowerCase(), className: fileName });
								} else if (code.includes("extends BlockItem")) {
									content.push({ type: "item", name: fileName.replace("Item", "").toLowerCase(), className: fileName });
								} else if (code.includes("extends Entity") || code.includes("extends MobEntity")) {
									content.push({ type: "entity", name: fileName.replace("Entity", "").toLowerCase(), className: fileName });
								}
							}
						}
					}
				};
				for (const entry of javaEntries) {
					if (entry.isDirectory) {
						await scanDir(entry.path, [entry.name]);
					}
				}
			} catch {
				// ignore
			}

			const recipeDir = `${projectPath}/src/main/resources/data`;
			try {
				const dataEntries = await window.api.listDirectory(recipeDir);
				for (const modDir of dataEntries) {
					if (modDir.isDirectory) {
						const recipesDir = `${modDir.path}/recipes`;
						if (await window.api.exists(recipesDir)) {
							const recipeEntries = await window.api.listDirectory(recipesDir);
							for (const recipe of recipeEntries) {
								if (recipe.name.endsWith(".json")) {
									content.push({ type: "recipe", name: recipe.name.replace(".json", "") });
								}
							}
						}
					}
				}
			} catch {
				// ignore
			}

			setContentList(content);
		} finally {
			setLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		void scanProject();
		const interval = window.setInterval(scanProject, 5000);
		return () => window.clearInterval(interval);
	}, [scanProject]);

	useEffect(() => {
		if (!loading && panelRef.current) {
			panelRef.current.scrollTop = scrollTopRef.current;
		}
	}, [contentList, loading]);

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
		);
	}

	if (loading) {
		return (
			<div className="preview-panel">
				<div className="preview-header">
					<div className="preview-title">项目预览</div>
					<div className="preview-subtitle">实时展示模组内容结构</div>
				</div>
				<div className="preview-empty">
					<p>加载中…</p>
				</div>
			</div>
		);
	}

	const blocks = contentList.filter((c) => c.type === "block");
	const items = contentList.filter((c) => c.type === "item");
	const entities = contentList.filter((c) => c.type === "entity");
	const recipes = contentList.filter((c) => c.type === "recipe");

	const categoryIcons: Record<string, React.FC<{ className?: string }>> = {
		block: IconSquare,
		item: IconPackage,
		entity: IconGhost,
		recipe: IconWrench
	};

	const categoryNames: Record<string, string> = {
		block: "方块",
		item: "物品",
		entity: "实体",
		recipe: "配方"
	};

	return (
		<div className="preview-panel" ref={panelRef}>
			<div className="preview-header">
				<div className="preview-title">项目预览</div>
				<div className="preview-subtitle">实时展示模组内容结构</div>
			</div>

			{modJson && (
				<div className="preview-card">
					<div className="preview-card-title">模组信息</div>
					<div className="preview-info-grid">
						<div className="preview-info-item">
							<span className="preview-info-label">名称</span>
							<span className="preview-info-value">{modJson.name || "-"}</span>
						</div>
						<div className="preview-info-item">
							<span className="preview-info-label">Mod ID</span>
							<span className="preview-info-value">{modJson.id || "-"}</span>
						</div>
						<div className="preview-info-item">
							<span className="preview-info-label">版本</span>
							<span className="preview-info-value">{modJson.version || gradleProps.mod_version || "-"}</span>
						</div>
						<div className="preview-info-item">
							<span className="preview-info-label">Maven Group</span>
							<span className="preview-info-value">{gradleProps.maven_group || "-"}</span>
						</div>
					</div>
					{modJson.entrypoints && typeof modJson.entrypoints === "object" && (
						<div className="preview-entrypoints">
							<span className="preview-info-label">入口点</span>
							{Object.entries(modJson.entrypoints).map(([key, value]) => (
								<div key={key} className="preview-entrypoint-item">
									<span className="preview-entrypoint-key">{key}</span>
									<span className="preview-entrypoint-value">{Array.isArray(value) ? value.join(", ") : String(value)}</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			<div className="preview-card">
				<div className="preview-card-title">内容统计</div>
				<div className="preview-stats">
					<div className="preview-stat-item">
						{categoryIcons.block && <categoryIcons.block className="preview-stat-icon" />}
						<span className="preview-stat-count">{blocks.length}</span>
						<span className="preview-stat-label">{categoryNames.block}</span>
					</div>
					<div className="preview-stat-item">
						{categoryIcons.item && <categoryIcons.item className="preview-stat-icon" />}
						<span className="preview-stat-count">{items.length}</span>
						<span className="preview-stat-label">{categoryNames.item}</span>
					</div>
					<div className="preview-stat-item">
						{categoryIcons.entity && <categoryIcons.entity className="preview-stat-icon" />}
						<span className="preview-stat-count">{entities.length}</span>
						<span className="preview-stat-label">{categoryNames.entity}</span>
					</div>
					<div className="preview-stat-item">
						{categoryIcons.recipe && <categoryIcons.recipe className="preview-stat-icon" />}
						<span className="preview-stat-count">{recipes.length}</span>
						<span className="preview-stat-label">{categoryNames.recipe}</span>
					</div>
				</div>
			</div>

			{blocks.length > 0 && (
				<div className="preview-card">
					<div className="preview-card-title">方块</div>
					<div className="preview-content-list">
						{blocks.map((block, index) => (
							<div key={`block-${index}`} className="preview-content-item" onClick={() => onContentClick?.("block", block.name, block.className)}>
								<span className="preview-content-name">{block.name.replace(/_/g, " ")}</span>
								{block.className && <span className="preview-content-class">{block.className}.java</span>}
							</div>
						))}
					</div>
				</div>
			)}

			{items.length > 0 && (
				<div className="preview-card">
					<div className="preview-card-title">物品</div>
					<div className="preview-content-list">
						{items.map((item, index) => (
							<div key={`item-${index}`} className="preview-content-item" onClick={() => onContentClick?.("item", item.name, item.className)}>
								<span className="preview-content-name">{item.name.replace(/_/g, " ")}</span>
								{item.className && <span className="preview-content-class">{item.className}.java</span>}
							</div>
						))}
					</div>
				</div>
			)}

			{entities.length > 0 && (
				<div className="preview-card">
					<div className="preview-card-title">实体</div>
					<div className="preview-content-list">
						{entities.map((entity, index) => (
							<div key={`entity-${index}`} className="preview-content-item" onClick={() => onContentClick?.("entity", entity.name, entity.className)}>
								<span className="preview-content-name">{entity.name.replace(/_/g, " ")}</span>
								{entity.className && <span className="preview-content-class">{entity.className}.java</span>}
							</div>
						))}
					</div>
				</div>
			)}

			{recipes.length > 0 && (
				<div className="preview-card">
					<div className="preview-card-title">配方</div>
					<div className="preview-content-list">
						{recipes.map((recipe, index) => (
							<div key={`recipe-${index}`} className="preview-content-item" onClick={() => onContentClick?.("recipe", recipe.name)}>
								<span className="preview-content-name">{recipe.name.replace(/_/g, " ")}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{blocks.length === 0 && items.length === 0 && entities.length === 0 && recipes.length === 0 && (
				<div className="preview-card">
					<div className="preview-card-title">快速模板</div>
					<div className="preview-templates">
						{MOD_TEMPLATES.map((template) => {
							const IconComponent = categoryIcons[template.category] || IconSquare;
							return (
								<div key={template.id} className="preview-template-item" onClick={() => onTemplateClick?.(template.id, template.name)}>
									<IconComponent className="preview-template-icon" />
									<div className="preview-template-info">
										<span className="preview-template-name">{template.name}</span>
										<span className="preview-template-desc">{template.description}</span>
									</div>
								</div>
							);
						})}
					</div>
					<div className="preview-hint">在 AI 对话中输入「创建一个自定义方块」即可快速生成模板代码</div>
				</div>
			)}
		</div>
	);
};

export default PreviewPanel;
