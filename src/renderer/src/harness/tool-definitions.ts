// ======== ModCrafting Tool Definitions ========
// Built-in tools for the Fabric mod development environment

import { type Tool, type ToolContext, type Previewer, type ToolExecutionPayload } from "./tools";
import type { FileDiff } from "./events";
import { isPanelBridgeRegistered, runBuildViaPanel, startGameViaPanel, getLastBuildLogText } from "../utils/panel-bridge";
import { waitForMcRunReady } from "../utils/mc-wait-playing";
import { buildRecipeContent, buildShapelessRecipeContent, parseRecipeIngredients, recipePath, validateRecipeContent, type RecipeKind, type RecipeKey } from "./recipe-utils";
import { minecraftItems } from "../data/items";
import { buildFabricDocsSearchSummary, buildFabricJavadocLookupUrl, buildVanillaWikiQuerySummary } from "./fabric-knowledge";
import { buildDataAssetFiles, classifyFabricLog, validateFabricModJsonContent } from "./fabric-utils";
import {
	MOD_TEMPLATES,
	type ProjectCreateConfig
} from "../project/scaffold";
import { executeTemplateGenerate, resolveProjectConfig } from "../project/template-runner.ts";
import { validateFileEditGate } from "./edit-gate.ts";
import { guardedWriteFile } from "./guarded-write.ts";
import { grepInProject } from "./grep-search.ts";
import {
	generateModBlockEntitiesRegistrationClass,
	generateModBlocksRegistrationClass,
	generateModItemsRegistrationClass
} from "../project/template-codegen.ts";
import { buildMixinScaffold, parseAtTarget, parseMethodDescriptor, readMixinMetadata, type MixinScaffoldMetadata, type SupportedMixinInjection } from "./mixin-utils.ts";

async function resolveMcVersion(args: Record<string, unknown>): Promise<string> {
	if (typeof args.mcVersion === "string" && args.mcVersion.trim()) return args.mcVersion.trim();
	try {
		const versions = await window.api.getFabricVersions();
		return versions.minecraft_version || "1.21.4";
	} catch {
		return "1.21.4";
	}
}

const VANILLA_ITEM_IDS = new Set(minecraftItems.map((item) => item.id));

async function readProjectModId(projectPath: string): Promise<string | undefined> {
	try {
		const result = await window.api.readFile(`${projectPath}/src/main/resources/fabric.mod.json`);
		if (!result.success || !result.content) return undefined;
		const parsed = JSON.parse(result.content) as { id?: unknown };
		return typeof parsed.id === "string" ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}

async function generateValidatedRecipe(
	ctx: ToolContext,
	args: Record<string, unknown>,
	forcedType?: RecipeKind
): Promise<string | ToolExecutionPayload> {
	if (!ctx.projectPath) return "No project open";
	const namespace = String(args.namespace || "");
	const name = String(args.name || "");
	const result = String(args.result || "");
	const type = forcedType || String(args.type || "shapeless") as RecipeKind;
	if (!namespace || !name || !result) return "Error creating recipe: namespace, name and result are required";
	const mcVersion = await resolveMcVersion(args);
	if (mcVersion !== "1.21.4") return `Error: deterministic recipe generation only supports MC 1.21.4 (received ${mcVersion})`;
	const content = buildRecipeContent({
		type,
		ingredients: parseRecipeIngredients(args.ingredients),
		pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
		keys: args.keys && typeof args.keys === "object" ? args.keys as Record<string, RecipeKey> : undefined,
		ingredient: args.ingredient && typeof args.ingredient === "object" ? args.ingredient as RecipeKey : undefined,
		result: { item: result, count: Number(args.count ?? 1) },
		experience: Number(args.experience ?? 0),
		cookingTime: Number(args.cookingTime ?? 0) || undefined,
		mcVersion
	});
	const targetPath = recipePath(namespace, name, mcVersion);
	const modId = await readProjectModId(ctx.projectPath);
	const before = validateRecipeContent(content, { path: targetPath, modId, knownVanillaIds: VANILLA_ITEM_IDS });
	if (!before.valid) return `Error: 配方静态校验失败\n${before.errors.map((error) => `- ${error}`).join("\n")}`;
	const written = await guardedWriteFile(ctx, targetPath, content, { allowOverwrite: true });
	if (!written.ok) return `Error creating recipe: ${written.message}`;
	const readBack = await window.api.readFile(`${ctx.projectPath}/${targetPath}`);
	if (!readBack.success || !readBack.content) return `Error: 配方写后读取失败: ${readBack.error || "empty file"}`;
	const after = validateRecipeContent(readBack.content, { path: targetPath, modId, knownVanillaIds: VANILLA_ITEM_IDS });
	if (!after.valid) return `Error: 配方写后校验失败\n${after.errors.map((error) => `- ${error}`).join("\n")}`;
	logger.file(`Recipe written: ${targetPath}`, `${content.length} bytes`);
	return {
		output: `已生成并校验 MC 1.21.4 配方: ${targetPath}${after.warnings.length ? `\n警告:\n${after.warnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`,
		artifactPaths: [targetPath],
		validation: { kind: "recipe", valid: true, version: "1.21.4", targetPath, checkedAt: Date.now() }
	};
}

async function runWithCommandStream(ctx: ToolContext, run: () => Promise<{ output: string; exitCode: number | null }>): Promise<{ output: string; exitCode: number | null }> {
	const unsub = ctx.onProgress ? window.api.onCommandOutput((text) => ctx.onProgress!(text)) : null;
	try {
		return await run();
	} finally {
		unsub?.();
	}
}

// ── read_file ──
export const readFileTool: Tool & Previewer = {
	name: "read_file",
	description: "读取文件内容（含行号）。支持分页：offset 起始行（1-based），limit 最大行数。默认读前 200 行。",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "项目根目录下的相对路径" },
			offset: { type: "number", description: "起始行号（1-based），默认 1" },
			limit: { type: "number", description: "最大行数，默认 200，设 0 表示全量" }
		},
		required: ["path"]
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		if (!ctx.projectPath) return "No project open";
		const filePath = `${ctx.projectPath}/${args.path}`;
		try {
			const res = await window.api.readFile(filePath);
			if (!res.success) return `Error: ${res.error}`;
			const content = res.content || "";
			if (!content) return "(空文件)";

			const lines = content.split("\n");
			const total = lines.length;
			const offset = Math.max(1, Number(args.offset) || 1);
			const limit = args.limit !== undefined ? Number(args.limit) : 200;
			const effectiveLimit = limit === 0 ? total : Math.min(limit, total);
			const end = Math.min(offset + effectiveLimit - 1, total);
			const page = lines.slice(offset - 1, end);

			const numbered = page.map((line, i) => `${offset + i} | ${line}`).join("\n");
			const header = `文件: ${args.path}（共 ${total} 行，显示 ${offset}-${end} 行）`;
			const footer = end < total ? `\n（剩余 ${total - end} 行。用 offset=${end + 1} 继续读取）` : "";
			ctx.fileSession?.markRead(String(args.path || ""));
			return `${header}\n${numbered}${footer}`;
		} catch (err) {
			return `Error reading file: ${err}`;
		}
	},
	preview: () => null
};

// ── write_file ──
function computeLineDiff(oldContent: string, newContent: string): { added: number; removed: number; firstAdded?: string; firstRemoved?: string; oldContent: string } {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const oldSet = new Set(oldLines);
	const newSet = new Set(newLines);

	const addedLines = newLines.filter((l) => !oldSet.has(l));
	const removedLines = oldLines.filter((l) => !newSet.has(l));

	return {
		added: addedLines.length,
		removed: removedLines.length,
		firstAdded: addedLines.length > 0 ? addedLines[0].slice(0, 80) : undefined,
		firstRemoved: removedLines.length > 0 ? removedLines[0].slice(0, 80) : undefined,
		oldContent
	};
}

export const writeFileTool: Tool & Previewer = {
	name: "write_file",
	description: "新建文件（全量写入）。仅用于不存在的路径；修改已有文件必须用 edit_file。自动创建中间目录。",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path from project root" },
			content: { type: "string", description: "Full file content to write" }
		},
		required: ["path", "content"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const relPath = String(args.path || "");
		const content = String(args.content || "");

		const written = await guardedWriteFile(ctx, relPath, content, { allowOverwrite: false });
		if (!written.ok) return written.message;

		logger.file(`Written: ${relPath}`, `${content.length} bytes`);
		const diff = computeLineDiff(written.oldContent, content);
		const diffPayload = JSON.stringify({
			path: relPath,
			...diff,
			oldContent: written.oldContent,
			action: written.fileExisted ? "update" : "create"
		});
		return `已写入: ${relPath} (${content.length} bytes)\n<!-- FILE_DIFF ${diffPayload} -->`;
	},
	preview(args: Record<string, unknown>): FileDiff | null {
		const path = String(args.path || "");
		const content = String(args.content || "");
		const lines = content.split("\n");
		return {
			path,
			added: lines.length,
			removed: 0,
			content
		};
	}
};

function stripTrailingWsPerLine(s: string): string {
	return s
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""))
		.join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let from = 0;
	while (true) {
		const i = haystack.indexOf(needle, from);
		if (i === -1) break;
		count++;
		from = i + needle.length;
	}
	return count;
}

// ── edit_file ──
export const editFileTool: Tool & Previewer = {
	name: "edit_file",
	description:
		"精确替换文件中的文本。默认只替换第一处；设 replace_all=true 可替换全部。old_string 须精确匹配。修改已有文件优先用此工具（须先 read_file），新建用 write_file。",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "项目根目录下的相对路径" },
			old_string: { type: "string", description: "要替换的原始文本（精确匹配）" },
			new_string: { type: "string", description: "替换后的新文本" },
			replace_all: {
				type: "boolean",
				description: "为 true 时替换文件中全部匹配；默认 false（仅第一处，且要求唯一）"
			}
		},
		required: ["path", "old_string", "new_string"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const relPath = String(args.path || "");
		const filePath = `${ctx.projectPath}/${relPath}`;
		let oldStr = String(args.old_string || "");
		const newStr = String(args.new_string || "");
		const replaceAll = args.replace_all === true;

		if (!oldStr) return "Error: old_string 不能为空";

		if (ctx.fileSession && !ctx.fileSession.hasRead(relPath)) {
			return (
				`blocked: [aci_read_gate] 编辑前须先 read_file：${relPath}。` +
				`请先读取该文件再调用 edit_file。`
			);
		}

		let content: string;
		try {
			const res = await window.api.readFile(filePath);
			if (!res.success) return `Error: ${res.error}`;
			content = res.content || "";
		} catch (err) {
			return `Error reading file: ${err}`;
		}

		let idx = content.indexOf(oldStr);
		if (idx === -1) {
			const strippedContent = stripTrailingWsPerLine(content);
			const strippedOld = stripTrailingWsPerLine(oldStr);
			const fallbackIdx = strippedContent.indexOf(strippedOld);
			if (fallbackIdx !== -1 && strippedOld) {
				// Map stripped match back onto original by line alignment when possible
				oldStr = strippedOld;
				content = strippedContent;
				idx = fallbackIdx;
			}
		}

		if (idx === -1) {
			const oldLower = oldStr.toLowerCase();
			const lines = content.split("\n");
			const keywords = oldLower.split(/\s+/).filter((w: string) => w.length > 3);
			const contextLines: string[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (keywords.some((kw: string) => lines[i].toLowerCase().includes(kw))) {
					const start = Math.max(0, i - 2);
					const end = Math.min(lines.length, i + 3);
					contextLines.push(`... 第 ${start + 1}-${end} 行:`);
					for (let j = start; j < end; j++) {
						contextLines.push(`${j + 1} | ${lines[j]}`);
					}
					if (contextLines.length >= 25) break;
				}
			}
			if (contextLines.length > 0) {
				return `Error: 未找到 old_string。文件 ${relPath}（${lines.length} 行）中相关区域:\n${contextLines.join("\n")}\n\n请调整 old_string 精确匹配实际文件内容。注意缩进和空格必须完全一致。`;
			}
			return `Error: 未找到 old_string。文件 ${relPath} 共 ${lines.length} 行。请用 read_file 查看后重试。`;
		}

		const matchCount = countOccurrences(content, oldStr);
		if (!replaceAll && matchCount > 1) {
			const lineNum = content.substring(0, idx).split("\n").length;
			const lineNum2 = content.substring(0, content.indexOf(oldStr, idx + 1)).split("\n").length;
			return (
				`Error: old_string 匹配了多处（至少第 ${lineNum} 行和第 ${lineNum2} 行，共 ${matchCount} 处）。` +
				`请提供更多上下文使匹配唯一，或设置 replace_all=true 替换全部。`
			);
		}

		const newContent = replaceAll
			? content.split(oldStr).join(newStr)
			: content.substring(0, idx) + newStr + content.substring(idx + oldStr.length);

		const gate = validateFileEditGate(relPath, newContent);
		if (!gate.ok) {
			return `blocked: [edit_gate] ${gate.reason}。编辑未落盘，请修正后重试。`;
		}

		try {
			await window.api.writeFile(filePath, newContent);
			ctx.fileSession?.markRead(relPath);

			const oldLines = oldStr.split("\n");
			const newLines = newStr.split("\n");
			const added = Math.max(0, newLines.length - oldLines.length) * (replaceAll ? matchCount : 1);
			const removed = Math.max(0, oldLines.length - newLines.length) * (replaceAll ? matchCount : 1);
			const lineNum = content.substring(0, idx).split("\n").length;
			const preview = newStr.length > 100 ? newStr.slice(0, 100) + "..." : newStr;

			const diffPayload = JSON.stringify({
				path: relPath,
				added,
				removed,
				oldContent: content,
				action: "update" as const
			});

			let msg = replaceAll
				? `已编辑 ${relPath}: 替换全部 ${matchCount} 处`
				: `已编辑 ${relPath}: 第 ${lineNum} 行已替换`;
			if (added > 0 && removed > 0) msg += `（修改约 ${removed + added} 行）`;
			else if (added > 0) msg += `（+${added} 行）`;
			else if (removed > 0) msg += `（-${removed} 行）`;
			msg += `\n新内容: ${preview}\n<!-- FILE_DIFF ${diffPayload} -->`;

			return msg;
		} catch (err) {
			return `写入失败: ${err}`;
		}
	},
	preview(args: Record<string, unknown>): FileDiff | null {
		const path = String(args.path || "");
		return { path, added: 0, removed: 0 };
	}
};

// ── grep ──
export const grepTool: Tool = {
	name: "grep",
	description: "在项目源码中按正则搜索（返回 path:line | snippet）。勘察类名/引用时优先于盲目 read_file。只读。",
	schema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "正则表达式" },
			path: { type: "string", description: "相对搜索根目录，默认 src" },
			glob: { type: "string", description: "文件名 glob，如 *.java 或 **/*Mixin*.java" },
			max_matches: { type: "number", description: "最多返回条数，默认 40" },
			case_sensitive: { type: "boolean", description: "默认 false（不区分大小写）" }
		},
		required: ["pattern"]
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		return grepInProject(ctx, String(args.pattern || ""), {
			path: args.path ? String(args.path) : undefined,
			glob: args.glob ? String(args.glob) : undefined,
			maxMatches: typeof args.max_matches === "number" ? args.max_matches : undefined,
			caseInsensitive: args.case_sensitive !== true
		});
	}
};

// ── delete_file ──
export const deleteFileTool: Tool = {
	name: "delete_file",
	description: "删除项目内的单个文件（相对路径）。用于移除废弃的 Java/JSON/Gradle 资源文件。",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "项目根目录下的相对路径" }
		},
		required: ["path"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const rel = String(args.path || "").replace(/\\/g, "/");
		if (!rel || rel.includes("..")) return "Error: invalid path";
		const filePath = `${ctx.projectPath}/${rel}`;
		try {
			const res = await window.api.deleteFile(filePath);
			if (res.success) return `已删除: ${rel}`;
			return `Error: ${res.error || "delete failed"}`;
		} catch (err) {
			return `Error deleting file: ${err}`;
		}
	}
};

// ── create_recipe ──
export const createRecipeTool: Tool & Previewer = {
	name: "create_recipe",
	description: "Create a Minecraft shapeless crafting recipe JSON. Prefer this for recipe/合成 tasks instead of hand-writing JSON.",
	schema: {
		type: "object",
		properties: {
			namespace: { type: "string", description: "Recipe namespace / mod id, e.g. my-mod" },
			name: { type: "string", description: "Recipe file name without .json, e.g. dirt_to_diamond" },
			ingredients: {
				type: "array",
				description: "Ingredients. Use repeated strings or objects with { item, count }.",
				items: {
					anyOf: [
						{ type: "string" },
						{
							type: "object",
							properties: {
								item: { type: "string" },
								count: { type: "number" }
							},
							required: ["item"]
						}
					]
				}
			},
			result: { type: "string", description: "Result item id, e.g. minecraft:diamond" },
			count: { type: "number", description: "Result count, default 1" }
		},
		required: ["namespace", "name", "ingredients", "result"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		return generateValidatedRecipe(ctx, args, "shapeless");
	},
	preview(args: Record<string, unknown>): FileDiff | null {
		const namespace = String(args.namespace || "");
		const name = String(args.name || "");
		const ingredients = parseRecipeIngredients(args.ingredients);
		const result = String(args.result || "");
		if (!namespace || !name || ingredients.length === 0 || !result) return null;
		const content = buildShapelessRecipeContent({
			ingredients,
			result: { item: result, count: Number(args.count ?? 1) || 1 },
			mcVersion: "1.21.4"
		});
		return {
			path: recipePath(namespace, name, "1.21.4"),
			added: content.split("\n").length,
			removed: 0,
			content
		};
	}
};

// ── fabric_docs_search ──
export const fabricDocsSearchTool: Tool = {
	name: "fabric_docs_search",
	description: "搜索 Fabric 知识库：优先查本地 Yarn 参考表（类名/方法签名/Mixin 模式），再联网抓取文档摘要。只读。写代码前用此工具确认类名和字段名是否正确。",
	schema: {
		type: "object",
		properties: {
			keyword: { type: "string", description: "Search keyword, e.g. 方块实体 or BlockEntity" },
			mcVersion: { type: "string", description: "Minecraft version, default current project version" },
			lang: { type: "string", enum: ["zh_cn", "en_us"], description: "Language preference" },
			limit: { type: "number", description: "Max source count, default 5" }
		},
		required: ["keyword"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		return buildFabricDocsSearchSummary({
			keyword: String(args.keyword || ""),
			mcVersion: args.mcVersion ? String(args.mcVersion) : undefined,
			lang: args.lang === "en_us" ? "en_us" : "zh_cn",
			limit: Number(args.limit ?? 5)
		});
	}
};

// ── fabric_javadoc_lookup ──
export const fabricJavadocLookupTool: Tool = {
	name: "fabric_javadoc_lookup",
	description: "Build a Fabric API JavaDoc search URL for a class, method, event, or registry API. Read-only.",
	schema: {
		type: "object",
		properties: {
			keyword: { type: "string", description: "Class, method, event, or registry keyword" },
			fabricApiVersion: { type: "string", description: "Fabric API version, e.g. 0.116.0+1.21.4" }
		},
		required: ["keyword"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const version = String(args.fabricApiVersion || (await window.api.getFabricVersions()).fabric_version);
		const keyword = String(args.keyword || "");
		return `Fabric API JavaDoc 查询（只读）
关键词：${keyword}
URL：${buildFabricJavadocLookupUrl(version, keyword)}
提示：写代码前用该页面确认类名、方法签名、事件参数和模块依赖。`;
	}
};

// ── vanilla_mc_wiki_query ──
export const vanillaMcWikiQueryTool: Tool = {
	name: "vanilla_mc_wiki_query",
	description: "Return official Minecraft Wiki query entry points for vanilla blocks, items, entities, loot, and mechanics. Read-only.",
	schema: {
		type: "object",
		properties: {
			keyword: { type: "string", description: "Vanilla concept keyword, e.g. 钻石矿石 or Zombie" },
			lang: { type: "string", enum: ["zh_cn", "en_us"], description: "Language preference" }
		},
		required: ["keyword"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		return buildVanillaWikiQuerySummary(String(args.keyword || ""), args.lang === "en_us" ? "en_us" : "zh_cn");
	}
};

// ── fabric_meta_version_check ──
export const fabricMetaVersionCheckTool: Tool = {
	name: "fabric_meta_version_check",
	description: "Query Fabric Meta for compatible Loader, Fabric API, and Yarn versions for a Minecraft version. Read-only.",
	schema: {
		type: "object",
		properties: {
			mcVersion: { type: "string", description: "Minecraft version, e.g. 1.21.4" }
		},
		required: ["mcVersion"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const mcVersion = String(args.mcVersion || "");
		if (!mcVersion) return "Error: mcVersion is required";
		try {
			const [loaders, apis, yarns] = await Promise.all([
				fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`)
					.then((r) => r.json())
					.catch(() => []),
				fetch(`https://meta.fabricmc.net/v2/versions/fabric-api/${encodeURIComponent(mcVersion)}`)
					.then((r) => r.json())
					.catch(() => []),
				fetch(`https://meta.fabricmc.net/v2/versions/yarn/${encodeURIComponent(mcVersion)}`)
					.then((r) => r.json())
					.catch(() => [])
			]);
			const loader = Array.isArray(loaders) ? loaders[0]?.loader?.version : undefined;
			const fabricApi = Array.isArray(apis) ? apis[0]?.version : undefined;
			const yarn = Array.isArray(yarns) ? yarns[0]?.version : undefined;
			return JSON.stringify(
				{
					minecraft_version: mcVersion,
					loader_version: loader || "unknown",
					fabric_version: fabricApi || "unknown",
					yarn_mappings: yarn || "unknown",
					java: "1.20.5+ 建议 Java 21；当前 ModCrafting 默认 Java 21",
					source: "https://meta.fabricmc.net/"
				},
				null,
				2
			);
		} catch (err) {
			return `Error querying Fabric Meta: ${err}`;
		}
	}
};

// ── fabric_mod_json_validate ──
export const fabricModJsonValidateTool: Tool = {
	name: "fabric_mod_json_validate",
	description: "Validate fabric.mod.json entrypoints, depends, mixins, icon path, and Java constraints. Read-only.",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to fabric.mod.json, default src/main/resources/fabric.mod.json" }
		}
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const relPath = String(args.path || "src/main/resources/fabric.mod.json");
		const res = await window.api.readFile(`${ctx.projectPath}/${relPath}`);
		if (!res.success || !res.content) return `Error reading ${relPath}: ${res.error || "empty file"}`;
		const result = validateFabricModJsonContent(res.content);
		return JSON.stringify(result, null, 2);
	}
};

// ── fabric_recipe_generate ──
export const fabricRecipeGenerateTool: Tool & Previewer = {
	name: "fabric_recipe_generate",
	description: "Generate Minecraft recipe JSON for shaped, shapeless, smelting, blasting, or stonecutting recipes.",
	schema: {
		type: "object",
		properties: {
			namespace: { type: "string", description: "Recipe namespace / mod id" },
			name: { type: "string", description: "Recipe file name without .json" },
			type: { type: "string", enum: ["shapeless", "shaped", "smelting", "blasting", "stonecutting"] },
			ingredients: { type: "array", description: "Shapeless ingredients" },
			pattern: { type: "array", items: { type: "string" }, description: "Shaped recipe pattern" },
			keys: { type: "object", description: "Shaped recipe key map" },
			ingredient: { type: "object", description: "Single ingredient for furnace/stonecutting recipes" },
			result: { type: "string", description: "Result item id" },
			count: { type: "number", description: "Result count" },
			experience: { type: "number" },
			cookingTime: { type: "number" }
		},
		required: ["namespace", "name", "type", "result"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		return generateValidatedRecipe(ctx, args);
	},
	preview(args: Record<string, unknown>): FileDiff | null {
		const namespace = String(args.namespace || "");
		const name = String(args.name || "");
		const result = String(args.result || "");
		if (!namespace || !name || !result) return null;
		const content = buildRecipeContent({
			type: String(args.type || "shapeless") as RecipeKind,
			ingredients: parseRecipeIngredients(args.ingredients),
			pattern: Array.isArray(args.pattern) ? args.pattern.map(String) : undefined,
			keys: args.keys && typeof args.keys === "object" ? (args.keys as Record<string, RecipeKey>) : undefined,
			ingredient: args.ingredient && typeof args.ingredient === "object" ? (args.ingredient as RecipeKey) : undefined,
			result: { item: result, count: Number(args.count ?? 1) },
			mcVersion: "1.21.4"
		});
		return { path: recipePath(namespace, name, "1.21.4"), added: content.split("\n").length, removed: 0, content };
	}
};

export const fabricRecipeValidateTool: Tool = {
	name: "fabric_recipe_validate",
	description: "Validate an existing recipe against the deterministic Minecraft 1.21.4 recipe schema. Read-only.",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Recipe path under src/main/resources/data/<namespace>/recipe/" }
		},
		required: ["path"]
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		if (!ctx.projectPath) return "No project open";
		const targetPath = String(args.path || "").replace(/\\/g, "/");
		const read = await window.api.readFile(`${ctx.projectPath}/${targetPath}`);
		if (!read.success || !read.content) return `Error: 无法读取配方 ${targetPath}: ${read.error || "empty file"}`;
		const modId = await readProjectModId(ctx.projectPath);
		const result = validateRecipeContent(read.content, { path: targetPath, modId, knownVanillaIds: VANILLA_ITEM_IDS });
		if (!result.valid) return `Error: MC 1.21.4 配方校验失败\n${result.errors.map((error) => `- ${error}`).join("\n")}`;
		return {
			output: JSON.stringify(result, null, 2),
			artifactPaths: [targetPath],
			validation: { kind: "recipe", valid: true, version: "1.21.4", targetPath, checkedAt: Date.now() }
		};
	}
};

// ── list_directory ──
export const listDirectoryTool: Tool = {
	name: "list_directory",
	description: "List files and directories. Path is relative to project root. Empty string lists root.",
	schema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Relative path (default: root)" }
		}
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const dirPath = args.path ? `${ctx.projectPath}/${args.path}` : ctx.projectPath;
		try {
			const entries = await window.api.listDirectory(dirPath);
			const lines = entries.map((e: { name: string; isDirectory: boolean }) => (e.isDirectory ? `${e.name}/` : e.name));
			return lines.join("\n") || "(empty directory)";
		} catch (err) {
			return `Error listing directory: ${err}`;
		}
	}
};

// ── run_command ──
export const runCommandTool: Tool = {
	name: "run_command",
	description: "Run a shell command in the project directory. Use for building, testing, or git operations.",
	schema: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" }
		},
		required: ["command"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		try {
			const command = String(args.command || "");
			const prep = await window.api.prepareBuild(ctx.projectPath);
			const fullCmd = prep.ok ? prep.cmdPrefix + command : command;
			const res = await runWithCommandStream(ctx, () => window.api.runCommandStream(fullCmd, ctx.projectPath!));
			const output = res.output || "(no output)";
			const exitInfo = res.exitCode !== null ? `\n[exit code: ${res.exitCode}]` : "";
			if (!prep.ok && prep.error) return `环境准备失败: ${prep.error}\n${output}${exitInfo}`;
			return output + exitInfo;
		} catch (err) {
			return `Error running command: ${err}`;
		}
	}
};

// ── read_error_log ──

function stripHtmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, "\n")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");
}

function buildLogTail(text: string, maxChars = 8000): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return normalized.slice(-maxChars);
}
export const readErrorLogTool: Tool = {
	name: "read_error_log",
	description: "Read build error logs or crash reports to help debug issues.",
	schema: {
		type: "object",
		properties: {
			logType: {
				type: "string",
				enum: ["last-build", "last-crash", "latest-log", "mixin-error", "resource-error", "datagen-error"],
				description: "Type of log to read"
			}
		},
		required: ["logType"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const logType = String(args.logType || "last-build");
		// Try to read from known log locations
		try {
			if (logType === "last-crash" && _ctx.projectPath) {
				const crashReports = `${_ctx.projectPath}/run/crash-reports`;
				const entries = await window.api.listDirectory(crashReports);
				if (entries.length > 0) {
					const latest = entries.sort((a: { name: string }, b: { name: string }) => b.name.localeCompare(a.name))[0];
					const res = await window.api.readFile(latest.path);
					if (res.success) return res.content.slice(0, 4000);
				}
			}
			if (logType === "last-build" && _ctx.projectPath) {
				if (isPanelBridgeRegistered()) {
					const panelLog = getLastBuildLogText().trim();
					if (panelLog) return buildLogTail(panelLog);
				}
				const candidates = [
					`${_ctx.projectPath}/run/logs/latest.log`,
					`${_ctx.projectPath}/build/reports/problems/problems-report.html`,
					`${_ctx.projectPath}/build/reports/tests/test/index.html`
				];
				for (const p of candidates) {
					if (await window.api.exists(p)) {
						const res = await window.api.readFile(p);
						if (!res.success || !res.content) continue;
						const content = p.endsWith(".html") ? stripHtmlToText(res.content) : res.content;
						if (content.trim()) return buildLogTail(content);
					}
				}
			}
			if (_ctx.projectPath && ["latest-log", "mixin-error", "resource-error", "datagen-error"].includes(logType)) {
				const candidates = [`${_ctx.projectPath}/run/logs/latest.log`, `${_ctx.projectPath}/build/reports/problems/problems-report.html`];
				for (const p of candidates) {
					if (await window.api.exists(p)) {
						const res = await window.api.readFile(p);
						if (res.success && res.content) {
							const classification = classifyFabricLog(res.content);
							return `${JSON.stringify(classification, null, 2)}\n\n${res.content.slice(0, 4000)}`;
						}
					}
				}
			}
			return `[${logType}]: No log file found. Run a build first, or check the terminal panel.`;
		} catch {
			return `[${logType}]: No log file found.`;
		}
	}
};

// ── trigger_build ──
export const triggerBuildTool: Tool = {
	name: "trigger_build",
	description: "Trigger a Gradle task in the project directory.",
	schema: {
		type: "object",
		properties: {
			task: {
				type: "string",
				enum: ["build", "runClient", "runDatagen", "runServer", "test"],
				description: "Gradle task to run"
			}
		},
		required: ["task"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const task = String(args.task || "build");

		if (task === "runClient") {
			try {
				if (isPanelBridgeRegistered()) {
					const res = await startGameViaPanel();
					if (!res.ok) {
						return `游戏测试失败：${res.error || "unknown error"}\n[MC_PHASE:error]`;
					}
					return `游戏已进入主菜单并完成稳定观察（实例 ${res.instanceId}）。[MC_PHASE:ready]`;
				}
				const start = await window.api.mcStartOrCreate(ctx.projectPath);
				if (!start.success) {
					return `Error starting game: ${start.error || "unknown error"}\n[MC_PHASE:error]`;
				}
				const instanceId = start.id || "";
				if (!instanceId) {
					return `Error starting game: 未获取到游戏实例 ID\n[MC_PHASE:error]`;
				}
				const wait = await waitForMcRunReady({ instanceId });
				if (!wait.ok) {
					const tail = wait.logTail ? `\n\n--- 游戏日志（末尾）---\n${wait.logTail}` : "";
					return `游戏测试失败：${wait.error || "unknown error"}${tail}\n[MC_PHASE:error]`;
				}
				return `游戏已进入主菜单并完成稳定观察（实例 ${instanceId}）。[MC_PHASE:ready]`;
			} catch (err) {
				return `Error starting game: ${err}\n[MC_PHASE:error]`;
			}
		}

		try {
			if (task === "build" && isPanelBridgeRegistered()) {
				const res = await runBuildViaPanel(ctx.onProgress);
				const exitInfo = res.exitCode !== 0 ? `\n[退出码: ${res.exitCode}]` : "\n[退出码: 0]";
				const log = getLastBuildLogText().trim();
				const logBlock = log ? `\n\n--- 构建输出 ---\n${buildLogTail(log)}` : "";
				if (res.failed) {
					return `构建失败。${logBlock || "\n详情见右侧高级面板。"}${exitInfo}`;
				}
				return `构建已完成。${logBlock}${exitInfo}`;
			}

			const res = await runWithCommandStream(ctx, () => window.api.runGradleTask(ctx.projectPath!, task));
			const output = res.output || `Task "${task}" completed (exit: ${res.exitCode})`;
			const exitInfo = res.exitCode !== 0 ? `\n[退出码: ${res.exitCode}]` : "";
			const fallbackNote = res.usedOnlineFallback ? "\n[已联网补全依赖缓存]" : "";
			return output + exitInfo + fallbackNote;
		} catch (err) {
			return `Error running build: ${err}`;
		}
	}
};

function javaPackagePath(packagePath: string): string {
	return packagePath.replace(/\./g, "/").replace(/[^a-zA-Z0-9_/$]/g, "");
}

function projectConfigFromPackage(packagePath: string, modId: string): ProjectCreateConfig {
	const lastDot = packagePath.lastIndexOf(".");
	const groupId = lastDot > 0 ? packagePath.slice(0, lastDot) : packagePath;
	const javaPackage = lastDot > 0 ? packagePath.slice(lastDot + 1) : packagePath;
	return {
		projectDir: "",
		folderName: "",
		displayName: "",
		modId,
		groupId,
		javaPackage,
		authors: "",
		description: "",
		modVersion: "",
		versions: {
			minecraft_version: "1.21.4",
			loader_version: "0.16.10",
			fabric_version: "",
			yarn_mappings: "",
			loom_version: "",
			gradle_version: ""
		}
	};
}

// ── fabric_content_register ──
export const fabricContentRegisterTool: Tool = {
	name: "fabric_content_register",
	description: "Generate a Fabric content registration helper class skeleton for items/blocks/block entities.",
	schema: {
		type: "object",
		properties: {
			packagePath: { type: "string", description: "Java package, e.g. com.example.mymod" },
			modId: { type: "string", description: "Mod id namespace" },
			kind: { type: "string", enum: ["item", "block", "block_entity"], description: "Content kind" }
		},
		required: ["packagePath", "modId", "kind"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const packagePath = String(args.packagePath || "");
		const modId = String(args.modId || "");
		const kind = args.kind === "block" ? "block" : args.kind === "block_entity" ? "block_entity" : "item";
		if (!packagePath || !modId) return "Error: packagePath and modId are required";

		const config = projectConfigFromPackage(packagePath, modId);
		const basePath = `src/main/java/${javaPackagePath(packagePath)}`;
		let rel: string;
		let content: string;
		if (kind === "block") {
			rel = `${basePath}/ModBlocks.java`;
			content = generateModBlocksRegistrationClass(config);
		} else if (kind === "block_entity") {
			rel = `${basePath}/ModBlockEntities.java`;
			content = generateModBlockEntitiesRegistrationClass(config);
		} else {
			rel = `${basePath}/ModItems.java`;
			content = generateModItemsRegistrationClass(config);
		}

		const written = await guardedWriteFile(ctx, rel, content, { allowOverwrite: true });
		if (!written.ok) return `Error writing ${rel}: ${written.message}`;
		logger.file(`Fabric content helper written: ${rel}`, `${content.length} bytes`);
		const kindLabel = kind === "block" ? "方块" : kind === "block_entity" ? "方块实体" : "物品";
		return `已生成: ${kindLabel}注册辅助类 → ${rel}`;
	}
};

// ── fabric_data_assets_generate ──
export const fabricDataAssetsGenerateTool: Tool = {
	name: "fabric_data_assets_generate",
	description: "Generate Fabric asset/data JSON files for item or block content: lang, models, blockstates, loot tables.",
	schema: {
		type: "object",
		properties: {
			namespace: { type: "string", description: "Mod id namespace" },
			name: { type: "string", description: "Content id path" },
			kind: { type: "string", enum: ["item", "block"], description: "Asset kind" },
			displayName: { type: "string", description: "Chinese display name" }
		},
		required: ["namespace", "name", "kind"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const namespace = String(args.namespace || "");
		const name = String(args.name || "");
		const kind = args.kind === "block" ? "block" : "item";
		if (!namespace || !name) return "Error: namespace and name are required";
		const mcVersion = await resolveMcVersion(args);
		const files = buildDataAssetFiles({
			namespace,
			name,
			kind,
			displayName: args.displayName ? String(args.displayName) : undefined,
			mcVersion
		});
		for (const file of files) {
			const written = await guardedWriteFile(ctx, file.path, file.content, { allowOverwrite: true });
			if (!written.ok) return `Error writing ${file.path}: ${written.message}`;
		}
		return `已生成: 资源文件${files.map((file) => `\n- ${file.path}`).join("")}`;
	}
};

// ── fabric_mixin_scaffold ──
export const fabricMixinTargetLookupTool: Tool = {
	name: "fabric_mixin_target_lookup",
	description: "Resolve an exact Minecraft 1.21.4 Yarn class/member/descriptor, including static and side metadata. Ambiguous overloads are rejected.",
	schema: {
		type: "object",
		properties: {
			targetClass: { type: "string", description: "Fully-qualified or unique simple Yarn class name" },
			memberName: { type: "string", description: "Target method or field name" },
			descriptor: { type: "string", description: "Exact JVM descriptor; required for overloads" },
			memberKind: { type: "string", enum: ["method", "field", "any"] }
		},
		required: ["targetClass"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const result = await window.api.lookupFabricSymbol({
			className: String(args.targetClass || ""),
			memberName: args.memberName ? String(args.memberName) : undefined,
			descriptor: args.descriptor ? String(args.descriptor) : undefined,
			memberKind: args.memberKind === "field" || args.memberKind === "method" ? args.memberKind : "any"
		});
		if (!result.ok) return `Error: ${result.error || "Fabric symbol lookup failed"}\n${JSON.stringify(result, null, 2)}`;
		return JSON.stringify(result, null, 2);
	}
};

export const fabricMixinScaffoldTool: Tool = {
	name: "fabric_mixin_scaffold",
	description: "Generate a signature-correct MC 1.21.4 Mixin source after exact Yarn lookup. Registration is handled separately by fabric_mixin_register.",
	schema: {
		type: "object",
		properties: {
			mixinPackage: { type: "string", description: "Mixin Java package" },
			mixinClass: { type: "string", description: "Fully qualified mixin class name" },
			targetClass: { type: "string", description: "Fully-qualified Yarn target class" },
			selector: { type: "string", description: "Exact target method or field name" },
			descriptor: { type: "string", description: "Exact JVM method/field descriptor" },
			injectionType: { type: "string", enum: ["inject", "accessor", "invoker", "redirect", "modify_arg", "modify_return_value"] },
			at: { type: "string", enum: ["HEAD", "TAIL", "RETURN", "INVOKE", "FIELD"] },
			atTarget: { type: "string", description: "Exact Mixin target selector, e.g. Lnet/minecraft/Foo;bar()V" },
			side: { type: "string", enum: ["common", "client", "server"] },
			cancellable: { type: "boolean" },
			argumentIndex: { type: "number" },
			fieldOperation: { type: "string", enum: ["GET", "SET"] }
		},
		required: ["mixinPackage", "mixinClass", "targetClass", "selector", "descriptor", "injectionType", "at", "side"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		if (!ctx.projectPath) return "No project open";
		const mixinPackage = String(args.mixinPackage || "");
		const mixinClass = String(args.mixinClass || "");
		const targetClass = String(args.targetClass || "");
		const selector = String(args.selector || "");
		const descriptor = String(args.descriptor || "");
		const injectionType = String(args.injectionType || "") as SupportedMixinInjection;
		const at = String(args.at || "HEAD") as MixinScaffoldMetadata["at"];
		const side = String(args.side || "common") as MixinScaffoldMetadata["side"];
		if (!mixinPackage || !mixinClass || !targetClass || !selector || !descriptor || !injectionType) return "Error: exact Mixin package, class, target, selector, descriptor and injectionType are required";
		if (!mixinClass.startsWith(`${mixinPackage}.`)) return "Error: mixinClass must be inside mixinPackage";
		const memberKind = injectionType === "accessor" ? "field" : "method";
		const lookup = await window.api.lookupFabricSymbol({ className: targetClass, memberName: selector, descriptor, memberKind });
		if (!lookup.ok || !lookup.class) return `Error: Mixin target lookup failed: ${lookup.error || "not found"}\n${JSON.stringify(lookup, null, 2)}`;
		if (lookup.class.side === "client" && side !== "client") return "Error: client-only target must be registered in the client Mixin array";
		const member = memberKind === "field" ? lookup.fields[0] : lookup.methods[0];
		if (!member) return "Error: exact target member was not found";
		let atTargetStatic: boolean | undefined;
		const atTarget = args.atTarget ? String(args.atTarget) : undefined;
		if ((at === "INVOKE" || at === "FIELD" || injectionType === "redirect" || injectionType === "modify_arg") && !atTarget) {
			return "Error: exact atTarget is required for INVOKE/FIELD/redirect/modify_arg";
		}
		if (atTarget) {
			const parsed = parseAtTarget(atTarget);
			if (!parsed) return "Error: atTarget must use exact Lowner;method(desc)ret or Lowner;field:desc syntax";
			if ((at === "INVOKE" && parsed.kind !== "method") || (at === "FIELD" && parsed.kind !== "field")) return "Error: at and atTarget member kind do not match";
			const atLookup = await window.api.lookupFabricSymbol({ className: parsed.className, memberName: parsed.memberName, descriptor: parsed.descriptor, memberKind: parsed.kind });
			if (!atLookup.ok) return `Error: @At target lookup failed: ${atLookup.error || "not found"}`;
			atTargetStatic = (parsed.kind === "method" ? atLookup.methods[0] : atLookup.fields[0])?.static;
		}
		if (injectionType === "modify_return_value" && parseMethodDescriptor(descriptor).returnType === "void") return "Error: ModifyReturnValue cannot target a void method";
		if (injectionType === "modify_arg" && (!Number.isInteger(args.argumentIndex) || Number(args.argumentIndex) < 0)) return "Error: modify_arg requires a non-negative integer argumentIndex";
		const simpleName = mixinClass.split(".").pop() || "GeneratedMixin";
		const classPath = `src/main/java/${javaPackagePath(mixinClass)}.java`;
		const metadata: MixinScaffoldMetadata = {
			version: 1,
			targetClass: lookup.class.name,
			selector,
			descriptor,
			injectionType,
			at,
			...(atTarget ? { atTarget } : {}),
			side,
			...(args.cancellable === true ? { cancellable: true } : {}),
			...(args.argumentIndex !== undefined ? { argumentIndex: Number(args.argumentIndex) } : {}),
			...(args.fieldOperation === "SET" ? { fieldOperation: "SET" as const } : {})
		};
		let content: string;
		try {
			content = buildMixinScaffold({ packageName: mixinPackage, className: simpleName, metadata, targetStatic: member.static, atTargetStatic });
		} catch (error) {
			return `Error: 无法生成确定性 Mixin 外壳: ${String(error)}`;
		}
		const written = await guardedWriteFile(ctx, classPath, content, { allowOverwrite: false });
		if (!written.ok) return `Error writing ${classPath}: ${written.message}`;
		return { output: `已生成签名校验过的 Mixin 源码: ${classPath}\n下一步必须调用 fabric_mixin_register，再调用 fabric_mixin_validate。`, artifactPaths: [classPath] };
	}
};

// ── fabric_log_debugger ──
export const fabricLogDebuggerTool: Tool = {
	name: "fabric_log_debugger",
	description: "Classify Fabric/Loom/Mixin/resource/client-server log errors and return focused repair advice. Read-only.",
	schema: {
		type: "object",
		properties: {
			log: { type: "string", description: "Log text to classify. If empty, reads latest build log." }
		}
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		let log = String(args.log || "");
		if (!log && ctx.projectPath) {
			const candidates = [`${ctx.projectPath}/run/logs/latest.log`, `${ctx.projectPath}/build/reports/problems/problems-report.html`];
			for (const p of candidates) {
				if (await window.api.exists(p)) {
					const res = await window.api.readFile(p);
					if (res.success && res.content) {
						log = res.content;
						break;
					}
				}
			}
		}
		const result = classifyFabricLog(log);
		return JSON.stringify(result, null, 2);
	}
};

// ── complete_step ──
export const completeStepTool: Tool = {
	name: "complete_step",
	description: "Mark a plan step as completed. Call this when you finish implementing a step from the plan.",
	schema: {
		type: "object",
		properties: {
			stepId: {
				type: "string",
				description: "The step ID (number or description prefix) to mark complete"
			}
		},
		required: ["stepId"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		// Extract numeric ID — handle "#1 描述文字" or "1" or "#1"
		let stepId = String(args.stepId || "").trim();
		const numMatch = stepId.match(/^#?(\d+)/);
		if (numMatch) stepId = numMatch[1];
		if (ctx.planTracker) {
			const current = ctx.planTracker.currentStep;
			if (!current) return "Error: 所有计划步骤已完成，无需再调用 complete_step。";
			if (current.id !== stepId) {
				return `Error: 当前步骤是 #${current.id}：${current.description}，不能完成 #${stepId || "空"}。`;
			}
			// Control tools never mutate tracker state themselves. WorkflowEngine validates
			// evidence and performs the single authoritative state transition.
			return `[STEP_COMPLETE_REQUEST:${stepId}]`;
		}
		return `[STEP_COMPLETE_REQUEST:${stepId}]`;
	}
};

// ── fabric_mixin_register ──
function mixinConfigReferences(modJson: Record<string, unknown>): string[] {
	if (!Array.isArray(modJson.mixins)) return [];
	return modJson.mixins.map((entry) => {
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof (entry as { config?: unknown }).config === "string") return String((entry as { config: string }).config);
		return "";
	}).filter(Boolean);
}

function parseJavaIdentity(source: string): { packageName: string; className: string; fqn: string } | null {
	const packageMatch = source.match(/^\s*package\s+([\w.]+)\s*;/m);
	const classMatch = source.match(/\b(?:class|interface)\s+([A-Za-z_$][\w$]*)/);
	if (!packageMatch || !classMatch) return null;
	return { packageName: packageMatch[1], className: classMatch[1], fqn: `${packageMatch[1]}.${classMatch[1]}` };
}

async function readJsonFile(projectPath: string, relPath: string): Promise<Record<string, unknown> | null> {
	const result = await window.api.readFile(`${projectPath}/${relPath}`);
	if (!result.success || !result.content) return null;
	try { return JSON.parse(result.content) as Record<string, unknown>; } catch { return null; }
}

export const fabricMixinRegisterTool: Tool = {
	name: "fabric_mixin_register",
	description: "Register a Mixin source only in a config referenced by fabric.mod.json. Creates and references a config safely when none exists.",
	schema: {
		type: "object",
		properties: {
			sourcePath: { type: "string", description: "Mixin Java source path" },
			configPath: { type: "string", description: "Explicit referenced Mixin config path; required when multiple exist" },
			side: {
				type: "string",
				enum: ["common", "client", "server"],
				description: "common→mixins, client→client, server→server"
			}
		},
		required: ["sourcePath", "side"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		if (!ctx.projectPath) return "No project open";
		const sourcePath = String(args.sourcePath || "").replace(/\\/g, "/");
		const side = String(args.side || "common") as "common" | "client" | "server";
		const sourceResult = await window.api.readFile(`${ctx.projectPath}/${sourcePath}`);
		if (!sourceResult.success || !sourceResult.content) return `Error: 无法读取 Mixin 源码 ${sourcePath}`;
		const identity = parseJavaIdentity(sourceResult.content);
		if (!identity) return "Error: 无法从 Mixin 源码解析 package/class";
		const metadata = readMixinMetadata(sourceResult.content);
		if (!metadata) return "Error: 缺少 MODCRAFTING_MIXIN 元数据；请使用 fabric_mixin_scaffold 生成确定性外壳";
		if (metadata.side !== side) return `Error: source metadata side=${metadata.side} 与注册 side=${side} 不一致`;
		const modJsonPath = "src/main/resources/fabric.mod.json";
		const modJson = await readJsonFile(ctx.projectPath, modJsonPath);
		if (!modJson || typeof modJson.id !== "string") return "Error: fabric.mod.json 不存在、格式错误或缺少 id";
		const refs = mixinConfigReferences(modJson);
		let configName = String(args.configPath || "").replace(/\\/g, "/").replace(/^src\/main\/resources\//, "");
		if (configName && !refs.includes(configName)) return `Error: ${configName} 未被 fabric.mod.json 的 mixins 引用`;
		if (!configName && refs.length > 1) return `Error: fabric.mod.json 引用了多个 Mixin 配置，请明确 configPath：${refs.join(", ")}`;
		let createdConfig = false;
		if (!configName) configName = refs[0] || `${modJson.id}.mixins.json`;
		const configPath = `src/main/resources/${configName}`;
		let config = await readJsonFile(ctx.projectPath, configPath);
		if (!config) {
			if (refs.length > 0) return `Error: fabric.mod.json 引用的 ${configName} 不存在或 JSON 无效`;
			config = { required: true, package: identity.packageName, compatibilityLevel: "JAVA_21", mixins: [], injectors: { defaultRequire: 1 } };
			createdConfig = true;
		}
		const basePackage = typeof config.package === "string" ? config.package : identity.packageName;
		if (identity.packageName !== basePackage && !identity.packageName.startsWith(`${basePackage}.`)) {
			return `Error: Mixin 源码包 ${identity.packageName} 不在配置 package ${basePackage} 下`;
		}
		config.package = basePackage;
		const relativeClass = identity.fqn.slice(basePackage.length + 1) || identity.className;
		const key = side === "client" ? "client" : side === "server" ? "server" : "mixins";
		const entries = Array.isArray(config[key]) ? [...config[key] as string[]] : [];
		if (!entries.includes(relativeClass)) entries.push(relativeClass);
		config[key] = entries;
		const configWrite = await guardedWriteFile(ctx, configPath, `${JSON.stringify(config, null, 2)}\n`, { allowOverwrite: true });
		if (!configWrite.ok) return `Error: ${configWrite.message}`;
		const artifactPaths = [sourcePath, configPath];
		if (createdConfig) {
			modJson.mixins = [...refs, configName];
			const modWrite = await guardedWriteFile(ctx, modJsonPath, `${JSON.stringify(modJson, null, 2)}\n`, { allowOverwrite: true });
			if (!modWrite.ok) return `Error: Mixin 配置已创建，但 fabric.mod.json 更新失败: ${modWrite.message}`;
			artifactPaths.push(modJsonPath);
		}
		return { output: `已在 ${configName} 的 ${key} 数组注册 ${relativeClass}`, artifactPaths };
	}
};

export const fabricMixinValidateTool: Tool = {
	name: "fabric_mixin_validate",
	description: "Validate a generated MC 1.21.4 Mixin source, exact target selectors, side, handler shape, and fabric.mod.json-backed registration.",
	schema: {
		type: "object",
		properties: { sourcePath: { type: "string" }, configPath: { type: "string" } },
		required: ["sourcePath"]
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string | ToolExecutionPayload> {
		if (!ctx.projectPath) return "No project open";
		const sourcePath = String(args.sourcePath || "").replace(/\\/g, "/");
		const sourceResult = await window.api.readFile(`${ctx.projectPath}/${sourcePath}`);
		if (!sourceResult.success || !sourceResult.content) return `Error: 无法读取 ${sourcePath}`;
		const source = sourceResult.content;
		const identity = parseJavaIdentity(source);
		const metadata = readMixinMetadata(source);
		const errors: string[] = [];
		if (!identity) errors.push("无法解析 Java package/class");
		if (!metadata) errors.push("缺少或损坏 MODCRAFTING_MIXIN 元数据");
		if (!metadata || !identity) return `Error: Mixin 校验失败\n${errors.map((error) => `- ${error}`).join("\n")}`;
		const kind = metadata.injectionType === "accessor" ? "field" : "method";
		const lookup = await window.api.lookupFabricSymbol({ className: metadata.targetClass, memberName: metadata.selector, descriptor: metadata.descriptor, memberKind: kind });
		if (!lookup.ok || !lookup.class) errors.push(`目标 selector 无效: ${lookup.error || "not found"}`);
		if (lookup.class?.side === "client" && metadata.side !== "client") errors.push("客户端目标不能注册为 common/server Mixin");
		const targetSimpleName = (metadata.targetClass.split(".").pop() || metadata.targetClass).replace(/\$/g, ".");
		if (!source.includes(`@Mixin(${targetSimpleName}.class)`)) errors.push("@Mixin 目标与确定性元数据不一致");
		if (kind === "method" && !source.includes(`${metadata.selector}${metadata.descriptor}`)) errors.push("注解缺少精确方法 descriptor");
		const requiredAnnotation: Record<SupportedMixinInjection, string> = {
			inject: "@Inject", accessor: "@Accessor", invoker: "@Invoker", redirect: "@Redirect", modify_arg: "@ModifyArg", modify_return_value: "@ModifyReturnValue"
		};
		if (!source.includes(requiredAnnotation[metadata.injectionType])) errors.push(`缺少 ${requiredAnnotation[metadata.injectionType]} 注解`);
		let atTargetStatic: boolean | undefined;
		if ((metadata.at === "INVOKE" || metadata.at === "FIELD") && metadata.atTarget) {
			if (!source.includes(`target = \"${metadata.atTarget}\"`)) errors.push("@At target 与确定性元数据不一致");
			const parsedAt = parseAtTarget(metadata.atTarget);
			if (!parsedAt) errors.push("@At target 语法无效");
			else {
				const atLookup = await window.api.lookupFabricSymbol({ className: parsedAt.className, memberName: parsedAt.memberName, descriptor: parsedAt.descriptor, memberKind: parsedAt.kind });
				if (!atLookup.ok) errors.push(`@At target 不存在: ${atLookup.error || "not found"}`);
				else atTargetStatic = (parsedAt.kind === "method" ? atLookup.methods[0] : atLookup.fields[0])?.static;
			}
		}
		const targetMember = kind === "field" ? lookup.fields[0] : lookup.methods[0];
		if (targetMember) {
			try {
				const canonical = buildMixinScaffold({ packageName: identity.packageName, className: identity.className, metadata, targetStatic: targetMember.static, atTargetStatic });
				const signature = (text: string): string => {
					const line = text.split("\n").find((entry) => entry.includes("modcrafting$")) || "";
					return line.trim().replace(/\s+/g, " ").replace(/\s*\{.*$/, "").replace(/;$/, "");
				};
				if (!signature(source) || signature(source) !== signature(canonical)) {
					errors.push(`handler/accessor 签名不正确；期望 ${signature(canonical)}`);
				}
			} catch (error) {
				errors.push(`无法验证 handler 签名: ${String(error)}`);
			}
		}
		const modJson = await readJsonFile(ctx.projectPath, "src/main/resources/fabric.mod.json");
		const refs = modJson ? mixinConfigReferences(modJson) : [];
		let configName = String(args.configPath || "").replace(/\\/g, "/").replace(/^src\/main\/resources\//, "");
		if (!configName) {
			if (refs.length === 1) configName = refs[0];
			else if (refs.length > 1) errors.push(`存在多个配置，校验时必须指定 configPath：${refs.join(", ")}`);
			else errors.push("fabric.mod.json 未引用 Mixin 配置");
		}
		if (configName) {
			if (!refs.includes(configName)) errors.push(`${configName} 未被 fabric.mod.json 引用`);
			const config = await readJsonFile(ctx.projectPath, `src/main/resources/${configName}`);
			if (!config) errors.push(`${configName} 不存在或 JSON 无效`);
			else {
				const basePackage = typeof config.package === "string" ? config.package : "";
				const relative = basePackage && identity.fqn.startsWith(`${basePackage}.`) ? identity.fqn.slice(basePackage.length + 1) : identity.className;
				const key = metadata.side === "client" ? "client" : metadata.side === "server" ? "server" : "mixins";
				if (!Array.isArray(config[key]) || !(config[key] as unknown[]).includes(relative)) errors.push(`${relative} 未注册到 ${configName} 的 ${key}`);
			}
		}
		const expectedPath = `src/main/java/${identity.fqn.replace(/\./g, "/")}.java`;
		if (sourcePath !== expectedPath) errors.push(`源码路径应为 ${expectedPath}`);
		if (errors.length) return `Error: Mixin 校验失败\n${errors.map((error) => `- ${error}`).join("\n")}`;
		const artifacts = [sourcePath, ...(configName ? [`src/main/resources/${configName}`] : [])];
		return {
			output: `Mixin 静态校验通过: ${identity.fqn} -> ${metadata.targetClass}.${metadata.selector}${metadata.descriptor}`,
			artifactPaths: artifacts,
			validation: { kind: "mixin", valid: true, version: "1.21.4", targetPath: sourcePath, checkedAt: Date.now() }
		};
	}
};

// ── explain_code ──
export const explainCodeTool: Tool = {
	name: "explain_code",
	description: "解释指定代码的功能和逻辑。可传入 code 或 filePath（相对项目根目录），分析 Fabric API、注册链与设计意图。",
	schema: {
		type: "object",
		properties: {
			code: { type: "string", description: "要解释的代码内容" },
			filePath: { type: "string", description: "相对项目根的源码路径，如 src/main/java/.../Foo.java" },
			language: { type: "string", enum: ["java", "json"], description: "代码语言，默认 java" },
			context: { type: "string", description: "额外上下文，如类名、模组内容类型等" }
		}
	},
	readOnly: () => true,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		let code = String(args.code || "");
		const filePath = String(args.filePath || "");
		let language = (args.language as string) || "java";
		const context = String(args.context || "");

		if (!code.trim() && filePath && ctx.projectPath) {
			const res = await window.api.readFile(`${ctx.projectPath}/${filePath.replace(/\\/g, "/")}`);
			if (!res.success || res.content == null) {
				return `Error: 无法读取文件 ${filePath}: ${res.error || "empty"}`;
			}
			code = res.content;
			if (filePath.endsWith(".json")) language = "json";
		}

		if (!code.trim()) return "Error: code 或 filePath 至少提供一个";

		const lines = code.split("\n");
		const lineCount = lines.length;
		const packageLine = lines.find((l) => l.trim().startsWith("package "));
		const pkg = packageLine?.match(/package\s+([^;]+)/)?.[1] ?? "";

		let analysis = `## 代码解释\n\n`;
		analysis += `**语言**: ${language === "java" ? "Java (Fabric Mod)" : "JSON"}\n`;
		analysis += `**行数**: ${lineCount}\n`;
		if (filePath) analysis += `**文件**: \`${filePath}\`\n`;
		if (pkg) analysis += `**包名**: \`${pkg}\`\n`;
		if (context) analysis += `**上下文**: ${context}\n`;
		analysis += "\n---\n\n";

		if (language === "java") {
			const imports: string[] = [];
			const classes: string[] = [];
			const methods: string[] = [];
			const fields: string[] = [];
			const annotations: string[] = [];

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith("import ")) {
					const match = trimmed.match(/import ([^;]+);/);
					if (match) imports.push(match[1]);
				} else if (trimmed.startsWith("public class ") || trimmed.startsWith("class ")) {
					const match = trimmed.match(/class (\w+)/);
					if (match) classes.push(match[1]);
				} else if (trimmed.match(/^\s*(public|private|protected)\s+[\w<>,\s]+\s+\w+\s*[;=]/)) {
					const match = trimmed.match(/(?:public|private|protected)\s+[\w<>,\s]+\s+(\w+)\s*[;=]/);
					if (match) fields.push(match[1]);
				} else if (trimmed.match(/^\s*(public|private|protected)\s+\w+\s+\w+\s*\(/)) {
					const match = trimmed.match(/(?:public|private|protected)\s+\w+\s+(\w+)\s*\(/);
					if (match) methods.push(match[1]);
				} else if (trimmed.startsWith("@")) {
					annotations.push(trimmed.slice(0, 60));
				}
			}

			analysis += `### 职责概览\n\n`;
			if (code.includes("ModInitializer") || methods.includes("onInitialize")) {
				analysis += "- **模组主入口**：在 `onInitialize` 中完成内容注册与事件订阅。\n";
			}
			if (code.includes("ClientModInitializer") || methods.includes("onInitializeClient")) {
				analysis += "- **客户端入口**：注册渲染器、颜色提供器等仅客户端逻辑。\n";
			}
			if (code.includes("ModBlocks") || code.includes("ModItems") || code.includes("ModEntities")) {
				analysis += "- **集中注册类**：通过静态字段持有已注册内容，并在 `registerMod*` 方法中记录日志或附加属性。\n";
			}
			if (code.includes("Registry.register") || code.includes("Registries.")) {
				analysis += "- **注册链**：使用 `Identifier` → `RegistryKey` → `Registry.register` 将自定义内容加入游戏注册表（1.21+ 范式）。\n";
			}
			if (code.includes("@Mixin")) {
				analysis += "- **Mixin 注入**：在运行时修改原版类行为，需与 `mixins.json` 配置一致。\n";
			}
			if (code.includes("FoodComponent") || code.includes("ConsumableComponent")) {
				analysis += "- **食物组件**：1.21+ 使用 `FoodComponent` + `ConsumableComponent` 定义营养与食用效果。\n";
			}
			if (classes.length === 0 && !analysis.includes("职责")) {
				analysis += "- 片段代码，需结合所在类判断完整职责。\n";
			}
			analysis += "\n";

			if (classes.length > 0) {
				analysis += `### 类与成员\n\n`;
				for (const cls of classes) {
					const role =
						code.includes(`class ${cls} extends Block`) ? "方块" :
						code.includes(`class ${cls} extends Item`) ? "物品" :
						code.includes(`class ${cls} extends`) && code.includes("Entity") ? "实体" :
						code.includes("@Mixin") ? "Mixin" : "辅助类";
					analysis += `- **${cls}**（${role}）\n`;
				}
				if (fields.length) analysis += `- 静态字段：${fields.slice(0, 8).join(", ")}${fields.length > 8 ? " …" : ""}\n`;
				if (methods.length) analysis += `- 方法：${methods.slice(0, 10).join(", ")}${methods.length > 10 ? " …" : ""}\n`;
				analysis += "\n";
			}

			const fabricImports = imports.filter((i) => i.startsWith("net.fabricmc"));
			const mcImports = imports.filter((i) => i.startsWith("net.minecraft"));
			if (fabricImports.length || mcImports.length) {
				analysis += `### 关键 API\n\n`;
				if (fabricImports.length) analysis += `- Fabric：${fabricImports.slice(0, 6).join(", ")}${fabricImports.length > 6 ? " …" : ""}\n`;
				if (mcImports.length) analysis += `- Minecraft：${mcImports.slice(0, 8).join(", ")}${mcImports.length > 8 ? " …" : ""}\n`;
				analysis += "\n";
			}

			if (annotations.length) {
				analysis += `### 注解 / 注入点\n\n`;
				for (const ann of annotations.slice(0, 6)) analysis += `- \`${ann}\`\n`;
				analysis += "\n";
			}

			analysis += `### 阅读提示\n\n`;
			analysis += "结合 `fabric.mod.json` 入口类与对应 `ModItems`/`ModBlocks` 注册类，可还原完整注册链路。";
			analysis += "若需修改行为，优先查 Fabric API 是否提供事件钩子，再考虑 Mixin。\n";
		} else {
			try {
				const json = JSON.parse(code);
				const keys = Object.keys(json);
				analysis += `### JSON 结构分析\n\n`;
				analysis += `**顶层键**: ${keys.join(", ")}\n\n`;

				if (json.schemaVersion !== undefined) {
					analysis += `### fabric.mod.json 配置\n\n`;
					analysis += `- **mod id**: ${json.id}\n`;
					analysis += `- **名称**: ${json.name}\n`;
					analysis += `- **版本**: ${json.version}\n`;
					if (json.entrypoints) {
						analysis += `- **入口点**: ${JSON.stringify(json.entrypoints)}\n`;
					}
					if (json.depends) {
						analysis += `- **依赖**: ${JSON.stringify(json.depends)}\n`;
					}
				} else {
					analysis += `### 内容说明\n\n`;
					if (json.type && json.type.startsWith("minecraft:")) {
						analysis += `- **类型**: ${json.type}\n`;
					}
					if (json.parent) {
						analysis += `- **父模型**: ${json.parent}\n`;
					}
					if (json.textures) {
						analysis += `- **材质**: ${JSON.stringify(json.textures)}\n`;
					}
				}
			} catch {
				analysis += `### 分析结果\n\n`;
				analysis += "该 JSON 格式无效或无法解析。\n";
			}
		}

		return analysis;
	}
};

// ── list_templates ──
export const listTemplatesTool: Tool = {
	name: "list_templates",
	description: "列出可用的模组模板，显示模板名称、描述和分类。",
	schema: {
		type: "object",
		properties: {}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, _args: Record<string, unknown>): Promise<string> {
		const categories: Record<string, string> = {
			block: "方块",
			item: "物品",
			entity: "实体",
			recipe: "配方",
			structure: "结构"
		};
		const lines = MOD_TEMPLATES.map((t) => `- **${t.name}** (${t.id}) - ${t.description} [分类: ${categories[t.category]}]`);
		return `可用模组模板：\n\n${lines.join("\n")}\n\n使用 fabric_template_generate 命令生成模板代码。`;
	}
};

// ── fabric_template_generate ──
export const fabricTemplateGenerateTool: Tool = {
	name: "fabric_template_generate",
	description: "根据模板生成模组代码骨架。选择模板类型后，自动生成对应的 Java 类和资源文件。",
	schema: {
		type: "object",
		properties: {
			templateId: { type: "string", description: "模板 ID，如 custom-block、custom-item" },
			name: { type: "string", description: "内容名称，如 ruby_block、magic_sword" },
			displayName: { type: "string", description: "中文显示名称，如 红宝石方块" },
			formFields: {
				type: "object",
				description: "快捷创建表单字段（硬度、饱食度、工具类型等），键值与模板表单一致"
			}
		},
		required: ["templateId", "name"]
	},
	readOnly: () => false,
	async execute(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		if (!ctx.projectPath) return "No project open";
		const templateId = String(args.templateId || "");
		const name = String(args.name || "");
		const displayName = args.displayName ? String(args.displayName) : undefined;
		const formFields =
			args.formFields && typeof args.formFields === "object" && !Array.isArray(args.formFields)
				? (args.formFields as Record<string, unknown>)
				: undefined;

		if (!templateId || !name) return "Error: templateId and name are required";

		const template = MOD_TEMPLATES.find((t) => t.id === templateId);
		if (!template) return `Error: template "${templateId}" not found. Use list_templates to see available templates.`;

		const config = await resolveProjectConfig(ctx.projectPath);
		if (!config) {
			return "Error: Cannot determine project configuration. Ensure fabric.mod.json and gradle.properties exist.";
		}

		const result = await executeTemplateGenerate({
			projectPath: ctx.projectPath,
			templateId,
			name,
			displayName,
			formFields,
			config
		});

		if (!result.ok) return result.message;
		return result.message;
	}
};

// ── submit_plan ──
export const submitPlanTool: Tool = {
	name: "submit_plan",
	description:
		"提交经过勘察后的结构化实施计划。仅用于计划阶段；每个步骤必须包含 kind、description、targetPath 和 evidence。",
	schema: {
		type: "object",
		properties: {
			steps: {
				type: "array",
				minItems: 1,
				maxItems: 6,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						kind: { type: "string", enum: ["write", "recipe", "mixin", "inspect"] },
						description: { type: "string", minLength: 1 },
						targetPath: { type: "string", minLength: 1 },
						targetPaths: {
							type: "array",
							minItems: 1,
							uniqueItems: true,
							items: { type: "string", minLength: 1 }
						},
						evidence: { type: "string", minLength: 1 }
					},
					required: ["kind", "description", "evidence"],
					anyOf: [
						{ required: ["targetPath"] },
						{ required: ["targetPaths"] }
					]
				}
			}
		},
		required: ["steps"],
		additionalProperties: false
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const steps = Array.isArray(args.steps) ? args.steps : [];
		return `\`\`\`json\n${JSON.stringify(steps, null, 2)}\n\`\`\``;
	}
};

// ── ask_clarification ──
export const askClarificationTool: Tool = {
	name: "ask_clarification",
	description:
		"向用户提问以澄清需求。当你遇到以下情况时必须使用，禁止猜测：\n" +
		"1. 不确定文件路径（如不知道 mixin 配置文件是 example.mixins.json 还是 my-mod.mixins.json）\n" +
		"2. 不确定包名、类名、mod id、版本号等标识符\n" +
		"3. 需要从多个可行方案中选择（如用 @Inject 还是 @ModifyVariable）\n" +
		"4. 用户需求有歧义，允许多种实现方式\n" +
		"调用后自动暂停执行，等待用户回答后继续。不会导致步骤失败。",
	schema: {
		type: "object",
		properties: {
			question: { type: "string", description: "要问用户的问题，用中文，说明为什么需要确认" },
			options: {
				type: "array",
				items: { type: "string" },
				description: "可选的答案选项，供用户快速选择（最多 4 个）"
			}
		},
		required: ["question"]
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const question = String(args.question || "");
		const options = Array.isArray(args.options) ? (args.options as string[]) : [];
		const optionsText = options.length > 0 ? "\n\n选项：\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n") : "";
		return `[CLARIFICATION_NEEDED]\n问题：${question}${optionsText}`;
	}
};

// Register all built-in tools
import { Registry } from "./tools";
import { logger } from "../utils/logger";

export function registerModCraftingTools(registry: Registry, options?: { disabledTools?: string[] }): void {
	const disabled = new Set(options?.disabledTools || []);
	const tools = [
		readFileTool,
		writeFileTool,
		editFileTool,
		grepTool,
		deleteFileTool,
		fabricDocsSearchTool,
		fabricJavadocLookupTool,
		vanillaMcWikiQueryTool,
		fabricMetaVersionCheckTool,
		fabricModJsonValidateTool,
		createRecipeTool,
		fabricRecipeGenerateTool,
		fabricRecipeValidateTool,
		fabricContentRegisterTool,
		fabricDataAssetsGenerateTool,
		fabricMixinTargetLookupTool,
		fabricMixinScaffoldTool,
		fabricLogDebuggerTool,
		fabricMixinRegisterTool,
		fabricMixinValidateTool,
		listDirectoryTool,
		runCommandTool,
		readErrorLogTool,
		triggerBuildTool,
		explainCodeTool,
		listTemplatesTool,
		fabricTemplateGenerateTool,
		submitPlanTool,
		askClarificationTool,
		completeStepTool
	];
	for (const tool of tools) {
		if (!disabled.has(tool.name)) registry.add(tool);
	}
	logger.agent("Tools registered", registry.names());
}
