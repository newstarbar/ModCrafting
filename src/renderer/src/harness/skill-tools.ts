// ======== Skill tools ========
// Reusable instruction packs (SKILL.md) that the model discovers from the system
// prompt index and reads on demand. Skills are guidance only — they never add tools
// or change gating.

import { type Tool, type ToolContext } from "./tools.ts";
import type { SkillDescriptor } from "../../../shared/skills.ts";

const MAX_INDEX_ENTRIES = 20;
const MAX_DESCRIPTION_CHARS = 90;

export const SKILL_INDEX_HEADER = "## 可用技能";

function clip(text: string): string {
	const value = (text || "").replace(/\s+/g, " ").trim();
	return value.length > MAX_DESCRIPTION_CHARS ? `${value.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : value;
}

/** Deterministic, budget-bounded skill index shared by the system prompt and the tool. */
export function formatSkillIndex(skills: SkillDescriptor[]): string {
	// 排序在这里做一次：system prompt 的字节稳定性不能依赖调用方的列表顺序。
	const enabled = (skills || [])
		.filter((skill) => skill.enabled && skill.id)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (enabled.length === 0) return "";
	const shown = enabled.slice(0, MAX_INDEX_ENTRIES);
	const lines = shown.map((skill) => `- \`${skill.id}\`：${clip(skill.description || skill.name)}`);
	if (enabled.length > shown.length) {
		lines.push(`- （另有 ${enabled.length - shown.length} 个技能未列出，调用 read_skill 不带 id 获取完整列表）`);
	}
	return [
		SKILL_INDEX_HEADER,
		lines.join("\n"),
		"用上表中的精确 id 调用 read_skill 取回完整步骤并严格遵循，禁止凭记忆复述技能内容。"
	].join("\n");
}

export const readSkillTool: Tool = {
	name: "read_skill",
	description:
		"读取可复用技能包（Fabric 开发专业流程指令集）。省略 id 返回当前技能索引；给出 id 返回该技能的完整步骤。命中技能后必须按其步骤执行。",
	schema: {
		type: "object",
		properties: {
			id: {
				type: "string",
				description: "技能 id，取自系统提示词的「可用技能」列表；省略则返回索引"
			}
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const api = typeof window !== "undefined" ? window.api : undefined;
		if (!api?.listSkills || !api?.readSkill) {
			return "read_skill 服务不可用：技能列表由主进程提供。";
		}
		const id = String(args.id ?? "").trim();
		if (!id) {
			const index = formatSkillIndex(await api.listSkills());
			return index || "当前没有已启用的技能。";
		}
		const result = await api.readSkill(id);
		if (!result.success) {
			return `未找到技能：${id}。调用 read_skill（不带 id）查看当前可用技能列表。`;
		}
		if (result.enabled === false) {
			return `技能 ${id} 已被用户停用。需要其它流程时调用 read_skill（不带 id）查看可用列表。`;
		}
		const header = `【技能 · ${result.name || id}】`;
		const summary = result.description ? `${result.description}\n\n` : "";
		return `${header}\n${summary}${(result.content || "").trim()}`;
	}
};
