// ======== Controller ========
// Ported from Reasonix internal/control/controller.go
// Session management, plan/execute phases, approval gates

import { type Sink, EventKind, type Event, FuncSink, LoggerSink } from "./events";
import { Agent } from "./agent";
import { contentAsText, isVisionCapableModel, type ChatContentPart, type ChatMessage } from "./chat-message";
import { contentPartsAsClassifyText } from "../context/user-content.ts";
import { Registry } from "./tools";
import { PlanTracker } from "./plan-tracker";
import { parsePlanSteps, planHasActionableSteps, selectPlanText, selectVisiblePlanText, isActionablePlanText } from "../utils/plan-steps";
import { logger } from "../utils/logger";
import { buildFabricAgentPolicyPrompt } from "./fabric-agent-policy";
import { isRetryableFetchError } from "./fetch-retry";
import { type ComposerMode, buildSessionGoalBlock, isNarrowResumeInput, isStructuralErrorReport, buildUserSymptomBlock, buildCrossTurnDiagnosisRetain } from "./turn-intent";
import { classifyUserTurn, type ClassifyUserTurnResult } from "./turn-classifier.ts";
import { isQuickCreateGeneratedMessage } from "../project/template-params.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";
import type { WorkflowStep } from "./workflow-types.ts";
import { TOOL_LABELS_ZH } from "./tool-labels";
import { defaultVerifyTarget, formatVerifyTargetBlock, verifyTargetFromClassification, type VerifyTarget } from "./verify-target.ts";
import { formatGradleSummary, formatJavaFileList, parseGradleProperties, scanJavaSourceTree } from "./project-info.ts";
import { isGuiFilePath, stepRequiresGuiPreview } from "./plan-normalizer.ts";
import { registerKnownProjectPaths } from "./tool-definitions.ts";

export interface ControllerOptions {
	registry: Registry;
	projectPath: string | null;
	apiConfig: { endpoint: string; apiKey: string; model: string };
	onEvent?: (event: Event) => void;
	onAgentStatus?: (status: string) => void;
	onStreamUpdate?: (text: string, reasoning?: string) => void;
}

export class Controller {
	private agent: Agent;
	private registry: Registry;
	private sink: Sink;
	private _projectPath: string | null;

	apiConfig: { endpoint: string; apiKey: string; model: string };

	// Session
	messages: ChatMessage[] = [];
	private _running = false;
	private abortController: AbortController | null = null;

	private _phase: "plan" | "execute" = "plan";
	private planTracker: PlanTracker | null = null;
	private pendingApproval: { id: string; resolve: (allow: boolean) => void } | null = null;
	private composerMode: ComposerMode = "agent";
	private sessionGoal = "";
	/** Sticky user-reported bug/symptom; runClient ready alone must not clear it. */
	private activeUserSymptom: string | null = null;
	/** Derived from classifier: which screen/hotkey must be hit for in-game verify. */
	private activeVerifyTarget: VerifyTarget | null = null;
	/** Last classifier: symptom is GUI/hotkey/preview related. */
	private lastGuiFeatureSymptom = false;
	/** Cached project scan for execute-entry user message (kept out of system prompt). */
	private lastProjectInfo = "";
	private planReadyAwaitingExecute = false;
	/** Last plan text that had parseable steps (even if hard-validation failed). Used by 继续. */
	private lastPlanCandidate: string | null = null;
	private lastTurnMode: "chat" | "develop" | "plan_only" | "resume" = "chat";
	/** Last mode written into messages[0]; skip rewrite when unchanged (prompt-cache). */
	private lastSystemMode: "chat" | "plan" | "execute" | null = null;
	private useOpenCodeDelegate = false;
	private openCodeModel = "opencode/deepseek-v4-flash-free";
	private openCodeAdapter: OpenCodeAdapter | null = null;
	private taskId = `task_${Date.now().toString(36)}`;
	/** GUI 布局预览：pending 的 Promise resolver（id → resolve）。同一时刻只允许一个 pending。 */
	private pendingGuiLayoutResolvers = new Map<string, (json: string) => void>();
	/** GUI 布局预览是否正在等待用户确认。 */
	guiLayoutPending = false;

	// Callbacks
	onEvent?: (event: Event) => void;
	onAgentStatus?: (status: string) => void;
	onStreamUpdate?: (text: string, reasoning?: string) => void;

	constructor(opts: ControllerOptions) {
		this.registry = opts.registry;
		this._projectPath = opts.projectPath;
		this.apiConfig = opts.apiConfig;
		this.onEvent = opts.onEvent;
		this.onAgentStatus = opts.onAgentStatus;
		this.onStreamUpdate = opts.onStreamUpdate;

		this.sink = new LoggerSink(
			new FuncSink((event) => {
				this.onEvent?.(event);
			})
		);

		this.agent = new Agent({
			registry: this.registry,
			sink: this.sink,
			onToolDispatch: (name) => {
				this.onAgentStatus?.(`执行: ${name}...`);
			},
			onToolResult: (name, _id, output) => {
				this.onAgentStatus?.(`${name} 完成`);
				logger.tool(`${name} completed`, output.slice(0, 100));
			},
			onGuiLayoutPreview: (payload) => this.handleGuiLayoutPreview(payload),
			onCancelPendingGuiLayouts: () => this.cancelAllPendingGuiLayouts()
		});

		this.openCodeAdapter = new OpenCodeAdapter({
			sink: this.sink,
			onStatus: (status) => this.onAgentStatus?.(status),
			getModel: () => this.openCodeModel
		});

		void this.refreshOpenCodeSettings();
	}

	async refreshOpenCodeSettings(): Promise<void> {
		try {
			const cfg = await window.api.loadAgentConfig();
			const prefer = cfg.useOpenCodeDelegate === true;
			this.openCodeModel = cfg.openCodeModel || "opencode/deepseek-v4-flash-free";
			if (!prefer) {
				this.useOpenCodeDelegate = false;
				return;
			}
			const detect = await window.api.opencodeDetect();
			this.useOpenCodeDelegate = detect.installed === true;
		} catch {
			this.useOpenCodeDelegate = false;
		}
	}

	private buildOpenCodeDelegate():
		| ((
				step: WorkflowStep,
				instruction: string
		  ) => Promise<{
				ok: boolean;
				output?: string;
				error?: string;
				evidenceOk?: boolean;
				changedPaths?: string[];
		  }>)
		| undefined {
		if (!this.useOpenCodeDelegate || !this.openCodeAdapter || !this._projectPath) return undefined;
		return async (step, instruction) =>
			this.openCodeAdapter!.delegateWriteTask(this._projectPath!, instruction, step.targetPaths?.length ? step.targetPaths : step.targetPath ? [step.targetPath] : undefined);
	}

	private emitPlanValidationNotice(planText: string): void {
		const issuesText = PlanTracker.formatValidationIssues(planText);
		if (!issuesText) return;
		this.emitEvent({
			kind: EventKind.Notice,
			notice: {
				level: "info",
				text: `计划校验提示（可继续执行）：\n${issuesText}`
			}
		});
	}

	get running(): boolean {
		return this._running;
	}
	get projectPath(): string | null {
		return this._projectPath;
	}
	get phase(): "plan" | "execute" {
		return this._phase;
	}
	get isPlanReady(): boolean {
		return this.planReadyAwaitingExecute;
	}
	get lastTurnModeSnapshot(): typeof this.lastTurnMode {
		return this.lastTurnMode;
	}
	get composerModeSnapshot(): ComposerMode {
		return this.composerMode;
	}

	setComposerMode(mode: ComposerMode): void {
		this.composerMode = mode;
	}

	setSessionGoal(goal: string): void {
		this.sessionGoal = goal.trim();
	}

	getSessionGoal(): string {
		return this.sessionGoal;
	}

	setProjectPath(p: string | null): void {
		this._projectPath = p;
	}

	setApiConfig(config: { endpoint: string; apiKey: string; model: string }): void {
		this.apiConfig = config;
	}

	setRegistry(registry: Registry): void {
		this.registry = registry;
		this.agent.setRegistry(registry);
	}

	private emitEvent(event: Event): void {
		this.sink.emit(event);
	}

	private intentContext() {
		return {
			phase: this._phase,
			planTracker: this.planTracker,
			hasProject: Boolean(this._projectPath),
			composerMode: this.composerMode,
			hasPlanCandidate: Boolean(this.lastPlanCandidate)
		};
	}

	private rememberPlanCandidate(planText: string): void {
		if (planHasActionableSteps(planText) || isActionablePlanText(planText)) {
			this.lastPlanCandidate = planText;
		}
	}

	private adoptPlanCandidateIfNeeded(): boolean {
		if (this.planTracker) return true;
		if (!this.lastPlanCandidate || !this.isActionablePlan(this.lastPlanCandidate)) return false;
		this.planTracker = PlanTracker.fromPlanText(this.lastPlanCandidate);
		this.emitPlanState(this.planTracker);
		return true;
	}

	/** Skip execute when plan has no concrete steps.
	 *  Missing evidence is advisory only (see emitPlanValidationNotice); the compiler
	 *  fills defaults. Hard-blocking on evidence left sessions stuck at plan_failed. */
	private isActionablePlan(planText: string): boolean {
		if (!isActionablePlanText(planText)) return false;
		return !PlanTracker.validationIssuesFromText(planText).some((issue) => issue.field === "description" || issue.field === "kind" || issue.field === "targetPath");
	}

	private buildExecuteConfirmMessage(tracker: PlanTracker): string {
		const current = tracker.currentStep;
		if (!current) {
			return "计划已确认。全部步骤已完成，请输出总结。";
		}
		let content =
			`计划已确认。当前执行步骤 #${current.id}：${current.description}\n` +
			`串行工作流：执行当前步骤所需工具；主机会根据工具结果自动推进到下一步。` +
			`禁止重复已成功工具，禁止跳过步骤。\n` +
			tracker.toContextBlock();
		if (tracker.isOpsOnly()) {
			content += "\n本项目为构建/运行任务，无需 list_directory/read_file 探索。直接从当前步骤开始执行。";
		}
		// 语义增强：当前步骤涉及 GUI 代码时，追加 GUI 预览提醒
		if (stepRequiresGuiPreview(current.description, current.targetPath)) {
			content += "\n\n## 当前步骤 GUI 预览提醒\n" +
				"当前步骤涉及 GUI 代码修改，必须先调用 gui_layout_preview 生成布局预览供用户确认。\n" +
				"禁止跳过预览直接 edit_file/write_file GUI 文件（工具层会硬性拦截并返回引导）。\n" +
				"layoutType 选择：设置列表→option-list；自定义界面→custom-screen；HUD→hud-overlay。";
		}
		if (this.lastProjectInfo.trim()) {
			content += `\n\n${this.lastProjectInfo.trim()}`;
		}
		return content;
	}

	private retainCurrentUserAsNewTask(): void {
		const system = this.messages.find((message) => message.role === "system");
		this.taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
		// Keep recent user feedback + short assistant notes so follow-up bugfix
		// rounds do not start with only system+1 user (diag showed controllerMessages: 2).
		this.messages = buildCrossTurnDiagnosisRetain({
			system: system ? { role: "system", content: system.content || "", origin: "harness" } : undefined,
			messages: this.messages,
			taskId: this.taskId
		}) as ChatMessage[];
	}

	/** Synthetic one-shot plans must not lock later user turns when incomplete. */
	private releaseIncompleteSyntheticPlan(): void {
		if (this.planTracker?.synthetic && !this.planTracker.allDone()) {
			this.planTracker = null;
			this._phase = "plan";
			this.planReadyAwaitingExecute = false;
		}
	}

	private applyClassificationSideEffects(classified: ClassifyUserTurnResult, input: string): void {
		this.lastGuiFeatureSymptom = classified.isGuiFeatureSymptom;
		if (classified.isSymptomResolved) {
			this.activeUserSymptom = null;
			this.activeVerifyTarget = null;
			this.lastGuiFeatureSymptom = false;
			return;
		}
		if (classified.isUserSymptom || classified.isErrorReport) {
			this.activeUserSymptom = input.trim().slice(0, 400);
		}
		const fromClass = verifyTargetFromClassification(classified.verifyTarget);
		if (fromClass) {
			this.activeVerifyTarget = fromClass;
		} else if (classified.isGuiFeatureSymptom || classified.isInGameVerifyRequest) {
			if (!this.activeVerifyTarget) {
				this.activeVerifyTarget = defaultVerifyTarget();
			}
		}
	}

	private ensureVerifyTargetForGui(): void {
		if (!this.activeVerifyTarget) {
			this.activeVerifyTarget = defaultVerifyTarget();
		}
	}

	private maybeEmitSymptomConfirmNotice(): void {
		if (!this.activeUserSymptom || !this.planTracker?.allDone()) return;
		const targetHint = this.activeVerifyTarget ? `检测目标「${this.activeVerifyTarget.label}」是否已在游戏内确认？` : "";
		this.emitEvent({
			kind: EventKind.Notice,
			notice: {
				level: "warn",
				text:
					`游戏已启动/计划步骤已跑完，但用户症状仍待确认：「${this.activeUserSymptom.slice(0, 100)}」。` +
					(targetHint ? targetHint : "") +
					`若问题仍在，请直接描述现象（不要只发「继续」）。若已解决可回复「好了」。`
			}
		});
	}

	private emitPlanState(tracker: PlanTracker): void {
		this.emitEvent({
			kind: EventKind.PlanState,
			planSteps: tracker.snapshot()
		});
	}

	private emitPlanDonePhase(planStreamReasoning: string, planStreamText: string, planResult: string): string {
		const fullPlanText = selectPlanText(planStreamReasoning, planStreamText, planResult);
		const visiblePlanText = selectVisiblePlanText(planStreamText, planResult);
		const actionable = this.isActionablePlan(fullPlanText);
		this.rememberPlanCandidate(fullPlanText);
		logger.agent("Plan merged", {
			steps: parsePlanSteps(fullPlanText).length,
			visibleSteps: parsePlanSteps(visiblePlanText).length,
			actionable
		});
		this.emitEvent({
			kind: EventKind.Phase,
			phase: "plan_done",
			text: visiblePlanText,
			planActionable: actionable
		});
		this.emitEvent({ kind: EventKind.Phase, phase: "plan_stream_end" });
		this.emitPlanValidationNotice(fullPlanText);
		return fullPlanText;
	}

	private planFailureNotice(fullPlanText: string, retried = false): string {
		const prefix = retried ? "两次尝试均未能生成可执行计划。" : "未能生成可执行计划。";
		const empty = !fullPlanText.trim();
		if (empty) {
			const hasImages = this.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
			if (hasImages && !isVisionCapableModel(this.apiConfig.model)) {
				return `${prefix}模型本轮无输出。当前模型「${this.apiConfig.model}」不支持图片理解；` + "请切换到视觉模型（如 glm-5v-turbo）后再发送带图消息，或先移除图片。";
			}
			return `${prefix}模型本轮未返回任何内容。请重试，或换一个模型。`;
		}
		const detail = planHasActionableSteps(fullPlanText) ? "计划含编号步骤但缺少目标路径（如 src/main/java/...）。" : "未能解析出符合格式的编号步骤。";
		return (
			`${prefix}${detail}请直接发送计划，例如：\n` +
			"1. [inspect] 确认 API — fabric_docs_search\n" +
			"2. [write] src/main/java/com/example/my_mod/Handler.java — 功能实现\n" +
			"3. [write] src/main/java/com/example/my_mod/MyMod.java — 注册入口"
		);
	}

	private async buildProjectInfo(): Promise<string> {
		let projectInfo = "";
		if (!this._projectPath) return projectInfo;

		const projectPath = this._projectPath;
		const listDirectory = (absPath: string) => window.api.listDirectory(absPath);
		projectInfo = `## 项目信息\n项目路径：${projectPath}\n`;

		// GUI 文件标注器：匹配 *Screen.java / *Hud*.java / *Gui*.java 追加 [GUI]
		const guiTagger = (relPath: string): string => (isGuiFilePath(relPath) ? " [GUI]" : "");
		// 收集所有扫描到的相对路径，结束后注入 knownProjectPaths 供模糊建议
		const scannedRelPaths: string[] = [];

		// 1. Scan main Java packages + file inventory
		try {
			const mainJava = `${projectPath}/src/main/java`;
			const { packages, javaFiles } = await scanJavaSourceTree(mainJava, projectPath, listDirectory);
			if (packages.length > 0) {
				projectInfo += `源码包路径：${packages.join(", ")}\n`;
			}
			projectInfo += formatJavaFileList(javaFiles, "主源码 Java 文件", undefined, guiTagger);
			scannedRelPaths.push(...javaFiles);
		} catch {
			/* ignore scan errors */
		}

		// 2. Scan client Java packages + file inventory
		try {
			const clientJava = `${projectPath}/src/client/java`;
			const { packages, javaFiles } = await scanJavaSourceTree(clientJava, projectPath, listDirectory);
			if (packages.length > 0 || javaFiles.length > 0) {
				projectInfo += `客户端源码目录：src/client/java\n`;
				if (packages.length > 0) {
					projectInfo += `客户端包路径：${packages.join(", ")}\n`;
				}
				projectInfo += formatJavaFileList(javaFiles, "客户端 Java 文件", undefined, guiTagger);
				scannedRelPaths.push(...javaFiles);
			}
		} catch {
			/* ignore */
		}

		// 3. Gradle properties summary
		try {
			const gradleProps = await window.api.readFile(`${projectPath}/gradle.properties`);
			if (gradleProps.success && gradleProps.content) {
				projectInfo += formatGradleSummary(parseGradleProperties(gradleProps.content));
			}
		} catch {
			/* ignore */
		}

		// 4. Read fabric.mod.json (mod id, entrypoints, mixin ref)
		let parsedModId: string | null = null;
		try {
			const modJsonPath = `${projectPath}/src/main/resources/fabric.mod.json`;
			const modJson = await window.api.readFile(modJsonPath);
			if (modJson.success && modJson.content) {
				const parsed = JSON.parse(modJson.content);
				const modId = parsed.id || "";
				if (modId) {
					parsedModId = modId;
					projectInfo += `Mod ID：${modId}\n`;
					// modid 歧义警示：明确 assets 路径必须用 modid
					if (modId.includes("_") || modId.includes("-")) {
						const sep = modId.includes("_") ? "下划线" : "连字符";
						projectInfo += `注意：modid 使用${sep}（${modId}），assets 路径必须为 assets/${modId}/（禁止用 ${modId.replace(/_/g, "-")} 或 ${modId.replace(/-/g, "_")}）\n`;
					}
					if (parsed.entrypoints?.main?.length) {
						projectInfo += `入口点：${parsed.entrypoints.main.join(", ")}\n`;
					}
					if (parsed.entrypoints?.client?.length) {
						projectInfo += `客户端入口：${parsed.entrypoints.client.join(", ")}\n`;
					}
					if (parsed.mixins?.length) {
						projectInfo += `Mixin 配置：${parsed.mixins.join(", ")}\n`;
					}
				}
			}
		} catch {
			/* file may not exist */
		}

		// 5. List resources directory (assets, data, actual mixin config filename)
		try {
			const resourcesDir = `${projectPath}/src/main/resources`;
			const resEntries = await window.api.listDirectory(resourcesDir);
			const topItems = resEntries.map((e) => e.name).join(", ");
			if (topItems) {
				projectInfo += `资源目录：${topItems}\n`;
			}
			scannedRelPaths.push(...resEntries.map((e) => `src/main/resources/${e.name}`));
		} catch {
			/* ignore */
		}

		// 6. Read mixin configs for existing entries
		try {
			const resourcesDir = `${projectPath}/src/main/resources`;
			const resEntries = await window.api.listDirectory(resourcesDir);
			for (const e of resEntries) {
				if (e.name.endsWith(".mixins.json")) {
					try {
						const mixinPath = `${projectPath}/src/main/resources/${e.name}`;
						const mixinFile = await window.api.readFile(mixinPath);
						if (!mixinFile.success || !mixinFile.content) continue;
						const parsed = JSON.parse(mixinFile.content);
						const pkg = parsed.package || "";
						const mixins = parsed.mixins || [];
						const client = parsed.client || [];
						const allMixins = [...new Set([...mixins, ...client])];
						if (allMixins.length > 0) {
							projectInfo += `已注册 Mixin（${e.name}，包 ${pkg || "无"}）：${allMixins.join(", ")}\n`;
						}
					} catch {
						/* skip malformed */
					}
				}
			}
		} catch {
			/* ignore */
		}

		// 7. List resource subdirectories (assets/<modid>/...)
		try {
			const assetsDir = `${projectPath}/src/main/resources/assets`;
			const assets = await window.api.listDirectory(assetsDir);
			if (assets.length > 0) {
				projectInfo += `资源命名空间：${assets.map((e) => e.name).join(", ")}\n`;
				// 注册命名空间到已知路径
				for (const a of assets) scannedRelPaths.push(`src/main/resources/assets/${a.name}`);
				// 若 modid 已知，列出 assets/<modid>/lang 下的语言文件
				if (parsedModId) {
					try {
						const langDir = `${projectPath}/src/main/resources/assets/${parsedModId}/lang`;
						const langEntries = await window.api.listDirectory(langDir);
						const langFiles = langEntries.map((e) => e.name).filter((n) => n.endsWith(".json"));
						if (langFiles.length > 0) {
							projectInfo += `语言文件：assets/${parsedModId}/lang/${langFiles.join(", ")}\n`;
							for (const lf of langFiles) {
								scannedRelPaths.push(`src/main/resources/assets/${parsedModId}/lang/${lf}`);
							}
						}
					} catch {
						/* lang dir may not exist */
					}
				}
			}
		} catch {
			/* ignore */
		}

		// 将扫描到的路径注入 knownProjectPaths，供 tool-definitions 的模糊建议使用
		try {
			registerKnownProjectPaths(scannedRelPaths);
		} catch {
			/* registerKnownProjectPaths 不应抛错，但保守处理 */
		}

		return projectInfo;
	}

	// Build system prompt with tool descriptions and Fabric knowledge
	private async buildSystemPrompt(mode: "chat" | "plan" | "execute"): Promise<string> {
		const toolNameMap: Record<string, string> = { ...TOOL_LABELS_ZH };
		const toolDescs = this.registry
			.names()
			.filter((name) => {
				if (name === "complete_step") return false;
				const tool = this.registry.get(name);
				return mode !== "plan" || Boolean(tool?.readOnly());
			})
			.map((name) => {
				const t = this.registry.get(name);
				const cn = toolNameMap[name] || name;
				const kind = t?.readOnly() ? "（只读）" : "（写入）";
				return t ? `- **${cn}** (\`${t.name}\`): ${t.description} ${kind}` : "";
			})
			.join("\n");

		const fabricPolicy = buildFabricAgentPolicyPrompt(mode);
		const goalBlock = [buildSessionGoalBlock(this.sessionGoal), buildUserSymptomBlock(this.activeUserSymptom), formatVerifyTargetBlock(this.activeVerifyTarget)].filter(Boolean).join("\n\n");
		// projectInfo 注入到 system prompt，确保 execute 阶段每轮都能看到项目结构，避免重复 list_directory/read_file 探索。
		// 同 mode 下 updateSystemPrompt 不重建 system prompt（cache 友好）；mode 切换时才重新扫描。
		const projectInfo = await this.buildProjectInfo();
		this.lastProjectInfo = projectInfo;

		if (mode === "chat") {
			return `# ModCrafting AI 助手

## 对话模式

你是 Minecraft Fabric 模组开发助手。用户正在向你提问或寻求解释。

规则：
- **直接使用中文回答**，简洁清晰，不要写长篇分析。
- **禁止方案推演。** 如果用户问"怎么做"，直接给出最佳实践方案，不比较多个方案。
- **不要输出编号实施计划**（除非用户明确要求开发）。
- 代码解释场景：可调用 \`read_file\`、\`explain_code\`、\`fabric_docs_search\` 获取上下文后作答；**禁止** write_file、构建、运行等写入/执行工具。
- 非解释场景：**不要调用任何工具**。
- 可以提供 Java/JSON 代码示例（markdown 代码块）。
- 如果用户后续明确要求开发功能，再进入实施流程。

${goalBlock}

${fabricPolicy}

${projectInfo}`;
		}

		const phaseHeader =
			mode === "plan"
				? `## 第一阶段：制定计划

输出风格硬约束：
- 禁止方案对比推演。选定技术路线后不再回头讨论替代方案。
- 不要解释概念或写分析段落。

**重要：仅当用户需求本身有歧义（产品取舍）时使用 ask_clarification；包名/类名/文件结构先用工具勘察，禁止用澄清代替读文件。**
工具调用格式：\`<tool_call>{"name": "ask_clarification", "args": {"question": "短问题", "options": ["选项A", "选项B"]}}<\/tool_call>\`
收集完所有信息后，调用 submit_plan 提交结构化实施计划。若模型不支持原生工具调用，可使用 XML fallback。

submit_plan 参数要求：
- 参数为 \`{"steps":[...]}\`，每个步骤包含 \`kind\`、\`description\`、\`evidence\`，并提供 \`targetPath\` 或 \`targetPaths\`。
- **kind** 仅允许：\`write\` | \`recipe\` | \`mixin\` | \`inspect\`。
- 示例：\`{"steps":[{"kind":"mixin","description":"实现、注册并验证二段跳 Mixin","targetPath":"src/main/java/.../JumpMixin.java","evidence":"fabric_mixin_validate 通过"}]}\`

计划必须精简：
- **禁止写构建/运行/测试步骤**。主机会自动在计划末尾追加：① 构建项目（gradlew build）② 启动游戏（runClient）③ 进入测试世界（mc_ensure_test_world + mc_ensure_cheats）④ 验证功能效果（mc_screenshot/mc_inspect）。Agent 只需写代码实现步骤（write/mixin/recipe/inspect）。
- **禁止空泛步骤**（确保无错、测试功能、输出总结）。
- **每步只做一件事**；最多 6 步。
- **禁止重复步骤。**
- **不确定路径/类名时先 grep/read_file，禁止用 ask_clarification 代替勘察，禁止方案对比长文。**
- **用户已通过模板表单提交完整需求时，禁止先探索项目；直接输出计划。**
- **用户消息含【结构化参数 JSON】时，执行阶段须调用 \`fabric_template_generate\` 并传入完整 \`formFields\`（勿省略硬度、饱食度等表单参数）。**`
				: `## 第二阶段：执行计划

规则（优先级从高到低）：
1. 只执行当前步骤。不确定路径/类名/包名时先 read_file/grep；仅用户偏好才 ask_clarification，禁止猜需求。
2. 每轮必须调用工具。旁白不超过 2 句，只告知"当前在做什么"。禁止 Wait/Hmm 式反复自我否定与超长推理；想清后立即调工具。
3. 写完当前步骤所需全部文件后，调用 complete_step 标记完成，再进入下一步。
4. 全部文件写完后 trigger_build build → 成功则 trigger_build runClient → mc_ensure_test_world 进入世界 → mc_test_scenario(feature_type=...) 获取测试步骤模板 → 按步骤执行测试场景 → mc_screenshot/mc_inspect/mc_world/mc_observe_entity 客观验证效果。
5. Mixin 必须依次使用 fabric_mixin_target_lookup → fabric_mixin_scaffold/edit_file → fabric_mixin_register → fabric_mixin_validate；配方必须用 create_recipe/fabric_recipe_generate 并取得校验证据；模板用 fabric_template_generate（必须传入 formFields）。
6. **GUI 布局预览强制要求：任何涉及 Screen/HUD/ConfigScreen 代码的步骤（无论是新建还是修改现有 GUI），必须先调用 gui_layout_preview 工具生成 HTML 布局预览供用户确认，拿到用户确认的布局 JSON 后才能编写/修改 GUI 代码。禁止跳过预览直接 edit_file/write_file GUI 代码。layoutType 选择：设置列表→option-list；自定义界面→custom-screen；HUD→hud-overlay。生成的 HTML 仅用于可视化布局，禁止包含 <button>、<input type="button">、onclick 事件或任何确认/取消按钮；确认/取消由外层 UI 统一提供。**
7. 禁止重复写同一文件、禁止用相同参数重复调用只读工具。
8. MC_PHASE:menu 只代表游戏启动成功，不代表功能测试通过。功能在游戏内的（HUD/方块/物品/实体/命令）必须：① mc_ensure_test_world 进入世界 ② mc_ensure_cheats 确保作弊权限 ③ mc_test_scenario(feature_type=...) 获取测试步骤模板 ④ 按步骤执行测试场景（生成生物/给予物品/触发事件） ⑤ mc_screenshot/mc_inspect/mc_world/mc_observe_entity 客观验证效果。禁止仅凭 menu 宣称完成。禁止仅凭"已进入世界"宣称完成。禁止跳过 mc_test_scenario 直接 complete_step。feature_type 取值：new_item/new_block/new_recipe/entity_behavior/player_interaction/hud_gui。实体行为修改类功能必须用 mc_observe_entity 对比状态变化（爆炸倒计时/AI 目标/移动速度），禁止仅凭截图宣称完成。mc_ensure_test_world 失败后必须用 mc_inspect 检视界面再 mc_input 手动操作，禁止跳过世界进入步骤。任务总结必须列出实际执行的验证工具调用和结果，禁止虚构验证结果。
9. ${isVisionCapableModel(this.apiConfig.model)
		? "验证策略：当前模型支持图片理解。功能测试时调用 mc_screenshot 截图，模型会直接分析截图验证功能效果。"
		: "验证策略：当前模型不支持图片理解。功能测试验证策略：① 优先使用 mc_inspect 获取结构化数据（界面类型、控件列表、玩家状态）进行数据化验证；② 仍需调用 mc_screenshot 截图（供总结展示和用户参考），但不要尝试从截图本身分析；③ 若 mc_inspect 无法验证的功能（如颜色/动画/渲染效果），在输出中明确标注\"需用户手动确认\"；④ 禁止声称\"测试通过\"而无客观证据（mc_inspect 数据或用户确认）。"}`;

		const extraRules = mode === "execute" ? "" : "\n- **仅需求歧义时可用 ask_clarification（短问题+短选项）；代码事实先勘察。**\n- **最多 3 句背景说明，然后直接列出步骤。** 禁止方案推演。";

		return `# ModCrafting AI 助手
${phaseHeader}

你是 Minecraft Fabric 模组开发助手。用中文回答。Java/JSON 代码保持英文。

## 可用工具
${toolDescs}

${mode === "plan" ? "## 当前：输出计划阶段\n需求歧义时可用 ask_clarification（短选项）；标识符用 grep/read_file 勘察，收集完后调用 submit_plan。" : "## 当前：执行阶段\n直接调用工具执行计划。修改已有文件优先 edit_file（先 read_file）；新建用 write_file。涉及 GUI/Screen/HUD 代码时必须先调用 gui_layout_preview 预览。最后 trigger_build 构建并启动游戏测试。工程冲突默认选更干净一致的方案，不要把实现细节丢给用户选。"}

## 重要规则
- **写代码前用 fabric_docs_search 查 Fabric API：搜索具体类名/方法名（如 "FabricItemSettings equipmentSlot"），返回 Javadoc + 方法签名。不要凭记忆写 API 调用。**
- **写 Fabric 方块/物品/实体/附魔注册代码前，必须先用 minecraft_data_lookup 查询原版标准 ID 与属性参数（硬度、爆炸抗性、堆叠、工具、耐久、生命值、附魔等级等），禁止凭记忆填写原版参数。**
- **用户输入模糊或不专业的游戏描述时（如"会爆炸的绿色怪物"），先用 mc_wiki_search 检索中文 MC 百科向量知识库解析需求，再结合 minecraft_data_lookup 生成 Fabric 代码。**
- **GUI 代码强制预览：编写或修改任何 Screen/HUD/ConfigScreen 代码前，必须先调用 gui_layout_preview 工具生成布局预览供用户确认。禁止跳过预览直接 edit_file/write_file GUI 代码。生成的 HTML 仅用于可视化布局，禁止包含 <button>、<input type="button">、onclick 事件或任何确认/取消按钮；确认/取消由外层 UI 统一提供。**
- 使用 Yarn mappings。主类→ModInitializer，客户端→ClientModInitializer。${extraRules}

${goalBlock}

${fabricPolicy}

${projectInfo}`;
	}

	private async updateSystemPrompt(mode: "chat" | "plan" | "execute"): Promise<void> {
		const sysIdx = this.messages.findIndex((m) => m.role === "system" && m.origin === "harness");
		if (this.lastSystemMode === mode && sysIdx >= 0) {
			// Same mode: keep messages[sysIdx] stable for prompt cache.
			// 但 execute 阶段需要每轮刷新项目结构信息（文件可能已被创建/修改/删除）。
			// 通过独立的 project-info system 消息注入最新结构，不修改 cache 友好的 messages[sysIdx]。
			if (mode === "execute") {
				const freshInfo = await this.buildProjectInfo();
				// 语义增强：当前步骤涉及 GUI 代码时，在项目信息后追加 GUI 预览提醒
				const cur = this.planTracker?.currentStep;
				if (cur && stepRequiresGuiPreview(cur.description, cur.targetPath)) {
					this.lastProjectInfo = freshInfo + "\n## 当前步骤 GUI 预览提醒\n" +
						"当前步骤涉及 GUI 代码修改，必须先调用 gui_layout_preview 生成布局预览。\n" +
						"禁止跳过预览直接 edit_file/write_file GUI 文件（工具层会硬性拦截）。\n" +
						"layoutType 选择：设置列表→option-list；自定义界面→custom-screen；HUD→hud-overlay。";
				} else {
					this.lastProjectInfo = freshInfo;
				}
				this.refreshProjectInfoMessage(this.lastProjectInfo);
			}
			return;
		}
		const prompt = await this.buildSystemPrompt(mode);
		if (sysIdx >= 0) {
			this.messages[sysIdx] = { role: "system", content: prompt, origin: "harness" };
		} else {
			this.messages.unshift({ role: "system", content: prompt, origin: "harness" });
		}
		// mode 切换时清除旧的 project-info 消息（新 system prompt 已内含项目信息）
		this.removeProjectInfoMessage();
		this.lastSystemMode = mode;
	}

	/** 更新或追加独立的 project-info system 消息（保持 messages[0] cache 友好）。 */
	private refreshProjectInfoMessage(info: string): void {
		if (!info) return;
		const content = `## 项目结构（实时刷新）\n${info}`;
		// 查找已有的 project-info 消息
		const infoIdx = this.messages.findIndex(
			(m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("## 项目结构（实时刷新）")
		);
		if (infoIdx >= 0) {
			this.messages[infoIdx] = { role: "system", content, origin: "harness" };
		} else {
			// 追加在 harness system 消息之后
			const harnessIdx = this.messages.findIndex((m) => m.role === "system" && m.origin === "harness");
			if (harnessIdx >= 0) {
				this.messages.splice(harnessIdx + 1, 0, { role: "system", content, origin: "harness" });
			}
		}
	}

	/** 移除独立的 project-info system 消息（mode 切换时调用）。 */
	private removeProjectInfoMessage(): void {
		this.messages = this.messages.filter(
			(m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith("## 项目结构（实时刷新）"))
		);
	}

	private trimTrailingAssistants(): void {
		while (this.messages.length > 0) {
			const last = this.messages[this.messages.length - 1];
			if (last.role === "assistant") {
				this.messages.pop();
				continue;
			}
			break;
		}
		// Also remove stale injected system messages (instructions, error notices)
		// that were added by appendToolRoundHistory or error handlers.
		// Keep only the base system prompt at position 0.
		this.messages = this.messages.filter((m, i) => {
			if (m.role !== "system") return true;
			if (i === 0) return true; // base prompt
			const content = contentAsText(m.content);
			// Injected system messages use these markers
			if (/^\[SYSTEM:/.test(content)) return false;
			if (/^【系统/.test(content)) return false;
			if (/^【注意】/.test(content)) return false;
			if (/^【系统警告】/.test(content)) return false;
			return true;
		});
	}

	private async runChatTurn(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
		await this.updateSystemPrompt("chat");
		const result = await this.agent.run(this.apiConfig.endpoint, this.apiConfig.apiKey, this.apiConfig.model, this.messages, this._projectPath, this.abortController!.signal, streamCb, {
			phase: "plan",
			emitLifecycle: true,
			turnMode: "chat",
			composerMode: this.composerMode
		});
		return result;
	}

	private async runExecutePhase(streamCb: (text: string, reasoning?: string) => void, options?: { forceFeatureGuiVerify?: boolean }): Promise<string> {
		await this.refreshOpenCodeSettings();
		await this.updateSystemPrompt("execute");
		this._phase = "execute";
		this.planReadyAwaitingExecute = false;
		if (this.planTracker && this.planTracker.steps.length > 0) {
			this.planTracker.markRunning();
			this.emitPlanState(this.planTracker);
		}
		this.emitEvent({ kind: EventKind.Phase, phase: "execute_start" });
		this.onAgentStatus?.("执行中...");

		const requireFeatureGuiVerify = Boolean(options?.forceFeatureGuiVerify) || (Boolean(this.activeUserSymptom) && this.lastGuiFeatureSymptom);
		if (options?.forceFeatureGuiVerify) {
			this.ensureVerifyTargetForGui();
		}

		const result = await this.agent.run(this.apiConfig.endpoint, this.apiConfig.apiKey, this.apiConfig.model, this.messages, this._projectPath, this.abortController!.signal, streamCb, {
			phase: "execute",
			emitLifecycle: true,
			planTracker: this.planTracker,
			opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false,
			requireInGameVerify: Boolean(this.activeUserSymptom) || Boolean(options?.forceFeatureGuiVerify),
			requireFeatureGuiVerify,
			verifyTarget: this.activeVerifyTarget,
			openCodeDelegate: this.buildOpenCodeDelegate()
		});
		this.maybeEmitSymptomConfirmNotice();
		// 任务完成且收集到截图时，发送任务总结截图事件
		this.emitTaskSummaryScreenshots();
		return result;
	}

	/** 任务完成后发送截图展示事件（复用 ToolResult 事件结构，UI 层渲染为可点击缩略图） */
	private emitTaskSummaryScreenshots(): void {
		const screenshots = this.agent.lastCollectedScreenshots;
		if (!screenshots || screenshots.length === 0) return;
		// 仅在计划全部完成时发送总结截图
		if (!this.planTracker?.allDone()) return;
		this.emitEvent({
			kind: EventKind.Notice,
			notice: {
				level: "info",
				text: `## 任务完成 — 测试截图\n以下为本次任务测试过程中的 ${screenshots.length} 张截图，点击可放大预览。`
			}
		});
		for (const shot of screenshots) {
			this.emitEvent({
				kind: EventKind.ToolResult,
				tool: {
					id: `summary-${shot.toolId}-${shot.timestamp}`,
					name: "task_summary_screenshot",
					args: "",
					output: "任务完成截图",
					imageBase64: shot.base64,
					imageMimeType: shot.mimeType
				}
			});
		}
	}

	private async beginExecuteFromTracker(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
		this.adoptPlanCandidateIfNeeded();
		if (!this.planTracker || this.planTracker.steps.length === 0) {
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "warn", text: "没有可执行的计划" } });
			this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_ready" });
			return "";
		}
		// Explicit execute/resume may retry failed steps; do not leave them stuck as error.
		for (const step of this.planTracker.steps) {
			if (step.status === "error") step.status = "pending";
		}
		// 自动追加测试步骤：确保计划末尾有"进入世界 + 触发场景 + 验证功能效果"。
		// 系统提示词声称"主机会自动追加 gradlew build 与 runClient"，这里真正实现追加逻辑。
		const appended = this.ensureTestVerificationSteps();
		if (appended > 0) {
			this.emitPlanState(this.planTracker);
			this.emitEvent({
				kind: EventKind.Notice,
				notice: {
					level: "info",
					text: `已自动追加 ${appended} 个测试步骤（进入世界 / 触发场景 / 验证功能效果）。Agent 必须执行完所有步骤才能结束会话。`
				}
			});
		}
		this.lastPlanCandidate = null;
		const symptomBlock = buildUserSymptomBlock(this.activeUserSymptom);
		this.messages.push({
			role: "user",
			content: [this.buildExecuteConfirmMessage(this.planTracker), symptomBlock].filter(Boolean).join("\n\n"),
			origin: "harness",
			taskId: this.taskId,
			phase: "execute"
		});
		return this.runExecutePhase(streamCb);
	}

	/**
	 * 自动追加测试步骤到 planTracker。
	 * - 如果计划没有 build/run 步骤，追加"构建 + 启动游戏"
	 * - 如果有 build 但没 run，追加"启动游戏"
	 * - 追加"进入测试世界 + 触发功能场景"步骤（如果没有）
	 * - 追加"验证功能效果"步骤（如果没有）
	 * @returns 追加的步骤数量
	 */
	private ensureTestVerificationSteps(): number {
		if (!this.planTracker) return 0;
		const steps = this.planTracker.steps;
		if (steps.length === 0) return 0;

		const hasBuild = steps.some((s) => /gradlew|trigger_build.*build|构建项目|编译/i.test(s.description));
		const hasRun = steps.some((s) => /runclient|启动游戏|运行游戏/i.test(s.description));
		const hasEnterWorld = steps.some((s) => /mc_ensure_test_world|进入世界|进入测试世界/i.test(s.description));
		const hasVerify = steps.some((s) => /mc_screenshot|mc_inspect|验证功能|验证效果/i.test(s.description));

		let appended = 0;
		const pushStep = (description: string) => {
			steps.push({
				id: String(steps.length + 1),
				description,
				status: "pending"
			});
			appended++;
		};

		// 追加构建/运行步骤（如果缺失）
		if (!hasBuild && !hasRun) {
			pushStep("构建项目（gradlew build / trigger_build build）");
			pushStep("启动游戏进行真实测试（runClient）");
		} else if (hasBuild && !hasRun) {
			pushStep("启动游戏进行真实测试（runClient）");
		}

		// 追加"进入测试世界 + 触发功能场景"步骤
		if (!hasEnterWorld) {
			pushStep(
				"进入测试世界并执行功能场景（mc_ensure_test_world 进入世界 → mc_ensure_cheats 确保作弊权限 → mc_command/mc_input 触发待测功能）"
			);
		}

		// 追加"验证功能效果"步骤
		if (!hasVerify) {
			pushStep("验证功能效果（mc_screenshot/mc_inspect 客观校验，禁止仅凭 MC_PHASE:menu 宣称完成）");
		}

		return appended;
	}

	/** After plan allDone: verify in-game without clearing tracker into a new submit_plan cycle. */
	private async beginInGameVerifyExecute(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
		this.emitEvent({
			kind: EventKind.Notice,
			notice: {
				level: "info",
				text: "进入游戏内校验：跳过计划阶段，直接 runClient + 打开待测功能 + mc_inspect/mc_screenshot。"
			}
		});
		const recovered = this.recoverActiveSymptomFromHistory();
		if (!this.activeUserSymptom || this.activeUserSymptom === "用户请求游戏内测试/验证") {
			this.activeUserSymptom = recovered || "用户请求游戏内测试/验证";
		}
		this.ensureVerifyTargetForGui();
		// Drop any stale plan/candidate so we never fall back into submit_plan.
		this.lastPlanCandidate = null;
		this.planReadyAwaitingExecute = false;
		await this.updateSystemPrompt("execute");
		this._phase = "execute";
		const opsPlan = "1. 启动游戏并进入测试世界（runClient + mc_ensure_test_world）\n2. 执行功能测试场景（mc_ensure_cheats + mc_command/mc_input 触发功能）\n3. 验证功能效果（mc_screenshot/mc_inspect 客观校验）";
		// Prefer fromSteps: compilePlanFromText historically stripped pure host terminals to [].
		this.planTracker = PlanTracker.fromSteps([
			{ id: "1", description: "启动游戏并进入测试世界（runClient + mc_ensure_test_world）", status: "pending" },
			{ id: "2", description: "执行功能测试场景（mc_ensure_cheats + mc_command/mc_input 触发功能）", status: "pending" },
			{ id: "3", description: "验证功能效果（mc_screenshot/mc_inspect 客观校验）", status: "pending" }
		]).markSynthetic();
		this.emitPlanState(this.planTracker);
		this.emitEvent({ kind: EventKind.Phase, phase: "plan_done", text: opsPlan, planActionable: true });
		if (this.activeVerifyTarget) {
			this.emitEvent({
				kind: EventKind.Notice,
				notice: {
					level: "info",
					text: `检测目标：${this.activeVerifyTarget.label}`
				}
			});
		}
		const hotkey = this.activeVerifyTarget?.hotkey || (this.activeUserSymptom.match(/\bF(\d{1,2})\b/i) || [])[0]?.toLowerCase() || "f6";
		const symptomBlock = buildUserSymptomBlock(this.activeUserSymptom);
		const targetBlock = formatVerifyTargetBlock(this.activeVerifyTarget);
		this.messages.push({
			role: "user",
			content: [
				"用户要求游戏内测试。禁止 submit_plan / 重新规划。",
				"当前为执行阶段：若游戏未运行则 trigger_build task=runClient，然后 mc_ensure_test_world 进入世界。",
				targetBlock || `进入世界后按 ${hotkey.toUpperCase()} 打开待测界面，用 mc_inspect 确认已进入目标屏后再截图。`,
				symptomBlock
			]
				.filter(Boolean)
				.join("\n\n"),
			origin: "harness",
			taskId: this.taskId,
			phase: "execute"
		});
		const result = await this.runExecutePhase(streamCb, { forceFeatureGuiVerify: true });
		this.releaseIncompleteSyntheticPlan();
		return result;
	}

	/** Prefer a real prior bug report over the generic「游戏测试」placeholder. */
	private recoverActiveSymptomFromHistory(): string | null {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (m.role !== "user" || m.origin === "harness") continue;
			const c = contentAsText(m.content).trim();
			if (!c || c === "用户请求游戏内测试/验证") continue;
			if (isNarrowResumeInput(c)) continue;
			// Structural crash/build dumps are always useful sticky symptoms.
			if (isStructuralErrorReport(c)) return c.slice(0, 400);
			// Prefer substantive prior user text over short verify/resume commands.
			if (c.length >= 12 && c.length <= 800) return c.slice(0, 400);
		}
		return null;
	}

	/** Short symptom fixes: synthetic mini-plan, skip formal submit_plan. */
	private async beginSymptomFastExecute(streamCb: (text: string, reasoning?: string) => void, input: string): Promise<string> {
		if (!this.activeUserSymptom) {
			this.activeUserSymptom = input.trim().slice(0, 400);
		}
		if (this.lastGuiFeatureSymptom) {
			this.ensureVerifyTargetForGui();
		}
		await this.updateSystemPrompt("execute");
		this._phase = "execute";
		this.planReadyAwaitingExecute = false;
		this.lastPlanCandidate = null;
		const opsPlan = "1. [write] 针对用户症状定位并修复相关源码\n" + "2. 构建项目（gradlew build）\n" + "3. 启动游戏并进入测试世界（runClient + mc_ensure_test_world）\n" + "4. 执行功能测试场景（mc_ensure_cheats + mc_command/mc_input）\n" + "5. 验证功能效果（mc_screenshot/mc_inspect 客观校验）";
		this.planTracker = PlanTracker.fromPlanText(opsPlan).markSynthetic();
		this.emitPlanState(this.planTracker);
		this.emitEvent({ kind: EventKind.Phase, phase: "plan_done", text: opsPlan, planActionable: true });
		const symptomBlock = buildUserSymptomBlock(this.activeUserSymptom);
		this.messages.push({
			role: "user",
			content: ["短修复：已跳过正式 submit_plan。按上方合成步骤直接改码、构建、runClient。", "menu 后必须 mc_ensure_test_world 进入世界，再 mc_inspect / mc_screenshot 验证症状。", symptomBlock].filter(Boolean).join("\n\n"),
			origin: "harness",
			taskId: this.taskId,
			phase: "execute"
		});
		const result = await this.runExecutePhase(streamCb);
		this.releaseIncompleteSyntheticPlan();
		return result;
	}

	private async runTurn(input: string | ChatContentPart[], options: { pushUser: boolean }): Promise<string> {
		if (this._running) return "";

		this._running = true;
		this.abortController = new AbortController();
		this.agent.resetRunState();

		const inputText = contentPartsAsClassifyText(input);

		this.onAgentStatus?.("意图分类...");
		const classified = await classifyUserTurn({
			apiConfig: this.apiConfig,
			input: inputText,
			ctx: this.intentContext(),
			stickySymptom: this.activeUserSymptom,
			abortSignal: this.abortController.signal
		});
		this.applyClassificationSideEffects(classified, inputText);

		const intent = classified.intent;
		this.lastTurnMode = intent === "plan_only" ? "plan_only" : intent;

		if (options.pushUser) {
			this.messages.push({ role: "user", content: input, origin: "user", taskId: this.taskId });
		}
		this.onAgentStatus?.("思考中...");

		let planStreamReasoning = "";
		let planStreamText = "";
		const streamCb = (text: string, reasoning?: string) => {
			if (text) planStreamText = text;
			if (reasoning) planStreamReasoning = reasoning;
			this.onStreamUpdate?.(text, reasoning);
		};

		try {
			if (classified.usedFallback) {
				this.emitEvent({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: `意图分类失败，已用兜底：${classified.rationale}`
					}
				});
			}

			// Guard: crash/error dumps must not steal into chat while execute is still active —
			// that would overwrite messages[0] with "对话模式 / 不要调用任何工具".
			let effectiveIntent = intent;
			if (intent === "chat" && this._phase === "execute" && this.planTracker && !this.planTracker.allDone() && (classified.isErrorReport || isStructuralErrorReport(inputText))) {
				effectiveIntent = "resume";
				this.lastTurnMode = "resume";
			}

			// In-game verify: do not depend on planTracker (often null after allDone).
			// Must run before chat — otherwise a misclassified chat turn locks tools out.
			if (this.composerMode === "agent" && Boolean(this._projectPath) && classified.isInGameVerifyRequest) {
				const result = await this.beginInGameVerifyExecute(streamCb);
				this.onAgentStatus?.("");
				return result;
			}

			if (effectiveIntent === "resume") {
				// 「继续」仅在计划待用户确认执行时恢复；否则按上下文重新规划，避免沿用上一轮旧进度。
				if (this.planReadyAwaitingExecute && this.planTracker && !this.planTracker.allDone()) {
					const result = await this.beginExecuteFromTracker(streamCb);
					this.onAgentStatus?.("");
					return result;
				}
				this.retainCurrentUserAsNewTask();
				this.planTracker = null;
				this.lastPlanCandidate = null;
				this._phase = "plan";
				this.planReadyAwaitingExecute = false;
				this.emitEvent({
					kind: EventKind.Notice,
					notice: {
						level: "info",
						text: "将根据当前上下文重新制定实施计划（不再沿用上一轮任务进度）。"
					}
				});
				effectiveIntent = "develop";
				this.lastTurnMode = "develop";
			}

			if (effectiveIntent === "chat") {
				const result = await this.runChatTurn(streamCb);
				this.onAgentStatus?.("");
				return result;
			}

			// 短症状/修复：agent 模式跳过正式 submit_plan。
			if (effectiveIntent === "develop" && this.composerMode === "agent" && (!this.planTracker || this.planTracker.allDone()) && classified.skipFormalPlan) {
				if (this.planTracker?.allDone()) {
					this.retainCurrentUserAsNewTask();
					this.planTracker = null;
				}
				this.emitEvent({
					kind: EventKind.Notice,
					notice: {
						level: "info",
						text: "短修复任务：跳过正式计划，直接进入执行与游戏内校验。"
					}
				});
				const result = await this.beginSymptomFastExecute(streamCb, inputText);
				this.onAgentStatus?.("");
				return result;
			}

			if (intent === "develop" && isQuickCreateGeneratedMessage(inputText)) {
				this.emitEvent({
					kind: EventKind.Notice,
					notice: { level: "info", text: "快捷创建：模板已生成，跳过规划直接构建并运行。" }
				});
				await this.updateSystemPrompt("execute");
				this._phase = "execute";
				this.planReadyAwaitingExecute = false;
				const opsPlan = "1. 构建项目（gradlew build）\n2. 启动游戏并进入测试世界（runClient + mc_ensure_test_world）\n3. 执行功能测试场景（mc_ensure_cheats + mc_command/mc_input）\n4. 验证功能效果（mc_screenshot/mc_inspect 客观校验）";
				this.planTracker = PlanTracker.fromPlanText(opsPlan).markSynthetic();
				this.emitPlanState(this.planTracker);
				this.emitEvent({ kind: EventKind.Phase, phase: "plan_done", text: opsPlan, planActionable: true });
				const result = await this.beginExecuteFromTracker(streamCb);
				this.releaseIncompleteSyntheticPlan();
				this.onAgentStatus?.("");
				return result;
			}

			if (effectiveIntent === "develop" && this._phase === "execute" && this.planTracker && !this.planTracker.allDone()) {
				// Only explicit replacement language starts a new task. Length-based guessing
				// previously discarded active plans for ordinary corrections and details.
				const isNewRequest = /^\s*(我不要这个|不要这个|换个需求|换一个需求|新任务|另外(?:做|加|创建)|重新做|放弃当前|算了|stop\b|new\b)/i.test(inputText);
				// Stale synthetic / failed plans must not auto-resume and lock the session.
				const stalePlan = this.planTracker.synthetic || this.planTracker.hasErrorStep();
				if (isNewRequest || stalePlan) {
					this.retainCurrentUserAsNewTask();
					this.planTracker = null;
					this.lastPlanCandidate = null;
					this._phase = "plan";
					this.planReadyAwaitingExecute = false;
					this.emitEvent({
						kind: EventKind.Notice,
						notice: {
							level: "info",
							text: stalePlan && !isNewRequest ? "检测到未完成的临时/失败计划，已清除。正在重新规划..." : "检测到新需求，已清除旧计划。正在重新规划..."
						}
					});
					// Fall through to develop path below
				} else {
					const result = await this.runExecutePhase(streamCb);
					this.onAgentStatus?.("");
					return result;
				}
			}

			if (effectiveIntent === "develop" || effectiveIntent === "plan_only") {
				if (effectiveIntent === "develop" && this.planTracker?.allDone()) {
					this.retainCurrentUserAsNewTask();
					this.planTracker = null;
				}
				if (effectiveIntent === "plan_only") {
					this._phase = "plan";
					this.planTracker = null;
					this.lastPlanCandidate = null;
					this.planReadyAwaitingExecute = false;
				}

				await this.updateSystemPrompt("plan");
				this.emitEvent({ kind: EventKind.Phase, phase: "plan_start" });

				const planResult = await this.agent.run(this.apiConfig.endpoint, this.apiConfig.apiKey, this.apiConfig.model, this.messages, this._projectPath, this.abortController.signal, streamCb, {
					phase: "plan",
					emitLifecycle: false,
					turnMode: intent,
					composerMode: this.composerMode
				});

				if (this.agent.clarificationPending) {
					return planResult;
				}

				const fullPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, planResult);

				if (!this.isActionablePlan(fullPlanText)) {
					// Retry once: inject corrective feedback and ask model to try again
					if (!this.messages.some((m) => m.role === "user" && contentAsText(m.content).includes("请严格按照以下格式输出实施计划"))) {
						this.messages.push({
							role: "user",
							origin: "harness",
							phase: "plan",
							content:
								"你刚才的回复不符合计划格式要求。请严格按照以下格式输出实施计划：\n\n" +
								"方式 A（推荐编号行）：\n" +
								"N. [kind] 简短标题 — 目标路径\n\n" +
								"方式 B（JSON）：\n" +
								'```json\n[{"kind":"write","description":"...","targetPath":"src/..."},...]\n```\n\n' +
								"其中 kind 必须是 write、recipe、mixin 或 inspect；每项必须包含 targetPath（或 targetPaths）与 evidence。最多 6 步。\n" +
								"不要写构建/运行步骤，不要写背景分析段落。直接列出步骤。"
						});
						this.onAgentStatus?.("重新生成计划...");
						planStreamReasoning = "";
						planStreamText = "";
						const retryResult = await this.agent.run(
							this.apiConfig.endpoint,
							this.apiConfig.apiKey,
							this.apiConfig.model,
							this.messages,
							this._projectPath,
							this.abortController.signal,
							streamCb,
							{ phase: "plan", emitLifecycle: false, turnMode: intent, composerMode: this.composerMode }
						);
						if (this.agent.clarificationPending) return retryResult;
						const retryPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, retryResult);
						if (!this.isActionablePlan(retryPlanText)) {
							this.onAgentStatus?.("");
							this.emitEvent({
								kind: EventKind.Notice,
								notice: {
									level: "warn",
									text: this.planFailureNotice(retryPlanText, true)
								}
							});
							if (intent !== "plan_only") {
								this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_failed" });
							}
							return retryResult;
						}
						// Retry succeeded — continue with retry plan
						this.planTracker = PlanTracker.fromPlanText(retryPlanText);
						this.emitPlanState(this.planTracker);
						if (intent === "plan_only") {
							this._phase = "plan";
							this.planReadyAwaitingExecute = true;
							this.onAgentStatus?.("");
							this.emitEvent({ kind: EventKind.Phase, phase: "plan_ready" });
							this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_ready", composerMode: this.composerMode });
							return retryResult;
						}
						const execResult = await this.beginExecuteFromTracker(streamCb);
						this.onAgentStatus?.("");
						return execResult || retryResult;
					}

					// Already retried, give up
					this.onAgentStatus?.("");
					this.emitEvent({
						kind: EventKind.Notice,
						notice: {
							level: "warn",
							text: this.planFailureNotice(fullPlanText)
						}
					});
					if (intent !== "plan_only") {
						this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_failed" });
					}
					return planResult;
				}

				this.planTracker = PlanTracker.fromPlanText(fullPlanText);
				this.emitPlanState(this.planTracker);

				if (intent === "plan_only") {
					this._phase = "plan";
					this.planReadyAwaitingExecute = true;
					this.onAgentStatus?.("");
					this.emitEvent({ kind: EventKind.Phase, phase: "plan_ready" });
					this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_ready", composerMode: this.composerMode });
					return planResult;
				}

				const execResult = await this.beginExecuteFromTracker(streamCb);
				this.onAgentStatus?.("");
				return execResult || planResult;
			}

			const result = await this.runExecutePhase(streamCb);
			this.onAgentStatus?.("");
			return result;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("Controller send error", errMsg);
			const incompletePlan = this.planTracker && !this.planTracker.allDone();
			if (incompletePlan && isRetryableFetchError(err)) {
				this.messages.push({
					role: "system",
					content: `【系统】执行因网络错误中断：${errMsg}。计划未完成，发送「继续」可从当前步骤恢复。`
				});
				this.emitEvent({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: `网络请求失败：${errMsg}。计划未完成，可发送「继续」恢复执行。`
					}
				});
			} else {
				this.onAgentStatus?.(`错误: ${errMsg}`);
			}
			this.emitEvent({ kind: EventKind.TurnDone, error: errMsg });
			return `Error: ${errMsg}`;
		} finally {
			this._running = false;
			this.abortController = null;
			void this.openCodeAdapter?.stopServer();
		}
	}

	async startExecuteFromPlan(): Promise<string> {
		if (this._running) return "";
		this.adoptPlanCandidateIfNeeded();
		if (!this.planTracker || this.planTracker.steps.length === 0) {
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "warn", text: "没有可执行的计划" } });
			return "";
		}

		this._running = true;
		this.abortController = new AbortController();
		this.agent.resetRunState();
		this.onAgentStatus?.("执行中...");

		const streamCb = (text: string, reasoning?: string) => {
			this.onStreamUpdate?.(text, reasoning);
		};

		try {
			const result = await this.beginExecuteFromTracker(streamCb);
			this.onAgentStatus?.("");
			return result;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			this.emitEvent({ kind: EventKind.TurnDone, error: errMsg });
			return `Error: ${errMsg}`;
		} finally {
			this._running = false;
			this.abortController = null;
			void this.openCodeAdapter?.stopServer();
		}
	}

	// Send user message — main entry point
	async send(input: string | ChatContentPart[]): Promise<string> {
		if (this._running) {
			logger.agent("Queuing steer message");
			this.messages.push({
				role: "user",
				content: typeof input === "string" ? "[mid-turn] " + input : input,
				origin: "user",
				taskId: this.taskId
			});
			return "";
		}
		return this.runTurn(input, { pushUser: true });
	}

	/** Re-run the last user turn without duplicating the user message */
	async retryFromUser(): Promise<string> {
		if (this._running) return "";

		this.trimTrailingAssistants();
		const lastUser = [...this.messages].reverse().find((m) => m.role === "user" && m.origin !== "harness" && !/^(?:\[mid-turn\]|\[SYSTEM:|【系统|STOP EXPLORING)/.test(contentAsText(m.content)));
		if (!lastUser) return "";

		// Drop injected execute-confirm prompts so plan phase can run again
		while (this.messages.length > 0) {
			const last = this.messages[this.messages.length - 1];
			if (last.role === "user" && last !== lastUser) {
				this.messages.pop();
				continue;
			}
			break;
		}

		this._phase = "plan";
		this.planTracker = null;
		return this.runTurn(lastUser.content, { pushUser: false });
	}

	/** Re-run the last user turn in execute phase without resetting plan.
	 *  保留 planTracker 和 _phase，仅重置 Agent 运行状态后重新运行。
	 *  适用于 execute 阶段重试：AI 从当前步骤继续执行，不重新规划、不重新问澄清。 */
	async retryExecuteTurn(): Promise<string> {
		if (this._running) return "";

		this.trimTrailingAssistants();
		const lastUser = [...this.messages].reverse().find((m) => m.role === "user" && m.origin !== "harness" && !/^(?:\[mid-turn\]|\[SYSTEM:|【系统|STOP EXPLORING)/.test(contentAsText(m.content)));
		if (!lastUser) return "";

		// Drop trailing harness-injected messages after lastUser
		while (this.messages.length > 0) {
			const last = this.messages[this.messages.length - 1];
			if (last.role === "user" && last !== lastUser) {
				this.messages.pop();
				continue;
			}
			break;
		}

		// 保持在 execute 阶段，不清空 planTracker
		// 仅重置 Agent 运行状态（clarificationPending、idleRounds 等）
		this.agent.resetRunState();

		return this.runTurn(lastUser.content, { pushUser: false });
	}

	/** Resume execution after a clarification question was answered. */
	async answerClarification(answer: string): Promise<string> {
		if (!this.agent.clarificationPending) return "";
		if (this._running) return "";

		this.agent.clarificationPending = false;

		this.messages.push({ role: "user", content: answer, origin: "user", taskId: this.taskId });

		this._running = true;
		this.abortController = new AbortController();
		this.agent.resetRunState();

		this.onAgentStatus?.("思考中...");
		this.emitEvent({ kind: EventKind.Phase, phase: "clarification_resume" });

		let planStreamText = "";
		let planStreamReasoning = "";
		const streamCb = (text: string, reasoning?: string) => {
			if (text) planStreamText = text;
			if (reasoning) planStreamReasoning = reasoning;
			this.onStreamUpdate?.(text, reasoning);
		};

		try {
			if (this._phase === "plan" || !this.planTracker) {
				// Resume plan phase — regenerate plan with clarified requirements
				await this.updateSystemPrompt("plan");

				const planResult = await this.agent.run(
					this.apiConfig.endpoint,
					this.apiConfig.apiKey,
					this.apiConfig.model,
					this.messages,
					this._projectPath,
					this.abortController!.signal,
					streamCb,
					{ phase: "plan", emitLifecycle: false, turnMode: "develop", composerMode: this.composerMode }
				);

				if (this.agent.clarificationPending) return planResult;

				const fullPlanText = this.emitPlanDonePhase(planStreamReasoning, planStreamText, planResult);

				if (!this.isActionablePlan(fullPlanText)) {
					this.onAgentStatus?.("");
					this.emitEvent({
						kind: EventKind.Notice,
						notice: {
							level: "warn",
							text: this.planFailureNotice(fullPlanText)
						}
					});
					this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_failed" });
					return planResult;
				}

				this.planTracker = PlanTracker.fromPlanText(fullPlanText);
				this.emitPlanState(this.planTracker);

				if (this.composerMode === "plan" || this.lastTurnMode === "plan_only") {
					this._phase = "plan";
					this.planReadyAwaitingExecute = true;
					this.onAgentStatus?.("");
					this.emitEvent({ kind: EventKind.Phase, phase: "plan_ready" });
					this.emitEvent({ kind: EventKind.TurnDone, phase: "plan_ready", composerMode: this.composerMode });
					return planResult;
				}

				const execResult = await this.beginExecuteFromTracker(streamCb);
				this.onAgentStatus?.("");
				return execResult || planResult;
			}

			// Resume execute phase — rebuild execute system prompt (may have been overwritten by a chat turn).
			await this.updateSystemPrompt("execute");
			const result = await this.agent.run(this.apiConfig.endpoint, this.apiConfig.apiKey, this.apiConfig.model, this.messages, this._projectPath, this.abortController!.signal, streamCb, {
				phase: "execute",
				emitLifecycle: false,
				planTracker: this.planTracker,
				opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false,
				requireInGameVerify: Boolean(this.activeUserSymptom),
				requireFeatureGuiVerify: Boolean(this.activeUserSymptom) && this.lastGuiFeatureSymptom,
				verifyTarget: this.activeVerifyTarget
			});
			this.onAgentStatus?.("");
			return result;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("Clarification resume error", errMsg);
			this.onAgentStatus?.(`错误: ${errMsg}`);
			this.emitEvent({ kind: EventKind.TurnDone, error: errMsg });
			return `Error: ${errMsg}`;
		} finally {
			this._running = false;
			this.abortController = null;
			void this.openCodeAdapter?.stopServer();
		}
	}

	cancel(): void {
		if (this.abortController) {
			this.abortController.abort();
			this._running = false;
			this.agent.clarificationPending = false;
			logger.agent("Turn cancelled");
		}
		void this.openCodeAdapter?.abort();
	}

	approve(id: string, allow: boolean): void {
		if (this.pendingApproval && this.pendingApproval.id === id) {
			this.pendingApproval.resolve(allow);
			this.pendingApproval = null;
		}
	}

	/** GUI 布局预览：触发预览面板并阻塞工具 Promise，等待用户确认/取消。 */
	private handleGuiLayoutPreview(payload: {
		id: string;
		title: string;
		layoutType: import("./events").GuiLayoutType;
		html: string;
		elements: import("./events").GuiLayoutElement[];
	}): Promise<string> {
		// 并发控制：若已有 pending 预览，自动取消旧的
		for (const [oldId, resolver] of this.pendingGuiLayoutResolvers.entries()) {
			if (oldId !== payload.id) {
				this.pendingGuiLayoutResolvers.delete(oldId);
				resolver('{"cancelled": true}');
			}
		}

		return new Promise<string>((resolve) => {
			this.pendingGuiLayoutResolvers.set(payload.id, resolve);
			this.guiLayoutPending = true;
			this.emitEvent({
				kind: EventKind.GuiLayoutPreview,
				guiLayout: {
					id: payload.id,
					title: payload.title,
					layoutType: payload.layoutType,
					html: payload.html,
					elements: payload.elements
				}
			});
		});
	}

	/** 用户确认布局：resolve 工具 Promise 并返回布局 JSON。 */
	resolveGuiLayout(id: string, layoutJson: string): void {
		const resolver = this.pendingGuiLayoutResolvers.get(id);
		if (resolver) {
			this.pendingGuiLayoutResolvers.delete(id);
			if (this.pendingGuiLayoutResolvers.size === 0) {
				this.guiLayoutPending = false;
			}
			resolver(layoutJson);
		}
	}

	/** 用户取消布局：resolve 工具 Promise 为 cancelled。 */
	cancelGuiLayout(id: string): void {
		const resolver = this.pendingGuiLayoutResolvers.get(id);
		if (resolver) {
			this.pendingGuiLayoutResolvers.delete(id);
			if (this.pendingGuiLayoutResolvers.size === 0) {
				this.guiLayoutPending = false;
			}
			resolver('{"cancelled": true}');
		}
	}

	/** 用户反馈预览不符：resolve 工具 Promise 为 cancelled + feedback，AI 据此重新生成。 */
	feedbackGuiLayout(id: string, feedback: string): void {
		const resolver = this.pendingGuiLayoutResolvers.get(id);
		if (resolver) {
			this.pendingGuiLayoutResolvers.delete(id);
			if (this.pendingGuiLayoutResolvers.size === 0) {
				this.guiLayoutPending = false;
			}
			const safeFeedback = feedback.replace(/"/g, '\\"').slice(0, 500);
			resolver(`{"cancelled": true, "feedback": "${safeFeedback}"}`);
		}
	}

	/** 清理所有未确认的 GUI 布局预览（步骤切换/修复模式进入时调用）。 */
	cancelAllPendingGuiLayouts(): void {
		if (this.pendingGuiLayoutResolvers.size === 0) return;
		for (const [, resolver] of this.pendingGuiLayoutResolvers.entries()) {
			resolver('{"cancelled": true}');
		}
		this.pendingGuiLayoutResolvers.clear();
		this.guiLayoutPending = false;
		// 通知 UI 将所有 pending 状态的预览条目标记为已取消
		this.emitEvent({ kind: EventKind.GuiLayoutPreviewCancelled });
	}

	clearSession(): void {
		this.messages = [];
		this._phase = "plan";
		this.planTracker = null;
		this.planReadyAwaitingExecute = false;
		this.lastSystemMode = null;
		this.agent.resetRunState();
		this.agent.clarificationPending = false;
		// 清理 GUI 布局预览 pending 状态
		for (const [, resolver] of this.pendingGuiLayoutResolvers.entries()) {
			resolver('{"cancelled": true}');
		}
		this.pendingGuiLayoutResolvers.clear();
		this.guiLayoutPending = false;
		logger.agent("Session cleared");
	}

	/** Export current session messages to a Markdown file via Save dialog. */
	async exportSession(): Promise<string> {
		const lines: string[] = [
			"# ModCrafting 会话导出",
			"",
			`- 导出时间：${new Date().toISOString()}`,
			`- 会话目标：${this.sessionGoal || "（未设定）"}`,
			`- 阶段：${this._phase}`,
			`- 模型：${this.apiConfig.model}`,
			`- 消息数：${this.messages.length}`,
			"",
			"---",
			""
		];

		let turn = 0;
		for (const m of this.messages) {
			if (m.role === "system") continue;
			if (m.role === "user") {
				turn += 1;
				lines.push(`## 第 ${turn} 轮 · 用户`, "", contentAsText(m.content).trim() || "_（无内容）_", "");
				continue;
			}
			if (m.role === "assistant") {
				if (turn === 0) turn = 1;
				const content = contentAsText(m.content).trim();
				const clipped = content.length > 4000 ? `${content.slice(0, 4000)}\n\n... [截断]` : content;
				lines.push(`## 第 ${turn} 轮 · 助手`, "", clipped || "_（无内容）_", "");
				continue;
			}
			if (m.role === "tool") {
				const name = m.name || "tool";
				const out = contentAsText(m.content).trim();
				const clipped = out.length > 800 ? `${out.slice(0, 800)}…` : out;
				lines.push(`- \`${name}\`${clipped ? `: ${clipped}` : ""}`, "");
			}
		}

		const md = lines.join("\n").replace(/\n{3,}/g, "\n\n");
		const result = await window.api.sessionExport(md, "mc-session");
		if (result.cancelled) {
			throw new Error("用户取消导出");
		}
		if (result.success) {
			logger.agent("Session exported", result.path);
			return result.path;
		}
		throw new Error("导出失败");
	}

	getSnapshot(): ChatMessage[] {
		return [...this.messages];
	}

	restoreSnapshot(messages: ChatMessage[]): void {
		this.messages = messages.map((message) => ({
			...message,
			origin:
				message.origin ||
				(message.role === "system" || /^\[SYSTEM:|^【系统|^【注意】|^计划已确认。/.test(contentAsText(message.content))
					? "harness"
					: message.role === "user"
						? "user"
						: message.role === "tool"
							? "tool"
							: "assistant")
		}));
		this._phase = messages.some((m) => m.role === "user" || m.role === "assistant") ? "execute" : "plan";
		this.lastSystemMode = null;
		this.agent.resetRunState();
		// Rebuild system prompt so reload does not keep a stale "对话模式" prefix.
		if (this._phase === "execute") {
			void this.updateSystemPrompt("execute");
		}
	}

	/** Rebuild the plan tracker from persisted plan steps, so the workflow
	 *  engine can resume execution after a session reload. */
	restorePlanTracker(
		steps: Array<{
			id: string;
			description: string;
			status: string;
			kind?: "inspect" | "write" | "recipe" | "mixin";
			targetPath?: string;
			targetPaths?: string[];
			evidence?: string;
		}>
	): void {
		if (!steps || steps.length === 0) {
			this.planTracker = null;
			return;
		}
		// Preserve error so stale/failed plans do not auto-resume into a lock.
		// Failed steps stay as error (not remapped to pending).
		this.planTracker = PlanTracker.fromSteps(
			steps.map((step) => ({
				...step,
				status: step.status === "completed" ? ("completed" as const) : step.status === "running" ? ("running" as const) : step.status === "error" ? ("error" as const) : ("pending" as const)
			}))
		);
		if (this.planTracker) {
			this._phase = "execute";
			this.lastSystemMode = null;
			void this.updateSystemPrompt("execute");
		}
	}

	/**
	 * Clear incomplete plan state before a new user turn so the agent must
	 * produce a fresh plan from context (instead of silently resuming old steps).
	 * Does not clear planReadyAwaitingExecute — that path uses restorePlanTracker.
	 */
	clearPlanForNewTurn(): void {
		this.planTracker = null;
		this.lastPlanCandidate = null;
		this._phase = "plan";
		this.planReadyAwaitingExecute = false;
		this.lastSystemMode = null;
	}
}
