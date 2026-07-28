import type { Tool, ToolContext } from "./tools";

export type BridgeCallResult = {
	ok: boolean;
	status: number;
	data: Record<string, unknown>;
	error?: string;
};

export async function callMcBridge(method: "GET" | "POST", apiPath: string, body?: Record<string, unknown>, instanceId?: string): Promise<BridgeCallResult> {
	if (typeof window === "undefined" || !window.api?.mcBridgeCall) {
		return { ok: false, status: 0, data: {}, error: "mcBridgeCall 不可用（非 Electron 渲染进程）" };
	}
	return window.api.mcBridgeCall({
		method,
		path: apiPath,
		body,
		instanceId: instanceId || undefined
	});
}

/** 启用/关闭游戏内输入护栏（bridge-mod）。失败不影响主流程。 */
export async function setMcInputGuard(opts: { active: boolean; locked?: boolean; instanceId?: string }): Promise<void> {
	try {
		const body: Record<string, unknown> = { active: opts.active };
		if (typeof opts.locked === "boolean") body.locked = opts.locked;
		else if (opts.active) body.locked = true;
		const attempts = opts.active ? 8 : 1;
		for (let i = 0; i < attempts; i++) {
			const last = await callMcBridge("POST", "/v1/input-guard", body, opts.instanceId);
			if (last.ok) return;
			if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 400));
		}
	} catch {
		// non-critical
	}
}

export function formatBridgeResult(result: BridgeCallResult, omitKeys: string[] = ["base64"]): string {
	if (!result.ok && Object.keys(result.data || {}).length === 0) {
		return `Error: ${result.error || "观测桥调用失败"}`;
	}
	const data = { ...result.data };
	for (const key of omitKeys) {
		if (key in data) {
			const val = data[key];
			if (typeof val === "string" && val.length > 0) {
				data[key] = `[omitted ${val.length} chars]`;
			} else {
				delete data[key];
			}
		}
	}
	if (!result.ok) {
		return `Error: ${result.error || data.error || "观测桥调用失败"}\n${JSON.stringify(data, null, 2)}`;
	}
	return JSON.stringify(data, null, 2);
}

function optionalInstanceId(args: Record<string, unknown>): string | undefined {
	const id = args.instanceId;
	return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export const mcScreenshotTool: Tool = {
	name: "mc_screenshot",
	description: "截取当前 Minecraft 客户端画面（观测桥）。返回路径/尺寸；视觉模型可能附带 base64。无论模型是否支持视觉，截图都会保存并在任务总结中展示。非视觉模型请配合 mc_inspect 做数据化验证。",
	schema: {
		type: "object",
		properties: {
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const result = await callMcBridge("GET", "/v1/screenshot", undefined, optionalInstanceId(args));
		const output = formatBridgeResult(result);
		const base64 = typeof result.data.base64 === "string" ? result.data.base64 : undefined;
		const shotPath = typeof result.data.path === "string" ? result.data.path : undefined;
		return {
			output,
			artifactPaths: shotPath ? [shotPath] : undefined,
			imageBase64: base64,
			imageMimeType: base64 ? "image/png" : undefined
		};
	}
};

export const mcInspectTool: Tool = {
	name: "mc_inspect",
	description: "一次性检视：玩家 + 当前界面 + 控件 + 准星。ready 后用此或 mc_screenshot 验证症状；点按钮用 mc_input click_widget/click_at。仅 TitleScreen 不算验证完成。",
	schema: {
		type: "object",
		properties: {
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const result = await callMcBridge("GET", "/v1/inspect", undefined, optionalInstanceId(args));
		return formatBridgeResult(result);
	}
};

export const mcInventoryTool: Tool = {
	name: "mc_inventory",
	description: "读取玩家快捷栏、主背包、盔甲与副手（观测桥）。",
	schema: {
		type: "object",
		properties: {
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const result = await callMcBridge("GET", "/v1/inventory", undefined, optionalInstanceId(args));
		return formatBridgeResult(result);
	}
};

export const mcWorldTool: Tool = {
	name: "mc_world",
	description: "列出附近实体并采样玩家周围方块。",
	schema: {
		type: "object",
		properties: {
			radius: { type: "number", description: "搜索半径（1-64，默认 8）" },
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const radius = typeof args.radius === "number" ? args.radius : Number(args.radius || 8);
		const q = Number.isFinite(radius) ? `?radius=${encodeURIComponent(String(radius))}` : "";
		const result = await callMcBridge("GET", `/v1/nearby${q}`, undefined, optionalInstanceId(args));
		return formatBridgeResult(result);
	}
};

/**
 * 观察指定实体的详细状态（AI 目标、移动速度、爆炸倒计时、传送状态等）。
 * 用途：验证实体行为修改（如苦力怕爆炸、末影人传送）。
 */
export const mcObserveEntityTool: Tool = {
	name: "mc_observe_entity",
	description:
		"观察指定实体的详细状态（观测桥 /v1/entity）。返回 AI 目标、移动速度、爆炸倒计时、传送状态、特殊状态等。" +
		"用途：验证实体行为修改（如苦力怕爆炸改樱花、末影人移动方式修改）。" +
		"参数：uuid（精确观察，来自 mc_world 的 entities 列表）或 type（按类型查找最近实体，如 minecraft:creeper）。" +
		"实体行为修改类功能必须用本工具对比状态变化，禁止仅凭截图宣称完成。",
	schema: {
		type: "object",
		properties: {
			uuid: { type: "string", description: "实体 UUID（来自 mc_world 的 entities 列表）" },
			type: { type: "string", description: "实体类型 ID（如 minecraft:creeper 或 creeper），自动查找最近的" },
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => true,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const uuid = args.uuid ? String(args.uuid) : undefined;
		const type = args.type ? String(args.type) : undefined;
		const q = uuid ? `?uuid=${encodeURIComponent(uuid)}` : type ? `?type=${encodeURIComponent(type)}` : "";
		if (!q) {
			return [
				"Error: 需要提供 uuid 或 type 参数。",
				"用法：",
				"- mc_observe_entity type=minecraft:creeper（按类型查找最近实体）",
				"- mc_observe_entity uuid=12345abcde（精确观察指定实体）",
				"提示：uuid 可从 mc_world 返回的 entities 列表中获取。"
			].join("\n");
		}
		const result = await callMcBridge("GET", `/v1/entity${q}`, undefined, optionalInstanceId(args));
		return formatBridgeResult(result);
	}
};

export const mcChatTool: Tool = {
	name: "mc_chat",
	description: "读取近期聊天，或发送聊天/命令（以 / 开头的命令可用）。",
	schema: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["read", "send"], description: "read=读缓冲；send=发送" },
			text: { type: "string", description: "action=send 时的消息内容" },
			limit: { type: "number", description: "action=read 时最多条数（默认 50）" },
			instanceId: { type: "string", description: "可选实例 id" }
		},
		required: ["action"]
	},
	// send is a write; keep sequential even for read to avoid racing with send
	readOnly: () => false,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const action = String(args.action || "read");
		const instanceId = optionalInstanceId(args);
		if (action === "send") {
			const text = String(args.text || "");
			const result = await callMcBridge("POST", "/v1/chat", { text }, instanceId);
			return formatBridgeResult(result);
		}
		const limit = typeof args.limit === "number" ? args.limit : Number(args.limit || 50);
		const q = Number.isFinite(limit) ? `?limit=${encodeURIComponent(String(limit))}` : "";
		const result = await callMcBridge("GET", `/v1/chat${q}`, undefined, instanceId);
		return formatBridgeResult(result);
	}
};
export const mcCommandTool: Tool = {
	name: "mc_command",
	description: "以本地玩家执行 Minecraft 命令（自动补 /）。多数命令需要单人集成服务端。",
	schema: {
		type: "object",
		properties: {
			command: { type: "string", description: "命令（可带或不带前导 /）" },
			instanceId: { type: "string", description: "可选实例 id" }
		},
		required: ["command"]
	},
	readOnly: () => false,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const command = String(args.command || "");
		const result = await callMcBridge("POST", "/v1/command", { command }, optionalInstanceId(args));
		return formatBridgeResult(result);
	}
};

export const mcInputTool: Tool = {
	name: "mc_input",
	description:
		'模拟客户端输入。GUI：click_at {x,y} 或 click_widget {index|label} 点按钮；key_press {key:"f6"} 热键。世界：前进/跳跃/使用/攻击等。验证 GUI 时必须点进待测界面，不能停在 TitleScreen。',
	schema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description: "click_at|click_widget|key_press|key_down|key_up|mouse_click|mouse_move|scroll|forward|back|left|right|jump|sneak|sprint|use|attack|inventory|drop|swap_hands"
			},
			key: { type: "string", description: "key_* 用按键（w/e/space/f6/esc/…）" },
			button: { type: "string", description: "left|right|middle" },
			x: { type: "number", description: "click_at 的缩放 GUI X" },
			y: { type: "number", description: "click_at 的缩放 GUI Y" },
			index: { type: "number", description: "click_widget 的控件序号（来自 inspect/widgets）" },
			label: { type: "string", description: "click_widget 的按钮文案子串" },
			dx: { type: "number", description: "mouse_move 偏航增量" },
			dy: { type: "number", description: "mouse_move 俯仰增量" },
			delta: { type: "number", description: "滚轮增量" },
			durationMs: { type: "number", description: "按住时长（毫秒）" },
			instanceId: { type: "string", description: "可选实例 id" }
		},
		required: ["action"]
	},
	readOnly: () => false,
	async execute(_ctx: ToolContext, args: Record<string, unknown>) {
		const body: Record<string, unknown> = {
			action: args.action,
			key: args.key,
			button: args.button,
			x: args.x,
			y: args.y,
			index: args.index,
			label: args.label,
			message: args.label,
			dx: args.dx,
			dy: args.dy,
			delta: args.delta,
			durationMs: args.durationMs
		};
		const result = await callMcBridge("POST", "/v1/input", body, optionalInstanceId(args));
		// F-keys often open screens asynchronously (screenshot → preview). Brief settle wait.
		const action = String(args.action || "").toLowerCase();
		const key = String(args.key || "").toLowerCase();
		if ((action === "key_press" || action === "key_down") && /^f([1-9]|1[0-2])$/.test(key)) {
			await new Promise((r) => setTimeout(r, 900));
		}
		if (action === "click_widget" || action === "click_at") {
			await new Promise((r) => setTimeout(r, 250));
			// 获取当前屏幕状态（加载检测 + 失败时附加上下文）
			const inspect = await callMcBridge("GET", "/v1/screen", undefined, optionalInstanceId(args));
			if (inspect.ok) {
				const kind = String((inspect.data as { kind?: string }).kind || "");
				const simple = String((inspect.data as { simpleName?: string }).simpleName || "");
				if (isLoadingScreenKind(kind, simple)) {
					return [formatBridgeResult(result), "[note] 当前仍在加载界面（loading）。请等待世界加载完成，用 mc_inspect 轮询，禁止 click_widget，更不要因此重新 runClient。"].join("\n");
				}
				// 失败时附加上下文：当前屏幕名 + 可用控件列表，帮助 AI 选择正确的 index/label
				if (!result.ok) {
					const data = inspect.data as Record<string, unknown>;
					const widgets = Array.isArray(data.widgets) ? data.widgets : [];
					const screenName = simple || kind || "unknown";
					const widgetList = widgets
						.slice(0, 10)
						.map((w: Record<string, unknown>, i: number) => {
							const label = w.label || w.text || w.type || "unnamed";
							const visible = w.visible === false ? " (隐藏)" : "";
							return `  [${i}] ${label}${visible}`;
						})
						.join("\n");
					return [formatBridgeResult(result), `[上下文] 当前屏幕: ${screenName}，可用控件:\n${widgetList || "  (无控件)"}`].join("\n");
				}
			}
		}
		return formatBridgeResult(result);
	}
};

// ── 测试环境编排辅助 ──

const POLL_INTERVAL_MS = 500;
const WORLD_ENTER_TIMEOUT_MS = 120_000;
const LAN_OPEN_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 从 inspect 结果中提取状态摘要 */
function parseInspectState(inspect: BridgeCallResult): {
	inWorld: boolean;
	screenKind: string;
	screenClass: string;
	playerOk: boolean;
	gamemode?: string;
} {
	const data = inspect.data || {};
	const screen = (data.screen as Record<string, unknown>) || {};
	const player = (data.player as Record<string, unknown>) || {};
	return {
		inWorld: Boolean(data.inWorld ?? screen.inWorld ?? player.ok),
		screenKind: String(screen.kind || "unknown"),
		screenClass: String(screen.simpleName || screen.className || ""),
		playerOk: Boolean(player.ok),
		gamemode: typeof player.gamemode === "string" ? player.gamemode : undefined
	};
}

function isLoadingScreenKind(kind: string, screenClass: string): boolean {
	if (kind === "loading") return true;
	const s = screenClass || "";
	return /Loading|Progress|DownloadingTerrain|LevelLoading|SaveLevel/i.test(s);
}

/** 等待直到进入世界或超时；加载界面只等待、不点击 */
async function waitForInWorld(instanceId?: string): Promise<BridgeCallResult> {
	const deadline = Date.now() + WORLD_ENTER_TIMEOUT_MS;
	let last: BridgeCallResult = { ok: false, status: 0, data: {} };
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		last = await callMcBridge("GET", "/v1/inspect", undefined, instanceId);
		const state = parseInspectState(last);
		if (state.inWorld) return last;
		// loading：继续等，不要当作失败去点按钮
	}
	return last;
}

/**
 * 自动创建测试世界：点击"创建新的世界"→开启作弊→确认创建→等待加载。
 * 封装在 mc_ensure_test_world 内部，不消耗 AI 的迭代次数。
 * @param alreadyInCreateScreen 如果已经在 CreateWorldScreen 中，跳过第一步（点击"创建新的世界"进入创建界面）
 */
async function autoCreateTestWorld(instanceId?: string, alreadyInCreateScreen = false): Promise<{ ok: boolean; message: string }> {
	// 1. 点击"创建新的世界"进入创建界面（如果已经在创建界面则跳过）
	if (!alreadyInCreateScreen) {
		const enterCreate = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "创建新的世界" }, instanceId);
		if (!enterCreate.ok) {
			// 尝试备选文案
			const altEnter = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "创建新世界" }, instanceId);
			if (!altEnter.ok) {
				return {
					ok: false,
					message:
						'自动创建测试世界失败：无法点击"创建新的世界"按钮。' + formatBridgeResult(enterCreate) + "\n提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动点击创建按钮。"
				};
			}
		}
		await sleep(1500);
	}

	// 2. 开启"允许命令"（作弊权限）
	// 1.21.4 中按钮文案可能是"允许命令"或"Allow Commands"
	const cheatsToggle = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "允许命令" }, instanceId);
	// 即使切换失败也继续（可能已开启或按钮文案不同）
	if (cheatsToggle.ok) await sleep(500);

	// 3. 点击确认创建按钮（1.21.4 中文案为"创建新世界"，旧版为"创建新的世界"）
	const confirmLabels = ["创建新世界", "创建新的世界", "Create New World"];
	let confirmOk = false;
	for (const label of confirmLabels) {
		const confirmCreate = await callMcBridge("POST", "/v1/input", { action: "click_widget", label }, instanceId);
		if (confirmCreate.ok) {
			confirmOk = true;
			break;
		}
	}
	if (!confirmOk) {
		return {
			ok: false,
			message: '自动创建测试世界失败：无法找到确认创建按钮（尝试了"创建新世界"/"创建新的世界"）。' + "\n提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动点击创建确认按钮。"
		};
	}

	// 4. 等待世界加载完成
	const worldResult = await waitForInWorld(instanceId);
	const worldState = parseInspectState(worldResult);
	if (worldState.inWorld) {
		const player = (worldResult.data.player as Record<string, unknown>) || {};
		return {
			ok: true,
			message: [
				"已自动创建测试世界并进入。",
				`玩家：${player.name || "unknown"} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || "unknown"}`,
				"下一步：调用 mc_test_scenario(feature_type=...) 获取测试步骤模板。",
				"feature_type 取值：new_item（新物品）/ new_block（新方块）/ new_recipe（新合成配方）/ entity_behavior（实体行为修改，如苦力怕爆炸改樱花）/ player_interaction（玩家交互功能，如闪电剑）/ hud_gui（HUD或界面）。",
				"::kh::测试环境|世界|已进入"
			].join("\n")
		};
	}
	return {
		ok: false,
		message: "测试世界创建后等待加载超时。请用 mc_inspect 检视当前状态，或等待加载完成后重试。"
	};
}

/** 检测聊天缓冲中是否有权限错误信号 */
function chatIndicatesPermissionError(messages: Array<Record<string, unknown>>): boolean {
	// 检查最近 10 条消息
	const recent = messages.slice(-10);
	for (const m of recent) {
		const text = String(m.text || "").toLowerCase();
		if (
			text.includes("没有权限") ||
			text.includes("no permission") ||
			text.includes("not allowed") ||
			text.includes("unknown or incomplete command") ||
			text.includes("未知的或不完整的命令") ||
			text.includes("you do not have permission") ||
			text.includes("you don't have permission") ||
			text.includes("你没有权限")
		) {
			return true;
		}
	}
	return false;
}

/** 尝试执行一个需要权限的命令并检测是否权限不足 */
async function probeCommandPermission(instanceId?: string): Promise<boolean> {
	// give 命令需要 OP 权限；成功时无聊天反馈，失败时有错误消息
	const give = await callMcBridge("POST", "/v1/command", { command: "give @s minecraft:stone 1" }, instanceId);
	if (!give.ok) return false;
	// 等待服务端处理并发送聊天反馈
	await sleep(800);
	const chat = await callMcBridge("GET", "/v1/chat?limit=10", undefined, instanceId);
	if (!chat.ok) return true; // 无法读聊天，假设有权限
	const messages = (chat.data.messages as Array<Record<string, unknown>>) || [];
	return !chatIndicatesPermissionError(messages);
}

// ── mc_ensure_test_world：进入/创建测试世界 ──

export const mcEnsureTestWorldTool: Tool = {
	name: "mc_ensure_test_world",
	description:
		"确保已进入 Minecraft 测试世界：检测当前状态，若在主菜单则自动进入已有世界；若已在世界则直接返回。" +
		"用途：功能测试前必须先进入世界，不能停在主菜单。runClient 后调用本工具进入世界，再触发功能场景。" +
		"注意：本工具不创建新世界（创建世界需要手动操作）。如果没有任何存档，会返回明确提示让用户手动创建。",
	schema: {
		type: "object",
		properties: {
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => false,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const instanceId = optionalInstanceId(args);

		// 1. 检测当前状态
		const inspect = await callMcBridge("GET", "/v1/inspect", undefined, instanceId);
		if (!inspect.ok) {
			return formatBridgeResult(inspect) + "\n[note] 观测桥不可用，请确认游戏已通过 trigger_build runClient 启动。";
		}

		const state = parseInspectState(inspect);

		// 2. 已在世界中 → 直接返回
		if (state.inWorld && state.playerOk) {
			const player = (inspect.data.player as Record<string, unknown>) || {};
			return [
				"已进入游戏世界，无需重复进入。",
				`玩家：${player.name || "unknown"} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || "unknown"}`,
				"下一步：调用 mc_test_scenario(feature_type=...) 获取测试步骤模板。",
				"feature_type 取值：new_item（新物品）/ new_block（新方块）/ new_recipe（新合成配方）/ entity_behavior（实体行为修改）/ player_interaction（玩家交互功能）/ hud_gui（HUD或界面）。",
				"::kh::测试环境|世界|已进入"
			].join("\n");
		}

		// 2b. 正在加载 → 只等待，禁止点按钮 / 禁止因此重启游戏
		if (isLoadingScreenKind(state.screenKind, state.screenClass)) {
			const worldInspect = await waitForInWorld(instanceId);
			const worldState = parseInspectState(worldInspect);
			if (worldState.inWorld) {
				const player = (worldInspect.data.player as Record<string, unknown>) || {};
				return [
					"世界加载完成，已进入游戏世界。",
					`玩家：${player.name || "unknown"} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || "unknown"}`,
					"下一步：调用 mc_test_scenario(feature_type=...) 获取测试步骤模板。",
					"::kh::测试环境|世界|已进入"
				].join("\n");
			}
			return [
				"世界仍在加载中，等待超时（120s）。",
				`当前界面：${worldState.screenKind} / ${worldState.screenClass}`,
				"提示：请用 mc_inspect 继续观察加载进度并等待；禁止 click_widget，禁止因此重新 trigger_build runClient（会导致双开/卡死）。",
				"::kh::测试环境|世界|加载超时"
			].join("\n");
		}

		// 3. 在主菜单 → 尝试进入单人世界
		if (state.screenKind === "title" || state.screenClass === "TitleScreen") {
			// a. 点击"单人游戏"
			const clickSingleplayer = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "单人游戏" }, instanceId);
			if (!clickSingleplayer.ok) {
				return [
					'当前在主菜单，但无法找到"单人游戏"按钮。',
					formatBridgeResult(clickSingleplayer),
					"提示：可能是多人游戏界面。请用 mc_input click_widget 手动进入单人世界列表。",
					"::kh::测试环境|世界|主菜单阻塞"
				].join("\n");
			}
			await sleep(1000);

			// b. 检测是否进入世界选择界面
			const afterClick = await callMcBridge("GET", "/v1/inspect", undefined, instanceId);
			const afterState = parseInspectState(afterClick);

			if (afterState.inWorld) {
				// 某些情况点击会直接进入世界
				return ["已进入游戏世界。", "下一步：调用 mc_test_scenario(feature_type=...) 获取测试步骤模板。", "::kh::测试环境|世界|已进入"].join("\n");
			}

			// 1.21.4 中无存档时点击"单人游戏"会直接进入 CreateWorldScreen（创建世界界面）
			// 同时识别 SelectWorldScreen（选择世界界面）和 CreateWorldScreen（创建世界界面）
			const isSelectWorld = afterState.screenKind === "select_world" || afterState.screenClass === "SelectWorldScreen";
			const isCreateWorld = afterState.screenClass.includes("CreateWorld") || afterState.screenClass.includes("CreateNewWorld") || afterState.screenKind === "create_world";
			if (!isSelectWorld && !isCreateWorld) {
				return [
					'点击"单人游戏"后未进入世界选择/创建界面，当前界面：' + afterState.screenKind + " / " + afterState.screenClass,
					"提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动操作。",
					"::kh::测试环境|世界|选择界面阻塞"
				].join("\n");
			}
			// 如果已经直接进入 CreateWorldScreen（无存档场景），跳过世界条目查找，直接自动创建
			if (isCreateWorld && !isSelectWorld) {
				const createResult = await autoCreateTestWorld(instanceId, true);
				return createResult.message;
			}

			// c. 在世界选择界面，查找并点击第一个世界条目
			// widgets 可能是数组、也可能是 { widgets: [...] } 嵌套结构、也可能在 screen.widgets 中
			const widgetsRaw = afterClick.data.widgets;
			const screenRaw = (afterClick.data.screen as Record<string, unknown>) || {};
			const widgetList: Array<Record<string, unknown>> = Array.isArray(widgetsRaw)
				? widgetsRaw
				: Array.isArray((widgetsRaw as { widgets?: Array<Record<string, unknown>> })?.widgets)
					? (widgetsRaw as { widgets: Array<Record<string, unknown>> }).widgets
					: Array.isArray((screenRaw as { widgets?: Array<Record<string, unknown>> })?.widgets)
						? (screenRaw as { widgets: Array<Record<string, unknown>> }).widgets
						: [];
			// 世界条目：优先匹配 type 含 'Entry' 的控件（WorldListEntry）
			// 如果没有 Entry 类型，再尝试匹配非功能按钮（排除已知功能按钮文案）
			// 注意：'返回'、'取消'、'搜索'等按钮不是世界条目
			const worldEntry = widgetList.find((w) => {
				const msg = String(w.message || "");
				const type = String(w.type || "");
				const active = w.active !== false;
				// 必须激活且有消息
				if (!active || msg.length === 0) return false;
				// 只匹配 Entry 类型（WorldListEntry）
				if (type.includes("Entry")) return true;
				// 排除所有已知功能按钮和无关按钮
				const excludeKeywords = [
					"创建",
					"新建",
					"删除",
					"编辑",
					"重建",
					"进入",
					"选定",
					"create",
					"delete",
					"edit",
					"rebuild",
					"enter",
					"返回",
					"取消",
					"搜索",
					"return",
					"cancel",
					"search",
					"模组",
					"选项",
					"退出",
					"多人",
					"Realms"
				];
				if (excludeKeywords.some((kw) => msg.includes(kw))) return false;
				// 只匹配 WorldListWidget 子条目或 ButtonWidget（排除 TextFieldWidget 等）
				if (type.includes("World") && !type.includes("WorldListWidget")) return true;
				return false;
			});

			if (!worldEntry) {
				// 没有存档时自动创建测试世界，避免 AI 手动操作消耗大量迭代
				const createResult = await autoCreateTestWorld(instanceId);
				return createResult.message;
			}

			// 点击世界条目
			const clickWorld = await callMcBridge("POST", "/v1/input", { action: "click_widget", index: worldEntry.index }, instanceId);
			if (!clickWorld.ok) {
				return "点击世界条目失败：" + formatBridgeResult(clickWorld);
			}
			await sleep(500);

			// d. 点击"进入世界"按钮（或"选定世界"）
			const enterResult = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "进入" }, instanceId);
			if (!enterResult.ok) {
				// 可能按钮文案不同，尝试其它匹配
				const altResult = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "选定" }, instanceId);
				if (!altResult.ok) {
					return ['无法找到"进入世界"按钮。', "提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动点击进入按钮。", "::kh::测试环境|世界|进入按钮缺失"].join("\n");
				}
			}

			// e. 等待进入世界
			const worldInspect = await waitForInWorld(instanceId);
			const worldState = parseInspectState(worldInspect);

			if (worldState.inWorld) {
				const player = (worldInspect.data.player as Record<string, unknown>) || {};
				return [
					"已进入游戏世界：" + (worldEntry.message || "unknown"),
					`玩家：${player.name || "unknown"} | 位置：(${player.x}, ${player.y}, ${player.z}) | 游戏模式：${player.gamemode || "unknown"}`,
					"下一步：调用 mc_test_scenario(feature_type=...) 获取测试步骤模板。",
					"feature_type 取值：new_item / new_block / new_recipe / entity_behavior / player_interaction / hud_gui。",
					"提示：若需要执行命令（give/summon/gamemode），先调用 mc_ensure_cheats 确保作弊权限已开启。",
					"::kh::测试环境|世界|已进入"
				].join("\n");
			}

			return [
				"等待进入世界超时（60s）。",
				`最后界面：${worldState.screenKind} / ${worldState.screenClass}`,
				"提示：若仍在 loading，请用 mc_inspect 继续等待；不要 click_widget，不要因此重新 runClient。",
				"::kh::测试环境|世界|进入超时"
			].join("\n");
		}

		// 4. 在其它界面 → 返回当前状态
		return [
			`当前不在主菜单也不在世界中，界面：${state.screenKind} / ${state.screenClass}`,
			"提示：请用 mc_inspect 检视当前界面。若是加载界面请等待；不要为点不到按钮而重新 runClient。",
			"::kh::测试环境|世界|未知界面"
		].join("\n");
	}
};

// ── mc_ensure_cheats：确保作弊权限 ──

export const mcEnsureCheatsTool: Tool = {
	name: "mc_ensure_cheats",
	description:
		"确保当前单人世界已开启作弊权限（可执行 /give /gamemode /summon 等命令）。" +
		'检测逻辑：执行 give 命令 → 读聊天缓冲 → 若权限不足则通过"对局域网开放"自动开启作弊。' +
		"用途：mc_command 执行需要权限的命令前调用本工具；或功能测试需要生成生物/给予物品/切换模式时先调用。",
	schema: {
		type: "object",
		properties: {
			instanceId: { type: "string", description: "可选实例 id" }
		}
	},
	readOnly: () => false,
	async execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const instanceId = optionalInstanceId(args);

		// 1. 确认在世界中
		const inspect = await callMcBridge("GET", "/v1/inspect", undefined, instanceId);
		if (!inspect.ok) {
			return formatBridgeResult(inspect) + "\n[note] 观测桥不可用。";
		}
		const state = parseInspectState(inspect);
		if (!state.inWorld) {
			return ["未进入游戏世界，无法确保作弊权限。", "提示：请先调用 mc_ensure_test_world 进入世界，再调用本工具。", "::kh::测试环境|作弊权限|未进入世界"].join("\n");
		}

		// 2. 探测当前权限
		const hasPermission = await probeCommandPermission(instanceId);
		if (hasPermission) {
			return [
				"作弊权限已开启，可执行 /give /gamemode /summon 等命令。",
				"提示：现在可以用 mc_command 执行测试场景命令（如 summon minecraft:zombie 给予 @s minecraft:diamond_sword）。",
				"::kh::测试环境|作弊权限|已开启"
			].join("\n");
		}

		// 3. 权限不足 → 通过"对局域网开放"开启作弊
		// a. 按 Esc 打开游戏菜单
		const escResult = await callMcBridge("POST", "/v1/input", { action: "key_press", key: "escape" }, instanceId);
		if (!escResult.ok) {
			return "按 Esc 打开菜单失败：" + formatBridgeResult(escResult);
		}
		await sleep(600);

		// b. 点击"对局域网开放"
		const lanClick = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "对局域网开放" }, instanceId);
		if (!lanClick.ok) {
			// 可能已经在局域网模式，或文案不同
			// 尝试英文文案
			const lanClickEn = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "Open to LAN" }, instanceId);
			if (!lanClickEn.ok) {
				return [
					'无法找到"对局域网开放"按钮。可能原因：1) 已经在局域网模式 2) 当前是服务端世界 3) 菜单文案不同。',
					"提示：请用 mc_inspect 检视当前菜单，用 mc_input click_widget 手动开启作弊。",
					"::kh::测试环境|作弊权限|局域网按钮缺失"
				].join("\n");
			}
		}
		await sleep(500);

		// c. 点击"允许作弊"选项（切换为开）
		const cheatToggle = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "允许作弊" }, instanceId);
		// 即使点击失败也继续（可能默认已开或文案不同）
		if (cheatToggle.ok) {
			await sleep(300);
		}

		// d. 点击"启动对局域网开放"按钮
		const startLan = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "启动" }, instanceId);
		if (!startLan.ok) {
			// 尝试"开始对局域网开放"
			const altStart = await callMcBridge("POST", "/v1/input", { action: "click_widget", label: "开始" }, instanceId);
			if (!altStart.ok) {
				return ['无法找到"启动对局域网开放"按钮。', "提示：请用 mc_inspect 检视当前界面，用 mc_input click_widget 手动启动。", "::kh::测试环境|作弊权限|启动按钮缺失"].join("\n");
			}
		}

		// e. 等待返回游戏（局域网开放后自动关闭菜单）
		await sleep(1000);

		// f. 再次探测权限
		const recheckPermission = await probeCommandPermission(instanceId);
		if (recheckPermission) {
			return ['已通过"对局域网开放"开启作弊权限，现在可执行 /give /gamemode /summon 等命令。', "提示：现在可以用 mc_command 执行测试场景命令。", "::kh::测试环境|作弊权限|已开启"].join("\n");
		}

		return [
			'尝试通过"对局域网开放"开启作弊权限，但验证仍失败。',
			"提示：可能是命令执行有其它问题（非权限问题）。请用 mc_command 执行命令后 mc_chat read 检查反馈。",
			"::kh::测试环境|作弊权限|开启失败"
		].join("\n");
	}
};

// ── 工具注册表（必须在所有工具定义之后，避免 TDZ） ──

export const MC_OBSERVER_TOOLS: Tool[] = [
	mcScreenshotTool,
	mcInspectTool,
	mcInventoryTool,
	mcWorldTool,
	mcObserveEntityTool,
	mcChatTool,
	mcCommandTool,
	mcInputTool,
	mcEnsureTestWorldTool,
	mcEnsureCheatsTool
];

export const MC_READONLY_TOOLS = new Set(["mc_screenshot", "mc_inspect", "mc_inventory", "mc_world", "mc_observe_entity"]);

export const MC_WRITE_TOOLS = new Set(["mc_chat", "mc_command", "mc_input", "mc_ensure_test_world", "mc_ensure_cheats"]);
