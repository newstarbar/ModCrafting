// ======== Minecraft Structured Data + Wiki Vector Search Tools ========
// 内置两套本地 Minecraft 离线知识库的 Agent 工具入口：
// 1. minecraft_data_lookup：查询结构化 minecraft-data（方块/物品/实体/附魔/配方）
//    用于把玩家口语名称转换为游戏标准 ID，自动填充 Fabric 注册所需参数。
// 2. mc_wiki_search：检索中文 MC 百科向量知识库，处理模糊、不专业的游戏描述。

import { type Tool, type ToolContext, type ToolExecutionPayload } from "./tools.ts";
import { formatKnowledgeHitLine, type KnowledgeHitTrail } from "../utils/knowledge-hit-tags.ts";

// ── minecraft_data_lookup ──

const DATA_KIND_LABELS: Record<string, string> = {
	block: "方块",
	item: "物品",
	entity: "实体",
	enchantment: "附魔"
};

function formatBlockProps(props: {
	id: string;
	name: string;
	zhName?: string;
	hardness?: number;
	resistance?: number;
	stackSize: number;
	tool?: string;
	transparent?: boolean;
	emitLight?: number;
	filterLight?: number;
}): string {
	const lines: string[] = [
		`- 标准ID：${props.id}`,
		`- 英文名：${props.name}`,
		`- 中文名：${props.zhName || "(未收录)"}`,
		`- 硬度：${props.hardness ?? "(未记录)"}`,
		`- 爆炸抗性：${props.resistance ?? "(未记录)"}`,
		`- 最大堆叠：${props.stackSize}`,
		`- 推荐工具：${props.tool || "(任意)"}`,
		`- 透明：${props.transparent ? "是" : "否"}`,
		`- 光照：发射 ${props.emitLight ?? 0} / 过滤 ${props.filterLight ?? 15}`
	];
	return lines.join("\n");
}

function formatItemProps(props: { id: string; name: string; zhName?: string; stackSize: number; maxDurability?: number }): string {
	const lines: string[] = [`- 标准ID：${props.id}`, `- 英文名：${props.name}`, `- 中文名：${props.zhName || "(未收录)"}`, `- 最大堆叠：${props.stackSize}`];
	if (props.maxDurability !== undefined) lines.push(`- 最大耐久：${props.maxDurability}`);
	return lines.join("\n");
}

function formatEntityProps(props: {
	id: string;
	internalId?: number;
	name: string;
	zhName?: string;
	type?: string;
	category?: string;
	width?: number;
	height?: number;
	health?: number;
	attack?: number;
	passive?: boolean;
}): string {
	const lines: string[] = [`- 标准ID：${props.id}`, `- 英文名：${props.name}`, `- 中文名：${props.zhName || "(未收录)"}`, `- 类型：${props.type || "(未分类)"}`];
	if (props.category) lines.push(`- 分类：${props.category}`);
	if (props.width !== undefined || props.height !== undefined) {
		lines.push(`- 碰撞箱：${props.width ?? "?"} × ${props.height ?? "?"}`);
	}
	if (props.health !== undefined) lines.push(`- 生命值：${props.health}`);
	if (props.attack !== undefined) lines.push(`- 攻击力：${props.attack}`);
	if (props.passive !== undefined) lines.push(`- 被动生物：${props.passive ? "是" : "否"}`);
	return lines.join("\n");
}

function formatEnchantmentProps(props: { id: string; name: string; zhName?: string; maxLevel: number; minLevel?: number; weight?: number }): string {
	const lines: string[] = [`- 标准ID：${props.id}`, `- 英文名：${props.name}`, `- 中文名：${props.zhName || "(未收录)"}`, `- 最大等级：${props.maxLevel}`];
	if (props.minLevel !== undefined) lines.push(`- 最小等级：${props.minLevel}`);
	if (props.weight !== undefined) lines.push(`- 权重：${props.weight}`);
	return lines.join("\n");
}

function formatRecipes(recipes: unknown[]): string {
	if (recipes.length === 0) return "(无配方记录)";
	const lines: string[] = [];
	for (let i = 0; i < Math.min(recipes.length, 5); i++) {
		const r = recipes[i];
		try {
			lines.push(`- ${JSON.stringify(r)}`);
		} catch {
			lines.push(`- (配方 #${i + 1} 无法序列化)`);
		}
	}
	if (recipes.length > 5) lines.push(`...还有 ${recipes.length - 5} 条`);
	return lines.join("\n");
}

export const minecraftDataLookupTool: Tool = {
	name: "minecraft_data_lookup",
	description:
		"查询本地 minecraft-data 结构化数据集（全版本原版方块/物品/实体/附魔/合成配方）。" +
		'用于把玩家口语名称（"钻石矿"、"苦力怕"）转换为游戏标准 ID（minecraft:diamond_ore），' +
		"自动填充 Fabric 方块/物品注册所需参数（硬度、爆炸抗性、堆叠、工具、耐久等），避免 ID 与属性参数错误。" +
		"只读、不联网；编写 Fabric 模组代码前应优先调用本工具。",
	schema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "查询关键字。可以是标准 ID（minecraft:diamond_ore）、英文 name（diamond_ore）或中文口语名（钻石矿石、苦力怕）"
			},
			kind: {
				type: "string",
				enum: ["block", "item", "entity", "enchantment", "auto"],
				description: "查询类型。auto（默认）按顺序尝试 block → item → entity → enchantment"
			},
			mcVersion: {
				type: "string",
				description: "可选 Minecraft 版本，默认取项目 fabric-versions.json 中的 minecraft_version"
			},
			includeRecipes: {
				type: "boolean",
				description: "为 true 时同时返回该物品/方块的合成配方（默认 false）"
			}
		},
		required: ["query"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		const query = String(args.query || "").trim();
		if (!query) return "Error: query 不能为空";
		const kind = (args.kind as string) || "auto";
		const mcVersion = args.mcVersion ? String(args.mcVersion) : undefined;
		const includeRecipes = args.includeRecipes === true;

		if (typeof window === "undefined" || !window.api?.mcDataLookupBlock) {
			return [
				"Error: minecraft_data_lookup 服务不可用（主进程未就绪或测试环境）。",
				"请确认 resources/minecraft-data/<version>/index.json 已生成（运行 npm run knowledge:download）。"
			].join("\n");
		}

		const trails: KnowledgeHitTrail[] = [];
		const sections: string[] = [`查询：${query}`, `类型：${kind === "auto" ? "自动" : DATA_KIND_LABELS[kind] || kind}`, `版本：${mcVersion || "项目默认"}`, ""];

		const tryBlock = async (): Promise<boolean> => {
			if (kind !== "block" && kind !== "auto") return false;
			const res = await window.api.mcDataLookupBlock(query, mcVersion);
			if (!res.found || !res.data) return false;
			sections.push(`【方块 · 命中】`);
			sections.push(formatBlockProps(res.data));
			trails.push({ kind: "结构化数据", category: "方块", doc: res.data.id, section: res.data.zhName || res.data.name });
			if (includeRecipes) {
				const recipes = await window.api.mcDataSearchRecipes(res.data.id, mcVersion);
				sections.push("", "【合成配方】", formatRecipes(recipes.recipes));
			}
			return true;
		};

		const tryItem = async (): Promise<boolean> => {
			if (kind !== "item" && kind !== "auto") return false;
			const res = await window.api.mcDataLookupItem(query, mcVersion);
			if (!res.found || !res.data) return false;
			sections.push(`【物品 · 命中】`);
			sections.push(formatItemProps(res.data));
			trails.push({ kind: "结构化数据", category: "物品", doc: res.data.id, section: res.data.zhName || res.data.name });
			if (includeRecipes) {
				const recipes = await window.api.mcDataSearchRecipes(res.data.id, mcVersion);
				sections.push("", "【合成配方】", formatRecipes(recipes.recipes));
			}
			return true;
		};

		const tryEntity = async (): Promise<boolean> => {
			if (kind !== "entity" && kind !== "auto") return false;
			const res = await window.api.mcDataLookupEntity(query, mcVersion);
			if (!res.found || !res.data) return false;
			sections.push(`【实体 · 命中】`);
			sections.push(formatEntityProps(res.data));
			trails.push({ kind: "结构化数据", category: "实体", doc: res.data.id, section: res.data.zhName || res.data.name });
			return true;
		};

		const tryEnchantment = async (): Promise<boolean> => {
			if (kind !== "enchantment" && kind !== "auto") return false;
			const res = await window.api.mcDataLookupEnchantment(query, mcVersion);
			if (!res.found || !res.data) return false;
			sections.push(`【附魔 · 命中】`);
			sections.push(formatEnchantmentProps(res.data));
			trails.push({ kind: "结构化数据", category: "附魔", doc: res.data.id, section: res.data.zhName || res.data.name });
			return true;
		};

		let hit = false;
		if (kind === "auto") {
			for (const fn of [tryBlock, tryItem, tryEntity, tryEnchantment]) {
				if (await fn()) {
					hit = true;
					break;
				}
			}
		} else if (kind === "block") hit = await tryBlock();
		else if (kind === "item") hit = await tryItem();
		else if (kind === "entity") hit = await tryEntity();
		else if (kind === "enchantment") hit = await tryEnchantment();

		if (!hit) {
			sections.push("（未命中结构化数据集；可能原因：1) 数据未构建，请运行 npm run knowledge:download；2) 关键字太模糊，建议改用英文 ID 或标准 name）");
			trails.push({ kind: "未命中", category: "结构化数据", doc: query.slice(0, 32), section: "" });
		}

		sections.push("");
		sections.push(`摘要：查「${query}」→ ${hit ? trails.map((t) => `${t.category}:${t.doc}`).join("；") : "无命中"}`);
		for (const trail of trails.slice(0, 4)) {
			sections.push(formatKnowledgeHitLine(trail));
		}

		return sections.join("\n");
	}
};

// ── mc_wiki_search ──

export const mcWikiSearchTool: Tool = {
	name: "mc_wiki_search",
	description:
		"检索内置中文 MC 百科向量知识库（离线 MD 文档 + 预计算 embeddings）。" +
		'当用户输入模糊、不专业的游戏描述（"那个会爆炸的绿色怪物"、"挖矿掉的红色石头"）时，' +
		"调用本工具检索准确词条解释，补齐游戏背景知识，再结合 minecraft_data_lookup 生成 Fabric 代码。" +
		"只读、不联网；覆盖所有游戏机制、红石、生物、模组基础术语。",
	schema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "自然语言查询，可以是模糊描述、口语名称或游戏术语片段"
			},
			topK: {
				type: "number",
				description: "返回最相似的前 K 条结果，默认 5，最大 10"
			}
		},
		required: ["query"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		const query = String(args.query || "").trim();
		if (!query) return "Error: query 不能为空";
		const topK = Math.max(1, Math.min(10, Number(args.topK) || 5));

		if (typeof window === "undefined" || !window.api?.mcWikiSearch) {
			return [
				"Error: mc_wiki_search 服务不可用（主进程未就绪或测试环境）。",
				"请确认 resources/mc-wiki-zh-index/ 与 resources/mc-wiki-model/ 已生成（运行 npm run knowledge:download）。"
			].join("\n");
		}

		const info = await window.api.mcWikiInfo();
		if (!info.ready) {
			if (info.error) {
				return [
					"中文 MC 百科向量知识库不可用：",
					`- 错误：${info.error}`,
					"- 请运行 `npm run knowledge:download` 预计算索引。",
					`- 当前切片数：${info.chunkCount}；模型：${info.model}`
				].join("\n");
			}
			// 尝试懒加载初始化
			const initRes = await window.api.mcWikiInit();
			if (!initRes.ok) {
				return [
					"中文 MC 百科向量知识库尚未就绪，已尝试初始化但失败：",
					`- ${initRes.error || "未知错误"}`,
					"- 请确认 resources/mc-wiki-zh-index/ 与 resources/mc-wiki-model/ 已正确生成。"
				].join("\n");
			}
		}

		const res = await window.api.mcWikiSearch(query, topK);
		if (!res.ok) {
			return [`检索失败：${res.error || "未知错误"}`, "建议改用 minecraft_data_lookup 查结构化数据，或调整查询关键字后重试。"].join("\n");
		}
		if (res.results.length === 0) {
			return [`查询：${query}`, "结果：未命中百科词条（切片库可能为空）", "建议：1) 运行 npm run knowledge:download 抓取核心词条；2) 改用更准确的中英文术语重试。"].join("\n");
		}

		const trails: KnowledgeHitTrail[] = res.results.map((r) => ({
			kind: "百科",
			category: r.category,
			doc: r.title,
			section: r.heading || r.standardId || ""
		}));

		const lines: string[] = [`查询：${query}`, `命中：${res.results.length} 条（topK=${topK}）`, ""];
		for (let i = 0; i < res.results.length; i++) {
			const r = res.results[i];
			lines.push(`【#${i + 1} · ${r.category} · ${r.title}${r.standardId ? ` (${r.standardId})` : ""}】`);
			if (r.heading) lines.push(`段落：${r.heading}`);
			lines.push(`相似度：${r.score.toFixed(4)}`);
			lines.push(r.snippet);
			lines.push("");
		}

		lines.push(
			`摘要：查「${query}」→ ${trails
				.slice(0, 3)
				.map((t) => `${t.category}:${t.doc}`)
				.join("；")}`
		);
		for (const trail of trails.slice(0, 5)) {
			lines.push(formatKnowledgeHitLine(trail));
		}

		return lines.join("\n");
	}
};
