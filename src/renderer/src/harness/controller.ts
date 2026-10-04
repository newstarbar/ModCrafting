// @ts-nocheck
// ======== Controller ========
// Ported from Reasonix internal/control/controller.go
// Session management, plan/execute phases, approval gates

import { type Sink, EventKind, type Event, FuncSink, LoggerSink } from "./events.ts";
import { Agent, type RunOptions } from "./agent.ts";
import { contentAsText, isVisionCapableModel, type ChatContentPart, type ChatMessage } from "./chat-message.ts";
import { contentPartsAsClassifyText } from "../context/user-content.ts";
import { Registry } from "./tools.ts";
import { PlanTracker } from "./plan-tracker.ts";
import { MAX_IMPLEMENTATION_PLAN_STEPS, parsePlanSteps, planHasActionableSteps, selectPlanText, selectVisiblePlanText, isActionablePlanText } from "../utils/plan-steps.ts";
import { logger } from "../utils/logger.ts";
import { buildFabricAgentPolicyPrompt } from "./fabric-agent-policy.ts";
import { isReasoningContinuityError, isRetryableFetchError } from "./fetch-retry.ts";
import { type ComposerMode, buildSessionGoalBlock, isNarrowResumeInput, isStructuralErrorReport, buildUserSymptomBlock, buildCrossTurnDiagnosisRetain } from "./turn-intent.ts";
import { classifyUserTurn, type ClassifyUserTurnResult, type ClassifierDiagnostics } from "./turn-classifier.ts";
import { isQuickCreateGeneratedMessage } from "../project/template-params.ts";
import type { WorkflowStep } from "./workflow-types.ts";
import { defaultVerifyTarget, formatVerifyTargetBlock, verifyTargetFromClassification, type VerifyTarget } from "./verify-target.ts";
import { formatGradleSummary, formatJavaFileList, parseGradleProperties, scanJavaSourceTree } from "./project-info.ts";
import { canonicalizePlanSteps, isGuiFilePath, stepRequiresGuiPreview } from "./plan-normalizer.ts";
import { computeApprovedLayoutFingerprint, getApprovedLayoutRecord, hydrateGameTestSpecsFromText, registerApprovedLayoutRecord, registerGameTestSpec, type GameTestSpec, type GameTestWorkflowStatus } from "./game-test-protocol.ts";
import { registerKnownProjectPaths } from "./tool-definitions.ts";
import { structuredGameTestGate } from "./plan-execution-gate.ts";
import {
  buildRouteDecisionFromSignals,
  extractRoutingSignals,
  findRoutingPreset,
  isFastTierRef,
  isVisionModelRef,
  MODEL_COOLDOWN_MS,
  modelRefKey,
  resolveBindingForDifficulty,
  withActiveRoles,
  type AgentRoleId,
  type CollaborationTrace,
  type ModelRef,
  type ModelRoutingConfig,
  type RouteDecision,
  type RoutingSelection,
  type TurnRoutingIntent
} from "../../../shared/model-routing.ts";
import { normalizeModelId } from "../../../shared/llm-providers.ts";
import { classifyRoutingSignals } from "./routing-classifier.ts";
import type { BuildReport, ExecutionWorkspace, HarnessRunState, LlmProtocol, ProjectProfile, ProviderProtocolDiagnostic, RepairProposal, TaskCheckpoint, ValidationStage } from "../../../shared/harness-runtime.ts";
import { compareDiagnosticProgress } from "../../../shared/harness-diagnostics.ts";
import { knowledgeQueryFingerprint } from "./doc-search-dedup.ts";
import { isKnowledgeTool } from "./tool-policy.ts";

/** Marker heading of the live project-structure message injected during execute turns. */
const PROJECT_INFO_MESSAGE_PREFIX = "## 项目结构（实时刷新）";

function isProjectInfoMessage(message: ChatMessage): boolean {
	return message.role === "system" && typeof message.content === "string" && message.content.startsWith(PROJECT_INFO_MESSAGE_PREFIX);
}

export interface ControllerOptions {
	registry: Registry;
	projectPath: string | null;
	apiConfig: { endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol };
	routingConfig?: ModelRoutingConfig;
	routingSelection?: RoutingSelection;
	resolveModelConfig?: (model: ModelRef) => Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol } | null>;
	onEvent?: (event: Event) => void;
	onAgentStatus?: (status: string) => void;
	onStreamUpdate?: (text: string, reasoning?: string) => void;
}

export class Controller {
	private agent: Agent;
	private registry: Registry;
	private sink: Sink;
	private _projectPath: string | null;

	apiConfig: { endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol };
	private routingConfig?: ModelRoutingConfig;
	private routingSelection?: RoutingSelection;
	private resolveModelConfig?: ControllerOptions['resolveModelConfig'];
	private routeDecision: RouteDecision | null = null;
	private collaborationTrace: CollaborationTrace[] = [];
	private activeRoleContext: { roleId: AgentRoleId; providerId: string; modelId: string; invocationId: string } | null = null;
	/** LiteLLM-style short cooldown after auth / 429 / protocol failure. */
	private modelCooldowns = new Map<string, number>();
	/** Per-turn role delegation counter against preset/hardLimits.maxDelegations. */
	private turnDelegationCount = 0;
	/** Candidate-only execution state. User files are promoted only after the
	 * shadow plan, build and game contract have completed. */
	private executionWorkspace: ExecutionWorkspace | null = null;
	private executionProjectPath: string | null = null;
	private projectProfile: ProjectProfile | null = null;
	private pendingCheckpoint: TaskCheckpoint | null = null;
	private resumeCheckpointRequested = false;
	private lastBuildReport: BuildReport | null = null;
	private resolvedDiagnosticIds = new Set<string>();
	private checkpointKnowledgeFactKeys = new Set<string>();
	private checkpointKnowledgeFacts = new Map<string, string>();
	private repairProposalHistory: RepairProposal[] = [];
	private providerProtocolDiagnostics: ProviderProtocolDiagnostic[] = [];
	private checkpointUsage = { repairProposals: 0, modelRounds: 0, toolCalls: 0, startedAt: Date.now(), fallbackIndex: 0 };

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
	/** Sanitized classifier transport failures for session diagnostic export. */
	private classifierDiagnostics: ClassifierDiagnostics[] = [];
	/** Last mode written into messages[0]; skip rewrite when unchanged (prompt-cache). */
	private lastSystemMode: "chat" | "plan" | "execute" | null = null;
	private taskId = `task_${Date.now().toString(36)}`;
	/** GUI 布局预览：pending 的 Promise resolver（id → resolve）。同一时刻只允许一个 pending。 */
	private pendingGuiLayoutResolvers = new Map<string, (json: string) => void>();
	private approvedGuiLayoutIds = new Set<string>();
	/** GUI 布局预览是否正在等待用户确认。 */
	guiLayoutPending = false;
	/** Dedicated visual-review request; never represented as clarificationPending. */
	private pendingVisualReview: GameTestWorkflowStatus | null = null;

	// Callbacks
	onEvent?: (event: Event) => void;
	onAgentStatus?: (status: string) => void;
	onStreamUpdate?: (text: string, reasoning?: string) => void;

	constructor(opts: ControllerOptions) {
		this.registry = opts.registry;
		this._projectPath = opts.projectPath;
		this.apiConfig = opts.apiConfig;
		this.routingConfig = opts.routingConfig;
		this.routingSelection = opts.routingSelection;
		this.resolveModelConfig = opts.resolveModelConfig;
		this.onEvent = opts.onEvent;
		this.onAgentStatus = opts.onAgentStatus;
		this.onStreamUpdate = opts.onStreamUpdate;

		this.sink = new LoggerSink(
			new FuncSink((event) => {
				if (event.kind === EventKind.ModelInvocation && event.modelInvocation?.phase === "start") {
					this.checkpointUsage.modelRounds++;
				}
				if (event.kind === EventKind.ToolDispatch && event.tool && !event.tool.partial) {
					this.checkpointUsage.toolCalls++;
				}
				if (event.kind === EventKind.Collaboration && event.collaboration?.status === "fallback") {
					this.checkpointUsage.fallbackIndex++;
				}
				if (event.kind === EventKind.ToolResult && event.tool?.buildReport) {
					if (this.lastBuildReport?.diagnostics?.length && event.tool.buildReport.diagnostics?.length) {
						for (const id of compareDiagnosticProgress(this.lastBuildReport.diagnostics, event.tool.buildReport.diagnostics).resolvedIds) this.resolvedDiagnosticIds.add(id);
					}
					this.lastBuildReport = event.tool.buildReport;
				}
				if (event.kind === EventKind.ToolResult && event.tool && isKnowledgeTool(event.tool.name || "")) {
					const raw = knowledgeQueryFingerprint(event.tool.name || "", (() => { try { return JSON.parse(event.tool.args || "{}"); } catch { return {}; } })());
					if (raw !== `${event.tool.name}:`) {
						const key = `${this.projectProfile?.fingerprint || this._projectPath || "unknown"}|${event.tool.name}|${raw}`;
						this.checkpointKnowledgeFactKeys.add(key);
						if (event.tool.output && !event.tool.error) this.checkpointKnowledgeFacts.set(key, event.tool.output);
					}
				}
				if (event.tool && !event.tool.source) {
					const name = event.tool.name || '';
					event.tool.source = name.startsWith('plugin_') || name.startsWith('plugin:') ? 'plugin' : name.startsWith('external_') || name.startsWith('external:') ? 'external' : 'core';
				}
				this.trackGameTestStatus(event);
				if (event.kind === EventKind.Usage && event.usage && this.activeRoleContext) {
					event.usage = { ...event.usage, ...this.activeRoleContext };
				}
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
			onCancelPendingGuiLayouts: () => this.cancelAllPendingGuiLayouts(),
			onModelInvocation: (request) => {
				const context = this.activeRoleContext;
				// Agent model calls are always made inside runForRole. Keep a safe
				// fallback for direct harness invocations so the audit is never
				// silently dropped if a future caller bypasses role routing.
				this.emitModelInvocation({
					...request,
					roleId: context?.roleId || 'implementer',
					providerId: context?.providerId || this.apiConfig.providerId || 'custom',
					modelId: request.modelId
				});
			},
			onRepairProposal: (proposal) => {
					this.checkpointUsage.repairProposals++;
					this.repairProposalHistory = [...this.repairProposalHistory, proposal].slice(-64);
			},
			onProviderProtocolDiagnostic: (diagnostic) => {
				this.providerProtocolDiagnostics = [...this.providerProtocolDiagnostics, diagnostic].slice(-128);
				this.emitEvent({ kind: EventKind.Notice, notice: { level: 'warn', text: `Provider 工具流诊断：${diagnostic.message}` } });
			}
		});
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
		if (this._projectPath && p && this._projectPath.replace(/\\/g, "/").toLowerCase() !== p.replace(/\\/g, "/").toLowerCase()) {
			this.executionWorkspace = null;
			this.executionProjectPath = null;
			this.projectProfile = null;
			this.pendingCheckpoint = null;
			this.lastBuildReport = null;
			this.resolvedDiagnosticIds.clear();
			this.checkpointKnowledgeFactKeys.clear();
			this.checkpointKnowledgeFacts.clear();
		}
		this._projectPath = p;
		if (p) void this.loadPendingCheckpoint(p);
	}

	private activeProjectPath(): string | null {
		return this.executionProjectPath || this._projectPath;
	}

	private taskBudgetReason(): string | null {
		const budget = this.checkpointUsage;
		if (budget.repairProposals >= 12) return "修复候选预算（12）已用尽";
		if (budget.modelRounds >= 40) return "模型轮次预算（40）已用尽";
		if (budget.toolCalls >= 120) return "工具调用预算（120）已用尽";
		if (Date.now() - budget.startedAt >= 90 * 60_000) return "90 分钟任务预算已用尽";
		return null;
	}

	private async ensureProjectProfile(): Promise<void> {
		if (this.projectProfile || !this._projectPath || typeof window === "undefined" || !window.api?.inspectProjectProfile) return;
		try {
			this.projectProfile = await window.api.inspectProjectProfile(this._projectPath);
		} catch (error) {
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "warn", text: `项目画像解析暂不可用，继续使用受限模式：${error instanceof Error ? error.message : String(error)}` } });
		}
	}

	private async loadPendingCheckpoint(projectPath: string): Promise<void> {
		try {
			if (!window.api.listHarnessCheckpoints) return;
			const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
			const candidates = (await window.api.listHarnessCheckpoints()).filter((checkpoint) => {
				const candidate = checkpoint.workspace.userProjectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
				return candidate === normalized && checkpoint.state !== "COMPLETE" && checkpoint.workspace.status !== "discarded" && checkpoint.workspace.status !== "promoted";
			});
			this.pendingCheckpoint = candidates[0] || null;
			if (this.pendingCheckpoint) {
				this.emitEvent({ kind: EventKind.Notice, notice: { level: "info", text: "发现可恢复的 Harness 检查点。发送「继续」将从影子工程和当前步骤原地恢复。" } });
			}
		} catch {
			// Checkpoint discovery is advisory; a missing/old file must never block a new task.
		}
	}

	/** Rehydrate the host-owned plan before routing a narrow "continue" after
	 * renderer/application restart.  Chat history is not a source of truth for
	 * execution state; the checkpoint's serialized steps are. */
	private restorePlanFromCheckpoint(): boolean {
		const checkpoint = this.pendingCheckpoint;
		if (!checkpoint?.plan?.length) return false;
		const steps = checkpoint.plan.map((step) => ({
			id: step.id,
			description: step.description,
			status: step.status,
			...(step.kind ? { kind: step.kind } : {}),
			...(step.targetPath ? { targetPath: step.targetPath } : {}),
			...(step.targetPaths ? { targetPaths: [...step.targetPaths] } : {}),
			...(step.evidence ? { evidence: step.evidence } : {}),
			...(step.gameTest ? { gameTest: step.gameTest as GameTestSpec } : {})
		}));
		this.planTracker = PlanTracker.fromSteps(steps);
		this.taskId = checkpoint.taskId;
		this.projectProfile = checkpoint.profile || this.projectProfile;
		this.lastBuildReport = checkpoint.lastBuildReport || this.lastBuildReport;
		this.resolvedDiagnosticIds = new Set(checkpoint.resolvedDiagnosticIds || []);
		this.checkpointKnowledgeFactKeys = new Set(checkpoint.knowledgeFactKeys || []);
		this.checkpointKnowledgeFacts = new Map((checkpoint.knowledgeFacts || []).map((fact) => [fact.key, fact.value]));
		this.repairProposalHistory = [...(checkpoint.repairProposals || [])];
		this.providerProtocolDiagnostics = [...(checkpoint.providerProtocolDiagnostics || [])];
		this.checkpointUsage = {
			repairProposals: checkpoint.budgets?.repairProposals || 0,
			modelRounds: checkpoint.budgets?.modelRounds || 0,
			toolCalls: checkpoint.budgets?.toolCalls || 0,
			startedAt: checkpoint.budgets?.startedAt || Date.now(),
			fallbackIndex: checkpoint.fallbackIndex || 0
		};
		this._phase = "execute";
		this.planReadyAwaitingExecute = false;
		this.resumeCheckpointRequested = true;
		this.emitPlanState(this.planTracker);
		return true;
	}

	private async saveHarnessCheckpoint(state: HarnessRunState, stage: ValidationStage, reason?: string): Promise<void> {
		const initialWorkspace = this.executionWorkspace;
		if (!initialWorkspace || !window.api.saveHarnessCheckpoint) return;
		let workspace: ExecutionWorkspace = initialWorkspace;
		if (state === "PAUSED" && window.api.markWorkspace) {
			try {
				workspace = await window.api.markWorkspace(workspace.id, "paused");
				this.executionWorkspace = workspace;
			} catch { /* preserve the checkpoint even when metadata cannot be updated */ }
		}
		let patchJournal = workspace.patchJournal || [];
		try {
			const diff = await window.api.diffWorkspace?.(workspace.id);
			if (diff) {
				workspace = { ...workspace, changedPaths: diff.changedPaths, patchJournal: diff.patchJournal };
				this.executionWorkspace = workspace;
				patchJournal = diff.patchJournal;
			}
		} catch { /* diff is advisory; the shadow workspace remains recoverable */ }
		const checkpointWorkspace = patchJournal.length > 0 ? { ...workspace, patchJournal } : workspace;
		const checkpoint: TaskCheckpoint = {
			version: 1,
			schemaVersion: 2,
			taskId: this.taskId,
			workspace: checkpointWorkspace,
			state,
			stage,
			profile: this.projectProfile || undefined,
			planStepId: this.planTracker?.currentStep?.id,
			diagnosticIds: this.lastBuildReport?.diagnostics.map((diagnostic) => diagnostic.id) || [],
			resolvedDiagnosticIds: [...this.resolvedDiagnosticIds],
			...(this.lastBuildReport ? { lastBuildReport: this.lastBuildReport } : {}),
			repairProposals: this.repairProposalHistory.length > 0 ? this.repairProposalHistory.slice(-64) : this.lastBuildReport?.diagnostics.slice(0, 12).map((diagnostic) => ({
				id: `diagnostic_${diagnostic.id}`,
				diagnosticIds: [diagnostic.id],
				hypothesis: "待模型根据 BuildReport 确认根因",
				files: diagnostic.file ? [diagnostic.file] : [],
				expectedResolution: "消除 diagnostic ID 或推进验证阶段"
			})) || [],
			modelRole: this.activeRoleContext?.roleId,
			fallbackIndex: this.checkpointUsage.fallbackIndex,
			budgets: {
				repairProposals: this.checkpointUsage.repairProposals,
				modelRounds: this.checkpointUsage.modelRounds,
				toolCalls: this.checkpointUsage.toolCalls,
				startedAt: this.checkpointUsage.startedAt,
				maxRepairProposals: 12,
				maxModelRounds: 40,
				maxToolCalls: 120,
				maxMinutes: 90
			},
			updatedAt: Date.now(),
			quickGameStatus: "pending",
			finalGameStatus: state === "COMPLETE" ? "pass" : "pending",
			knowledgeFactKeys: [...this.checkpointKnowledgeFactKeys].slice(-256),
			knowledgeFacts: [...this.checkpointKnowledgeFacts.entries()].slice(-256).map(([key, value]) => ({ key, value })),
			plan: this.planTracker?.snapshot().map((step) => ({ ...step })),
			modelCalls: this.collaborationTrace
				.filter((trace) => trace.status === "completed" || trace.status === "failed" || trace.status === "fallback")
				.slice(-32)
				.map((trace) => ({ roleId: trace.roleId, providerId: trace.providerId, modelId: trace.modelId, status: trace.status, startedAt: trace.startedAt, endedAt: trace.endedAt })),
			providerProtocolDiagnostics: this.providerProtocolDiagnostics.slice(-128),
			...(reason ? { pauseReason: reason } : {})
		};
		try { await window.api.saveHarnessCheckpoint(checkpoint); } catch { /* recovery must not mask the original result */ }
	}

	private async prepareExecutionWorkspace(): Promise<boolean> {
		if (!this._projectPath) return true;
		if (this.executionWorkspace && this.executionProjectPath) return true;
		try {
			if (!this.pendingCheckpoint) await this.loadPendingCheckpoint(this._projectPath);
			if (this.resumeCheckpointRequested && this.pendingCheckpoint && this.pendingCheckpoint.workspace.userProjectPath.replace(/\\/g, "/").toLowerCase() === this._projectPath.replace(/\\/g, "/").toLowerCase()) {
				const checkpoint = this.pendingCheckpoint;
				// A baseline blocker belongs to the old user-project fingerprint.  If
				// the user fixed the project while paused, discard the stale candidate
				// and create a fresh baseline; otherwise keep the blocker explicit.
				const currentProfile = await window.api.inspectProjectProfile(this._projectPath);
				if (checkpoint.pauseReason === "BASELINE_BUILD_FAILED" && checkpoint.profile?.fingerprint === currentProfile.fingerprint) {
					this.emitEvent({ kind: EventKind.Notice, notice: { level: "error", text: "基线工程仍未通过编译；请先修复用户项目本身，再发送「继续」。影子工程未被提交。" } });
					return false;
				}
				if (checkpoint.profile?.fingerprint && checkpoint.profile.fingerprint !== currentProfile.fingerprint) {
					this.pendingCheckpoint = null;
					this.resumeCheckpointRequested = false;
					this.lastBuildReport = null;
					this.resolvedDiagnosticIds.clear();
					this.checkpointKnowledgeFactKeys.clear();
					this.checkpointKnowledgeFacts.clear();
					this.repairProposalHistory = [];
					this.emitEvent({ kind: EventKind.Notice, notice: { level: "info", text: "检测到用户项目基线已变化，旧影子候选不再覆盖新修改；将重新建立画像和基线。" } });
				} else {
				const restored = await window.api.getWorkspace(this.pendingCheckpoint.workspace.id);
				this.executionWorkspace = restored;
				this.executionProjectPath = restored.shadowPath;
				this.projectProfile = this.pendingCheckpoint.profile || await window.api.inspectProjectProfile(restored.shadowPath);
				this.taskId = this.pendingCheckpoint.taskId;
				this.pendingCheckpoint = null;
				this.resumeCheckpointRequested = false;
				this.emitEvent({ kind: EventKind.Notice, notice: { level: "info", text: `已恢复影子工作区：${restored.id}` } });
				return true;
				}
			}
			this.projectProfile = await window.api.inspectProjectProfile(this._projectPath);
			const workspace = await window.api.createWorkspace(this._projectPath, this.taskId);
			this.executionWorkspace = workspace;
			this.executionProjectPath = workspace.shadowPath;
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "info", text: "已创建影子工作区。模型的读写、编译和游戏测试均在候选工程中进行。" } });

			// Baseline is deterministic and host-owned. An existing project failure is
			// recorded as a blocker and is never attributed to the requested feature.
			const profile = this.projectProfile;
			const candidateTasks = profile?.splitEnvironment
				? ["compileJava compileClientJava processResources", "classes"]
				: ["compileJava processResources", "classes"];
			let baselineResult: { output: string; exitCode: number; report?: BuildReport } | null = null;
			for (const task of candidateTasks) {
				const cached = profile?.fingerprint && window.api.getBaselineBuildCache
					? await window.api.getBaselineBuildCache(this._projectPath, profile.fingerprint, task)
					: null;
				if (cached?.ok) {
					baselineResult = { output: `${cached.output}\n[BASELINE CACHE HIT]`, exitCode: cached.exitCode, report: cached };
					this.lastBuildReport = cached;
					break;
				}
				baselineResult = await window.api.runGradleTask(workspace.shadowPath, task, { timeoutMs: 10 * 60_000 });
				// Re-normalize the host result with the baseline flag.  The generic
				// env:runGradleTask channel cannot know whether a caller is probing a
				// baseline, so old reports must not misattribute pre-existing failures
				// to generated code.
				const report = window.api.createBuildReport
					? await window.api.createBuildReport({ projectPath: workspace.shadowPath, task, output: baselineResult.output, exitCode: baselineResult.exitCode, usedOnlineFallback: baselineResult.report?.usedOnlineFallback, cancelled: baselineResult.report?.cancelled, baseline: true })
					: baselineResult.report;
				this.lastBuildReport = report;
				if (report.ok) {
					if (profile?.fingerprint && window.api.putBaselineBuildCache) void window.api.putBaselineBuildCache(this._projectPath, profile.fingerprint, task, report);
					break;
				}
				if (!/task .*not found|任务 .*不存在|unknown task|找不到任务/i.test(report.output)) break;
			}
			const baselineReport = baselineResult?.report;
			if (baselineReport && !baselineReport.ok) {
				await window.api.markWorkspace?.(workspace.id, "paused");
				await this.saveHarnessCheckpoint("PAUSED", "baseline", "BASELINE_BUILD_FAILED");
				this.emitEvent({ kind: EventKind.Notice, notice: { level: "error", text: `基线工程本身未通过编译，已暂停且未修改用户项目。\n${baselineReport.diagnostics.slice(0, 4).map((d) => `${d.file || ""}${d.line ? `:${d.line}` : ""} ${d.message}`).join("\n") || baselineReport.output.slice(-1200)}` } });
				return false;
			}
			await this.saveHarnessCheckpoint("PROFILED", "profiled");
			return true;
		} catch (error) {
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "error", text: `无法创建 Harness 影子工作区，任务已暂停：${error instanceof Error ? error.message : String(error)}` } });
			await this.saveHarnessCheckpoint("PAUSED", "baseline", "WORKSPACE_CREATE_FAILED");
			return false;
		}
	}

	private async finalizeAtomicDelivery(): Promise<boolean> {
		const workspace = this.executionWorkspace;
		if (!workspace || !this._projectPath) return true;
		try {
			await this.saveHarnessCheckpoint("FINAL_GAME_TEST", "final_game");
			await this.saveHarnessCheckpoint("PROMOTE", "promote");
			await window.api.markWorkspace?.(workspace.id, "active");
			const promoted = await window.api.promoteWorkspace(workspace.id);
			if (!promoted.ok) {
				await window.api.markWorkspace?.(workspace.id, "paused", { changedPaths: promoted.changedPaths, conflictPaths: promoted.conflictPaths });
				await this.saveHarnessCheckpoint("PAUSED", "promote", promoted.status === "promotion_conflict" ? "PROMOTION_CONFLICT" : (promoted.error || "PROMOTION_FAILED"));
				this.emitEvent({ kind: EventKind.Notice, notice: { level: "warn", text: promoted.status === "promotion_conflict" ? `用户项目在执行期间发生修改，未覆盖用户文件。冲突文件：${promoted.conflictPaths.join(", ")}` : `候选交付未能提交：${promoted.error || "未知错误"}` } });
				return false;
			}
			// Promotion is followed by one real-project build. If it fails, the
			// workspace manager restores the exact pre-task files from its backup.
			try { await window.api.mcStopAll?.(); } catch { /* build may still proceed if no client is running */ }
			const final = await window.api.runGradleTask(this._projectPath, "build", { timeoutMs: 15 * 60_000 });
			const report = final.report || await window.api.createBuildReport({ projectPath: this._projectPath, task: "build", output: final.output, exitCode: final.exitCode });
			this.lastBuildReport = report;
			if (!report.ok) {
				await window.api.rollbackWorkspace(workspace.id);
				await window.api.markWorkspace?.(workspace.id, "rolled_back");
				await this.saveHarnessCheckpoint("PAUSED", "final_build", "FINAL_BUILD_FAILED");
				this.emitEvent({ kind: EventKind.Notice, notice: { level: "error", text: `最终真实项目构建失败，已自动回滚用户文件。\n${report.diagnostics.slice(0, 4).map((d) => `${d.file || ""}${d.line ? `:${d.line}` : ""} ${d.message}`).join("\n") || report.output.slice(-1200)}` } });
				return false;
			}
			await this.saveHarnessCheckpoint("COMPLETE", "complete");
			await window.api.removeHarnessCheckpoint?.(this.taskId);
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "info", text: `原子交付完成：${promoted.changedPaths.length} 个文件已通过影子工程验收并提交。` } });
			return true;
		} catch (error) {
			try { await window.api.rollbackWorkspace(workspace.id); } catch { /* preserve checkpoint for manual recovery */ }
			await this.saveHarnessCheckpoint("PAUSED", "promote", `PROMOTION_EXCEPTION: ${error instanceof Error ? error.message : String(error)}`);
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "error", text: `原子交付异常，候选工程已保留，可发送「继续」恢复：${error instanceof Error ? error.message : String(error)}` } });
			return false;
		}
	}

	setApiConfig(config: { endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol }): void {
		this.apiConfig = config;
	}

	setRouting(config: ModelRoutingConfig | undefined, selection: RoutingSelection | undefined, resolver?: ControllerOptions['resolveModelConfig']): void {
		this.routingConfig = config;
		this.routingSelection = selection;
		this.resolveModelConfig = resolver;
	}

	getCollaborationTrace(): CollaborationTrace[] { return [...this.collaborationTrace]; }
	getRouteDecision(): RouteDecision | null { return this.routeDecision; }

	private routingBudget(): { maxDelegations: number } {
		const hard = this.routingConfig?.hardLimits?.maxDelegations ?? 12;
		if (!this.routingConfig || !this.routingSelection || this.routingSelection.mode !== 'routed') {
			return { maxDelegations: hard };
		}
		const preset = findRoutingPreset(this.routingConfig, this.routingSelection.customPresetId || this.routingSelection.strategyId);
		return { maxDelegations: Math.min(hard, preset.budget.maxDelegations) };
	}

	private isModelCooling(ref: ModelRef, now = Date.now()): boolean {
		const until = this.modelCooldowns.get(modelRefKey(ref));
		return typeof until === 'number' && until > now;
	}

	private markModelCooldown(ref: ModelRef, reason: string): void {
		this.modelCooldowns.set(modelRefKey(ref), Date.now() + MODEL_COOLDOWN_MS);
		logger.agent('model cooldown', { providerId: ref.providerId, modelId: ref.modelId, reason, ms: MODEL_COOLDOWN_MS });
	}

	private async modelConfigsForRole(roleId: AgentRoleId): Promise<Array<{ endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol; ref: ModelRef }>> {
		const fixed = this.routingSelection?.mode !== 'routed';
		if (fixed || !this.routingConfig || !this.routingSelection) {
			return [{ ...this.apiConfig, ref: { providerId: this.apiConfig.providerId || 'custom', modelId: this.apiConfig.model } }];
		}
		const preset = findRoutingPreset(this.routingConfig, this.routingSelection.customPresetId || this.routingSelection.strategyId);
		const binding = preset.roles[roleId];
		if (binding && binding.enabled === false && !binding.required) {
			throw new Error(`角色「${roleId}」已在预设中禁用。`);
		}
		const difficulty = this.routeDecision?.difficulty || 'simple';
		const resolvedBinding = resolveBindingForDifficulty(binding, difficulty);
		// Folding the composer selection into cheap slots can collide with a fallback,
		// so de-duplicate by ref key while preserving escalation order.
		const seenRefs = new Set<string>();
		const candidates: ModelRef[] = [];
		for (const ref of [resolvedBinding.primary, ...resolvedBinding.fallbacks]) {
			const preferred = this.withUserModelPreference(roleId, ref);
			const key = modelRefKey(preferred);
			if (seenRefs.has(key)) continue;
			seenRefs.add(key);
			candidates.push(preferred);
		}
		const resolvedConfigs: Array<{ endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol; ref: ModelRef }> = [];
		let lastError = '';
		const now = Date.now();
		for (const candidate of candidates) {
			if (roleId === 'visualReviewer' && !isVisionModelRef(candidate)) continue;
			if (this.isModelCooling(candidate, now)) {
				lastError = `${candidate.providerId}/${candidate.modelId}(冷却中)`;
				continue;
			}
			const resolved = await this.resolveModelConfig?.(candidate);
			if (resolved?.apiKey?.trim()) resolvedConfigs.push({ ...resolved, ref: candidate });
			lastError = `${candidate.providerId}/${candidate.modelId}`;
		}
		if (resolvedConfigs.length > 0) return resolvedConfigs;
		throw new Error(`角色「${roleId}」没有可用模型${lastError ? `（已尝试 ${lastError}）` : ''}。请在设置中保存所需 Provider 的 API Key。`);
	}

	private async modelConfigForRole(roleId: AgentRoleId): Promise<{ endpoint: string; apiKey: string; model: string; providerId?: string; protocol?: LlmProtocol; ref: ModelRef }> {
		return (await this.modelConfigsForRole(roleId))[0];
	}

	/**
	 * In routed mode the composer selection used to be inert: every cheap slot resolved
	 * to a catalog default the user never picked, while only the strong-model slots drove
	 * the bill. Routing may still escalate to the strong model, but a cheap slot now
	 * belongs to the model the user selected — and only when that model can serve the
	 * role (vision roles keep their requirement).
	 */
	private withUserModelPreference(roleId: AgentRoleId, ref: ModelRef): ModelRef {
		const providerId = this.apiConfig.providerId;
		if (!providerId || providerId !== ref.providerId) return ref;
		if (!isFastTierRef(ref)) return ref;
		const modelId = normalizeModelId(providerId, this.apiConfig.model || '');
		if (!modelId || modelId === ref.modelId) return ref;
		const preferred: ModelRef = { providerId, modelId };
		if (roleId === 'visualReviewer' && !isVisionModelRef(preferred)) return ref;
		return preferred;
	}

	private roleIsActive(roleId: AgentRoleId): boolean {
		return Boolean(this.routeDecision?.activeRoles.includes(roleId));
	}

	private async resolveRouteDecisionHybrid(inputText: string, intent: TurnRoutingIntent): Promise<RouteDecision> {
		const template = this.routingSelection?.taskTemplateId || 'auto';
		const hasImages = /data:image\//i.test(inputText);
		const seed = extractRoutingSignals(inputText, template, hasImages);
		let signals = seed;
		let source: RouteDecision['source'] = 'rules';
		if (seed.ambiguous) {
			try {
				const routerConfig = await this.modelConfigForRole('router');
				const refined = await classifyRoutingSignals({
					apiConfig: routerConfig,
					input: inputText,
					seed,
					abortSignal: this.abortController?.signal
				});
				if (refined) {
					signals = refined;
					source = 'hybrid';
				}
			} catch {
				source = 'fallback';
			}
		}
		return withActiveRoles(buildRouteDecisionFromSignals(signals, source, intent), intent);
	}

	private recordCollaboration(trace: CollaborationTrace): void {
		this.collaborationTrace.push(trace);
		this.emitEvent({ kind: EventKind.Collaboration, collaboration: trace, routeDecision: this.routeDecision || undefined });
	}

	private emitModelInvocation(invocation: import('./events.ts').ModelInvocationEvent): void {
		this.emitEvent({ kind: EventKind.ModelInvocation, modelInvocation: invocation, routeDecision: this.routeDecision || undefined });
	}

	private async runForRole(roleId: AgentRoleId, streamCb: (text: string, reasoning?: string) => void, options: RunOptions): Promise<string> {
		const budget = this.routingBudget();
		if (this.turnDelegationCount >= budget.maxDelegations) {
			return `[HARNESS_PAUSED:budget] 本轮职责委派已达上限（${budget.maxDelegations}）。请发送「继续」或简化任务后再试。`;
		}
		this.turnDelegationCount += 1;
		const configs = await this.modelConfigsForRole(roleId);
		let lastError: unknown;
		for (let index = 0; index < configs.length; index++) {
			const budgetReason = this.taskBudgetReason();
			if (budgetReason) {
				if (this.executionWorkspace) await this.saveHarnessCheckpoint("PAUSED", "compile_check", "TASK_BUDGET_EXHAUSTED");
				return `[HARNESS_PAUSED:budget] ${budgetReason}。候选工程已保留，发送「继续」时仍会遵守已用预算。`;
			}
			const config = configs[index];
			const trace: CollaborationTrace = {
				id: `role_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
				roleId, providerId: config.ref.providerId, modelId: config.ref.modelId, status: 'running', startedAt: Date.now(),
				...(index > 0 ? { fallbackFrom: configs[index - 1].ref } : {})
			};
			this.recordCollaboration(trace);
			this.emitModelInvocation({ invocationId: trace.id, roleId, providerId: config.ref.providerId, modelId: config.ref.modelId, phase: 'start', startedAt: trace.startedAt, status: 'running' });
			try {
				this.activeRoleContext = { roleId, providerId: config.ref.providerId, modelId: config.ref.modelId, invocationId: trace.id };
				const result = await this.agent.run(config.endpoint, config.apiKey, config.model, this.messages, this.activeProjectPath(), this.abortController?.signal, streamCb, {
					...options,
					providerId: config.ref.providerId || config.providerId,
					protocol: config.protocol,
					projectProfile: options.projectProfile ?? this.projectProfile,
					previousBuildReport: options.previousBuildReport ?? this.lastBuildReport,
					knowledgeFacts: [...this.checkpointKnowledgeFacts.entries()].map(([key, value]) => ({ key, value }))
				});
				const failed = /^Error:|执行因错误中断|^\[HARNESS_PAUSED:(?:diagnostic_stalled|protocol|budget|evidence_deadlock)\]/.test(result);
				trace.status = failed ? 'failed' : 'completed'; trace.endedAt = Date.now(); trace.summary = failed ? result.slice(0, 180) : '职责完成';
				this.emitModelInvocation({ invocationId: trace.id, roleId, providerId: config.ref.providerId, modelId: config.ref.modelId, phase: 'end', startedAt: trace.startedAt, endedAt: trace.endedAt, status: trace.status });
				this.recordCollaboration(trace); this.activeRoleContext = null;
				// evidence_deadlock is a gate contradiction, not a model defect: switching
				// providers would re-run the same refused step.
				if (!failed || index === configs.length - 1 || /^\[HARNESS_PAUSED:(?:budget|evidence_deadlock)\]/.test(result)) return result;
				if (/^\[HARNESS_PAUSED:protocol\]/.test(result) || /(?:429|rate.?limit|401|403|unauthorized|invalid.?api.?key)/i.test(result)) {
					this.markModelCooldown(config.ref, 'role_failure');
				}
				lastError = new Error(result);
				if (/^\[HARNESS_PAUSED:protocol\]/.test(result)) {
					this.providerProtocolDiagnostics = [...this.providerProtocolDiagnostics, {
						id: `fallback:configured:${Date.now()}`,
						providerId: config.ref.providerId,
						modelId: config.ref.modelId,
						kind: 'fallback',
						message: 'native and XML tool protocols failed; switching to configured fallback provider',
						fallback: 'configured_provider',
						createdAt: Date.now()
					}].slice(-128);
				}
			} catch (error) {
				this.activeRoleContext = null; trace.status = 'failed'; trace.endedAt = Date.now(); trace.summary = String(error); this.emitModelInvocation({ invocationId: trace.id, roleId, providerId: config.ref.providerId, modelId: config.ref.modelId, phase: 'end', startedAt: trace.startedAt, endedAt: trace.endedAt, status: 'failed', error: String(error) }); this.recordCollaboration(trace); lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				// A thinking-continuation rejection is a request-shape contract breach, not an
				// outage: the fallback model hits the identical 400 and the reasoning history is
				// lost either way, so surface it instead of walking the fallback ladder.
				if (isReasoningContinuityError(error)) throw error;
				if (/(?:429|rate.?limit|401|403|unauthorized|invalid.?api.?key)/i.test(message)) {
					this.markModelCooldown(config.ref, 'exception');
				}
				if (index === configs.length - 1) throw error;
			}
			this.agent.resetProviderProtocolState();
			this.recordCollaboration({ ...trace, id: `${trace.id}_fallback`, status: 'fallback', summary: '主模型不可用，切换备用模型。' });
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError || '模型调用失败'));
	}

	/** Short readonly role turn (explorer / debugger / reviewer / summarizer). */
	private async runReadonlyRoleBrief(
		roleId: AgentRoleId,
		streamCb: (text: string, reasoning?: string) => void,
		instruction: string
	): Promise<string> {
		if (!this.roleIsActive(roleId)) return '';
		this.messages.push({
			role: 'user',
			origin: 'harness',
			phase: 'plan',
			taskId: this.taskId,
			content: instruction
		});
		this.onAgentStatus?.(roleId === 'explorer' ? '勘探中...' : roleId === 'debugger' ? '诊断中...' : roleId === 'codeReviewer' ? '代码审查中...' : '总结中...');
		return this.runForRole(roleId, streamCb, {
			phase: 'plan',
			emitLifecycle: false,
			turnMode: this.lastTurnMode === 'plan_only' ? 'plan_only' : 'develop',
			composerMode: this.composerMode
		});
	}

	private async maybeRunExplorerBrief(streamCb: (text: string, reasoning?: string) => void): Promise<void> {
		if (!this.roleIsActive('explorer')) return;
		const template = this.routeDecision?.taskTemplateId;
		const hint = template === 'minecraft'
			? '只读勘探：先用 minecraft_data_lookup / list_directory / read_file 定位相关代码与标准 ID，用简短中文总结路径与约束后停止。禁止写文件。'
			: template === 'build'
				? '只读勘探：检查构建脚本与环境相关文件，总结可能原因后停止。禁止写文件。'
				: '只读勘探：用 list_directory / read_file 了解相关代码结构，用简短中文总结后停止。禁止写文件、禁止 submit_plan。';
		await this.runReadonlyRoleBrief('explorer', streamCb, hint);
	}

	private async maybeRunDebuggerBrief(streamCb: (text: string, reasoning?: string) => void): Promise<void> {
		if (!this.roleIsActive('debugger')) return;
		await this.runReadonlyRoleBrief(
			'debugger',
			streamCb,
			'只读诊断：用 read_error_log / fabric_log_debugger / read_file 定位根因，输出简短中文诊断与建议修改点后停止。禁止写文件。'
		);
	}

	private async maybeRunPostExecuteRoles(streamCb: (text: string, reasoning?: string) => void, executeResult: string): Promise<string> {
		if (!this.planTracker?.allDone()) return executeResult;
		let result = executeResult;
		if (this.roleIsActive('codeReviewer') && !/^Error:|^\[HARNESS_PAUSED:/.test(executeResult)) {
			const review = await this.runReadonlyRoleBrief(
				'codeReviewer',
				streamCb,
				'只读代码审查：基于本轮改动与构建/测试结果，指出风险与遗漏；不要写文件，完成后给出简短中文结论。'
			);
			if (review) result = `${result}\n\n${review}`;
		}
		if (this.roleIsActive('summarizer')) {
			const summary = await this.runReadonlyRoleBrief(
				'summarizer',
				streamCb,
				'用简短中文总结本轮完成内容、验证结果与后续建议。不要调用写文件工具。'
			);
			if (summary) result = `${result}\n\n${summary}`;
		}
		return result;
	}

	private async runKnowledgeTurn(streamCb: (text: string, reasoning?: string) => void): Promise<string> {
		await this.updateSystemPrompt('chat');
		await this.maybeRunExplorerBrief(streamCb);
		if (this.roleIsActive('summarizer')) {
			return this.runReadonlyRoleBrief(
				'summarizer',
				streamCb,
				'基于勘探结果用中文回答用户的知识/文档问题。可继续只读检索；不要写文件。'
			);
		}
		return this.runForRole('coordinator', streamCb, {
			phase: 'plan',
			emitLifecycle: true,
			turnMode: 'chat',
			composerMode: this.composerMode
		});
	}

	setRegistry(registry: Registry): void {
		this.registry = registry;
		this.agent.setRegistry(registry);
	}

	private emitEvent(event: Event): void {
		if (event.tool && !event.tool.source) {
			const name = event.tool.name || '';
			event.tool.source = name.startsWith('plugin_') || name.startsWith('plugin:') ? 'plugin' : name.startsWith('external_') || name.startsWith('external:') ? 'external' : 'core';
		}
		this.trackGameTestStatus(event);
		this.sink.emit(event);
	}

	private trackGameTestStatus(event: Event): void {
		if (event.kind === EventKind.GameTestStatus && event.gameTestStatus) {
			if (event.gameTestStatus.reviewDecision && this.pendingVisualReview?.reviewId === event.gameTestStatus.reviewId) {
				this.pendingVisualReview = null;
			} else if (event.gameTestStatus.state === "visual_review") {
				this.pendingVisualReview = event.gameTestStatus;
			}
		}
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
		if (this.isActionablePlan(planText)) {
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
		if (!structuredGameTestGate(planText).ok) return false;
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
		this.checkpointUsage = { repairProposals: 0, modelRounds: 0, toolCalls: 0, startedAt: Date.now(), fallbackIndex: 0 };
		this.resolvedDiagnosticIds.clear();
		this.checkpointKnowledgeFactKeys.clear();
		this.checkpointKnowledgeFacts.clear();
		this.repairProposalHistory = [];
		this.lastBuildReport = null;
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
		const gameGate = structuredGameTestGate(fullPlanText);
		const detail = !gameGate.ok
			? gameGate.error
			: planHasActionableSteps(fullPlanText) ? "计划含编号步骤但缺少目标路径（如 src/main/java/...）。" : "未能解析出符合格式的编号步骤。";
		return (
			`${prefix}${detail}请直接发送计划，例如：\n` +
			"1. [inspect] 确认 API — fabric_docs_search\n" +
			"2. [write] src/main/java/com/example/my_mod/Handler.java — 功能实现\n" +
			"3. [write] src/main/java/com/example/my_mod/MyMod.java — 注册入口"
		);
	}

	private async buildProjectInfo(): Promise<string> {
		let projectInfo = "";
		const activePath = this.activeProjectPath();
		if (!activePath) return projectInfo;

		const projectPath = activePath;
		const listDirectory = (absPath: string) => window.api.listDirectory(absPath);
		projectInfo = `## 项目信息\n项目路径：${projectPath}\n`;
		if (this.projectProfile) {
			const profile = this.projectProfile;
			projectInfo += `ProjectProfile：Minecraft ${profile.minecraftVersion || "?"} · Yarn ${profile.yarnMappings || "?"} · Loader ${profile.loaderVersion || "?"} · Java ${profile.javaVersion || "?"}\n`;
			projectInfo += `Loom ${profile.loomVersion || "?"} · source sets ${profile.sourceSets.join(", ")} · splitEnvironment=${profile.splitEnvironment}\n`;
			projectInfo += `Mod ID：${profile.modId || "?"} · 入口点 ${[...profile.entrypoints.main, ...profile.entrypoints.client, ...profile.entrypoints.server].join(", ") || "?"}\n`;
			projectInfo += `可用 Gradle task：${profile.gradleTasks.join(", ")}\n`;
			if (profile.registeredSymbols.length > 0) projectInfo += `已有注册/实现：${profile.registeredSymbols.slice(0, 24).join("；")}\n`;
			if (profile.eventHandlers.length > 0) projectInfo += `已有事件处理器：${profile.eventHandlers.slice(0, 16).join("；")}\n`;
			if (!profile.symbolIndex.available) projectInfo += `本地 Yarn 符号索引不可用：${profile.symbolIndex.error || "未生成"}\n`;
		}

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

	// Build system prompt with Fabric knowledge (tool schemas travel with each request)
	private async buildSystemPrompt(mode: "chat" | "plan" | "execute"): Promise<string> {
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
- submit_plan 必须带 acceptanceContract：把用户需求拆为原子 requirement，每条带 sourceQuote、claim 和 build_success / game_assertion / user_confirmation 之一。Harness 只验证契约和新鲜证据，不替你指定业务类、Mixin、模型或 API。
- 多阶段交互测试使用断言的 afterAction 指定零基动作索引；同一状态的多次变化必须按检查点顺序声明。

计划必须精简：
- **禁止写构建/运行/测试步骤**。主机会自动在计划末尾追加：① 构建项目（gradlew build）② 启动游戏（runClient）③ 进入测试世界（mc_ensure_test_world + mc_ensure_cheats）④ 验证功能效果（mc_screenshot/mc_inspect）。Agent 只需写代码实现步骤（write/mixin/recipe/inspect）。
- **禁止空泛步骤**（确保无错、测试功能、输出总结）。
- **每步只做一件事**；最多 ${MAX_IMPLEMENTATION_PLAN_STEPS} 步（主机另行追加构建、启动和游戏测试）。
- **禁止重复步骤。**
- **不确定路径/类名时先 grep/read_file，禁止用 ask_clarification 代替勘察，禁止方案对比长文。**
- **用户已通过模板表单提交完整需求时，禁止先探索项目；直接输出计划。**
- **用户消息含【结构化参数 JSON】时，执行阶段须调用 \`fabric_template_generate\` 并传入完整 \`formFields\`（勿省略硬度、饱食度等表单参数）。**`
				: `## 第二阶段：执行计划

规则（优先级从高到低）：
1. 只执行当前步骤。不确定路径/类名/包名时先 read_file/grep；仅用户偏好才 ask_clarification，禁止猜需求。
2. 每轮必须调用工具。旁白不超过 2 句，只告知"当前在做什么"。禁止 Wait/Hmm 式反复自我否定与超长推理；想清后立即调工具。
3. 写完当前步骤所需全部文件后，调用 complete_step 标记完成，再进入下一步。
4. 每个连贯编译单元写入后由宿主自动静态校验和增量编译；不要重复 trigger_build 或 read_error_log。所有单元通过后才运行完整 build → runClient → test_design（读实现代码 → 设计沙盒 → mc_test_scenario 注册） → game_test（mc_run_test；PASS 才完成）。若用户要求重启后完整复测，必须在 mc_test_scenario 传 required_pass_count=2，Harness 会重启并用同一 scenarioId 从 setup 独立复测。
5. Mixin 必须依次使用 fabric_mixin_target_lookup → fabric_mixin_scaffold/edit_file → fabric_mixin_register → fabric_mixin_validate；配方必须用 create_recipe/fabric_recipe_generate 并取得校验证据；模板用 fabric_template_generate（必须传入 formFields）。
6. **GUI 布局预览强制要求：任何涉及 Screen/HUD/ConfigScreen 代码的步骤（无论是新建还是修改现有 GUI），必须先调用 gui_layout_preview 工具生成 HTML 布局预览供用户确认，拿到用户确认的布局 JSON 后才能编写/修改 GUI 代码。禁止跳过预览直接 edit_file/write_file GUI 代码。layoutType 选择：设置列表→option-list；自定义界面→custom-screen；HUD→hud-overlay。生成的 HTML 仅用于可视化布局，禁止包含 <button>、<input type="button">、onclick 事件或任何确认/取消按钮；确认/取消由外层 UI 统一提供。**
7. 禁止重复写同一文件、禁止用相同参数重复调用只读工具。
8. MC_PHASE:menu 只代表游戏启动成功，不代表功能测试通过。功能在游戏内的（HUD/方块/物品/实体/命令）必须走完整测试流程：① build → runClient 进入游戏② run 步完成后进入 test_design 步（读实现代码 → 选沙盒 preset → mc_test_scenario 注册含 sandbox/actions/assertions/acceptanceContract 的 V2 规格）③ game_test 步用注册好的 scenarioId 调用 mc_run_test。禁止仅凭 menu 宣称完成。禁止跳过 test_design 直接 mc_run_test。test_design 仅允许读代码/世界/注册场景，禁止写产品代码和 mc_run_test。feature_type 取值：new_item/new_block/new_recipe/entity_behavior/player_interaction/hud_gui。实体行为修改类功能必须用 mc_observe_entity 对比状态变化，禁止仅凭截图宣称完成。任务总结必须列出实际执行的验证工具调用和结果，禁止虚构验证结果。
9. ${isVisionCapableModel(this.apiConfig.model)
		? "验证策略：当前模型支持图片理解。功能测试时调用 mc_screenshot 截图，模型会直接分析截图验证功能效果。"
		: "验证策略：当前模型不支持图片理解。功能测试验证策略：① 优先使用 mc_inspect 获取结构化数据（界面类型、控件列表、玩家状态）进行数据化验证；② 仍需调用 mc_screenshot 截图（供总结展示和用户参考），但不要尝试从截图本身分析；③ 若 mc_inspect 无法验证的功能（如颜色/动画/渲染效果），在输出中明确标注\"需用户手动确认\"；④ 禁止声称\"测试通过\"而无客观证据（mc_inspect 数据或用户确认）。"}`;

		const extraRules = mode === "execute" ? "" : "\n- **仅需求歧义时可用 ask_clarification（短问题+短选项）；代码事实先勘察。**\n- **最多 3 句背景说明，然后直接列出步骤。** 禁止方案推演。";

		return `# ModCrafting AI 助手
${phaseHeader}

你是 Minecraft Fabric 模组开发助手。用中文回答。Java/JSON 代码保持英文。

## 可用工具
每个工具的用途、参数与只读/写入属性都随请求以 function schema 提供，此处不再重复列举。
按 schema description 选择工具；Mixin、配方、GUI 预览、游戏测试等强制流程见下方「重要规则」。

${mode === "plan" ? "## 当前：输出计划阶段\n需求歧义时可用 ask_clarification（短选项）；标识符用 grep/read_file 勘察，收集完后调用 submit_plan。" : "## 当前：执行阶段\n所有读写、增量编译和游戏测试都指向宿主创建的影子工作区。直接调用工具执行计划；修改已有文件优先 edit_file（先 read_file），新建用 write_file。写入连贯编译单元后宿主自动静态校验并增量编译，模型不要重复 trigger_build 或 read_error_log；BuildReport 的 diagnostic ID 是唯一修复入口。涉及 GUI/Screen/HUD 代码时必须先调用 gui_layout_preview 预览。严格最终验收通过后才原子 promote；冲突、预算、网络或中断进入可恢复 PAUSED。"}

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

	/**
	 * Refresh the live project-structure message.
	 *
	 * This is appended at the tail and only rewritten when its text actually changed.
	 * It used to sit at index 1 and be overwritten in place every execute round, which
	 * forked the serialized prefix and re-billed the entire conversation each turn.
	 */
	private refreshProjectInfoMessage(info: string): void {
		if (!info) return;
		const content = `${PROJECT_INFO_MESSAGE_PREFIX}\n${info}`;
		const index = this.messages.findIndex(isProjectInfoMessage);
		if (index === this.messages.length - 1 && this.messages[index].content === content) return;
		if (index >= 0) this.messages.splice(index, 1);
		this.messages.push({ role: "system", content, origin: "harness" });
	}

	/** 移除独立的 project-info system 消息（mode 切换时调用）。 */
	private removeProjectInfoMessage(): void {
		this.messages = this.messages.filter((m) => !isProjectInfoMessage(m));
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
		const result = await this.runForRole('coordinator', streamCb, {
			phase: "plan",
			emitLifecycle: true,
			turnMode: "chat",
			composerMode: this.composerMode
		});
		return result;
	}

	private async runExecutePhase(streamCb: (text: string, reasoning?: string) => void, options?: { forceFeatureGuiVerify?: boolean }): Promise<string> {
		if (!(await this.prepareExecutionWorkspace())) {
			this._phase = "execute";
			return "任务已暂停：基线工程或影子工作区不可用。发送「继续」可从检查点恢复。";
		}
		await this.updateSystemPrompt("execute");
		this._phase = "execute";
		this.planReadyAwaitingExecute = false;
		if (this.planTracker && this.planTracker.steps.length > 0) {
			this.planTracker.markRunning();
			this.emitPlanState(this.planTracker);
		}
		this.emitEvent({ kind: EventKind.Phase, phase: "execute_start" });
		this.onAgentStatus?.("执行中...");
		// Persist the transition before the first provider call.  If the renderer
		// is reloaded while the model is streaming, recovery resumes from the
		// serialized plan/影子工程 instead of inferring state from chat text.
		await this.saveHarnessCheckpoint("GENERATING", "generating");

		const requireFeatureGuiVerify = Boolean(options?.forceFeatureGuiVerify) || (Boolean(this.activeUserSymptom) && this.lastGuiFeatureSymptom);
		if (options?.forceFeatureGuiVerify) {
			this.ensureVerifyTargetForGui();
		}

		await this.maybeRunDebuggerBrief(streamCb);

		const result = await this.runForRole('implementer', streamCb, {
			phase: "execute",
			emitLifecycle: true,
			planTracker: this.planTracker,
			opsOnlyPlan: this.planTracker?.isOpsOnly() ?? false,
			requireInGameVerify: Boolean(this.activeUserSymptom) || Boolean(options?.forceFeatureGuiVerify),
			requireFeatureGuiVerify,
			verifyTarget: this.activeVerifyTarget
		});
		if (this.planTracker?.allDone()) {
			const delivered = await this.finalizeAtomicDelivery();
			if (!delivered) return `${result}\n\n候选工程已暂停，用户项目未接收未验收修改。发送「继续」恢复。`;
			this.executionWorkspace = null;
			this.executionProjectPath = null;
			this.projectProfile = null;
		} else {
			await this.saveHarnessCheckpoint("PAUSED", "compile_check", "WORKFLOW_INCOMPLETE");
		}
		this.maybeEmitSymptomConfirmNotice();
		// 任务完成且收集到截图时，发送任务总结截图事件
		this.emitTaskSummaryScreenshots();
		return this.maybeRunPostExecuteRoles(streamCb, result);
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
		// 自动追加测试步骤：启动与确定性验收是两个独立的宿主管理步骤。
		// 系统提示词声称"主机会自动追加 gradlew build 与 runClient"，这里真正实现追加逻辑。
		const appended = this.ensureTestVerificationSteps();
		if (appended > 0) {
			this.emitPlanState(this.planTracker);
			this.emitEvent({
				kind: EventKind.Notice,
				notice: {
					level: "info",
					text: `已自动追加 ${appended} 个测试步骤（启动游戏 / 确定性断言）。仅 PASS 可完成游戏测试。`
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
		const hasGameTest = steps.some((s) => /mc_run_test|确定性游戏测试/i.test(s.description));

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


		if (!hasGameTest) {
			pushStep("执行确定性游戏测试（mc_test_scenario 生成含客观 assertions 的场景 → mc_run_test；INCONCLUSIVE 由 Harness 自动进入契约修订、环境恢复或专用视觉审核）");
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
		// Keep an explicit test request feature-neutral. It used to manufacture an
		// F6 GUI target here, which made item/block tests wander into unrelated UI.
		const deterministicOnly = true;
		if (deterministicOnly) {
			this.lastPlanCandidate = null;
			this.planReadyAwaitingExecute = false;
			await this.updateSystemPrompt("execute");
			this._phase = "execute";
			this.planTracker = PlanTracker.fromSteps([
				{ id: "1", description: "启动游戏客户端与桥接（runClient）", status: "pending" },
				{ id: "2", description: "执行确定性游戏测试（mc_test_scenario → mc_run_test；仅 PASS 完成）", status: "pending" }
			]).markSynthetic();
			this.emitPlanState(this.planTracker);
			this.emitEvent({ kind: EventKind.Phase, phase: "plan_done", text: "启动客户端后，按实际功能类型生成带客观 assertions 的 V2 场景，并由 mc_run_test 裁决。", planActionable: true });
			this.messages.push({
				role: "user",
				content: [
					"用户请求游戏内测试。禁止 submit_plan、默认 F6、截图即通过或仅凭命令发送即通过。",
					"先启动客户端并进入 ModCrafting Test World；再按实际功能分类调用 mc_test_scenario，提供 concrete subject_id/hotkey、客观 assertions 和 acceptanceContract，最后调用 mc_run_test。组合项目若要求重启后完整复测，传 required_pass_count=2。只有达到所需独立 PASS 次数才完成；INCONCLUSIVE 由 Harness 按原因自动修订测试契约、恢复环境或进入专用视觉审核，禁止通用澄清和误改产品代码。",
					buildUserSymptomBlock(this.activeUserSymptom)
				].filter(Boolean).join("\n\n"),
				origin: "harness",
				taskId: this.taskId,
				phase: "execute"
			});
			this.messages.push({
				role: "system",
				content: "游戏测试 INCONCLUSIVE 由 Harness 自动分类：测试契约缺陷进入 Evidence Repair，Observer/世界问题自动恢复最多两次，纯视觉项目进入专用审核卡；禁止把这些状态转换为通用澄清或等待用户补写断言。",
				origin: "harness",
				taskId: this.taskId,
				phase: "execute"
			});
			const result = await this.runExecutePhase(streamCb, { forceFeatureGuiVerify: false });
			this.releaseIncompleteSyntheticPlan();
			return result;
		}
		// An explicit in-game test is not implicitly a GUI/F6 test. The scenario
		// must name a concrete feature and include V2 assertions.
		this.activeVerifyTarget = null;
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
		const result = await this.runExecutePhase(streamCb, { forceFeatureGuiVerify: false });
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
		this.turnDelegationCount = 0;
		try {
		await this.ensureProjectProfile();
		const taskBudgetReason = this.executionWorkspace ? this.taskBudgetReason() : null;
		if (taskBudgetReason) {
			await this.saveHarnessCheckpoint("PAUSED", "compile_check", "TASK_BUDGET_EXHAUSTED");
			const paused = `[HARNESS_PAUSED:budget] ${taskBudgetReason}。候选工程已保留；可发送「继续」查看检查点，或开始新任务。`;
			this.emitEvent({ kind: EventKind.Notice, notice: { level: "warn", text: paused } });
			return paused;
		}

		const inputText = contentPartsAsClassifyText(input);

		this.onAgentStatus?.("意图分类...");
		const routerConfig = await this.modelConfigForRole('router');
		const classifierInvocationId = `router_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
		const classifierStartedAt = Date.now();
		this.emitModelInvocation({ invocationId: classifierInvocationId, roleId: 'router', providerId: routerConfig.ref.providerId, modelId: routerConfig.ref.modelId, phase: 'start', startedAt: classifierStartedAt, status: 'running' });
		let classified: ClassifyUserTurnResult;
		try {
			classified = await classifyUserTurn({
				apiConfig: routerConfig,
				input: inputText,
				ctx: this.intentContext(),
				stickySymptom: this.activeUserSymptom,
				abortSignal: this.abortController.signal
			});
			this.emitModelInvocation({ invocationId: classifierInvocationId, roleId: 'router', providerId: routerConfig.ref.providerId, modelId: routerConfig.ref.modelId, phase: 'end', startedAt: classifierStartedAt, endedAt: Date.now(), status: 'completed' });
		} catch (error) {
			this.emitModelInvocation({ invocationId: classifierInvocationId, roleId: 'router', providerId: routerConfig.ref.providerId, modelId: routerConfig.ref.modelId, phase: 'end', startedAt: classifierStartedAt, endedAt: Date.now(), status: 'failed', error: String(error) });
			throw error;
		}
		if (classified.diagnostics) {
			this.classifierDiagnostics = [...this.classifierDiagnostics, classified.diagnostics].slice(-30);
		}
		this.applyClassificationSideEffects(classified, inputText);
		const intent = classified.intent;
		this.lastTurnMode = intent === "plan_only" ? "plan_only" : intent;
		this.routeDecision = await this.resolveRouteDecisionHybrid(inputText, intent === 'plan_only' ? 'plan_only' : intent);
		this.emitEvent({ kind: EventKind.Collaboration, routeDecision: this.routeDecision });
		for (const delegation of this.routeDecision.delegations) {
			if (delegation.roleId === 'router') continue;
			const preset = this.routingConfig && this.routingSelection?.mode === 'routed'
				? findRoutingPreset(this.routingConfig, this.routingSelection.customPresetId || this.routingSelection.strategyId)
				: undefined;
			const difficulty = this.routeDecision.difficulty;
			const binding = preset?.roles[delegation.roleId];
			const resolved = binding ? resolveBindingForDifficulty(binding, difficulty) : null;
			const model = resolved ? this.withUserModelPreference(delegation.roleId, resolved.primary) : { providerId: this.apiConfig.providerId || 'custom', modelId: this.apiConfig.model };
			this.recordCollaboration({ id: `queued_${delegation.id}`, roleId: delegation.roleId, providerId: model.providerId, modelId: model.modelId, status: 'queued', summary: delegation.reason });
		}

		if (options.pushUser) {
			this.messages.push({ role: "user", content: input, origin: "user", taskId: this.taskId });
		}
		if (this.roleIsActive('visualReviewer')) {
			try {
				const vision = await this.modelConfigForRole('visualReviewer');
				this.recordCollaboration({
					id: `visual_gate_${Date.now().toString(36)}`,
					roleId: 'visualReviewer',
					providerId: vision.ref.providerId,
					modelId: vision.ref.modelId,
					status: 'completed',
					startedAt: Date.now(),
					endedAt: Date.now(),
					summary: '视觉审查模型可用'
				});
			} catch (error) {
				const message = `UI / GUI 任务需要可用的视觉审查模型。${error instanceof Error ? error.message : String(error)}`;
				this.emitEvent({ kind: EventKind.Notice, notice: { level: 'error', text: message } });
				return message;
			}
		}
		this.onAgentStatus?.("思考中...");

		let planStreamReasoning = "";
		let planStreamText = "";
		const streamCb = (text: string, reasoning?: string) => {
			if (text) planStreamText = text;
			if (reasoning) planStreamReasoning = reasoning;
			this.onStreamUpdate?.(text, reasoning);
		};

			if (classified.usedFallback) {
				const detail = classified.diagnostics
					? `${classified.diagnostics.providerId}/${classified.diagnostics.model} ${classified.diagnostics.failureCode}` +
						(classified.diagnostics.httpStatus ? ` (HTTP ${classified.diagnostics.httpStatus})` : "")
					: classified.rationale;
				this.emitEvent({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: `意图分类失败，已用结构规则继续：${detail}`
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
				// 「继续」优先恢复未完成的执行计划（包括 PAUSED/failed step），
				// 不再根据聊天文本重新推断工作区和修复状态。
				const checkpointNeedsFinalization = Boolean(this.pendingCheckpoint && ["final_build", "final_game", "promote", "complete"].includes(this.pendingCheckpoint.stage));
				if (this.planTracker && (!this.planTracker.allDone() || checkpointNeedsFinalization)) {
					this.resumeCheckpointRequested = true;
					const result = await this.beginExecuteFromTracker(streamCb);
					this.onAgentStatus?.("");
					return result;
				}
				if (isNarrowResumeInput(inputText) && this.restorePlanFromCheckpoint()) {
					const result = await this.beginExecuteFromTracker(streamCb);
					this.onAgentStatus?.("");
					return result;
				}
				this.resumeCheckpointRequested = isNarrowResumeInput(inputText);
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

			if (this.routeDecision?.taskTemplateId === 'knowledge' && (effectiveIntent === 'develop' || effectiveIntent === 'plan_only')) {
				const result = await this.runKnowledgeTurn(streamCb);
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

				await this.maybeRunExplorerBrief(streamCb);

				const planResult = await this.runForRole('planner', streamCb, {
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
								"不要输出编号文字或 Markdown 计划。必须调用 submit_plan，并传入 steps、acceptanceContract 与完整 gameTest。\n" +
								`steps 的 kind 必须是 write、recipe、mixin 或 inspect；每项必须包含 targetPath（或 targetPaths）与 evidence，最多 ${MAX_IMPLEMENTATION_PLAN_STEPS} 步。\n` +
								"acceptanceContract 必须覆盖每个用户需求；gameTest 必须包含可执行 actions，客观断言放在 acceptanceContract 的 game_assertion 中；不要写构建/运行步骤。"
						});
						this.onAgentStatus?.("重新生成计划...");
						planStreamReasoning = "";
						planStreamText = "";
						const retryResult = await this.runForRole('planner', streamCb, { phase: "plan", emitLifecycle: false, turnMode: intent, composerMode: this.composerMode });
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
			if (incompletePlan && this.executionWorkspace) {
				await this.saveHarnessCheckpoint("PAUSED", "compile_check", errMsg);
			}
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
		this.resumeCheckpointRequested = true;
		this.agent.resetRunState();

		return this.runTurn(lastUser.content, { pushUser: false });
	}

	/** Resume execution after a clarification question was answered. */
	async answerClarification(answer: string): Promise<string> {
		// A clarification event is emitted as soon as the tool resolves, slightly
		// before the originating agent turn has necessarily unwound.  UI and
		// automation can therefore answer in that short window.  Do not silently
		// discard a valid answer just because the prior turn is still settling.
		const settleDeadline = Date.now() + 5_000;
		while (this._running && Date.now() < settleDeadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		if (this._running || !this.agent.clarificationPending) return "";

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

				const planResult = await this.runForRole('planner', streamCb, { phase: "plan", emitLifecycle: false, turnMode: "develop", composerMode: this.composerMode });

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
			const result = await this.runForRole('implementer', streamCb, {
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
		}
	}

	cancel(): void {
		// Interactive tools intentionally have no wall-clock timeout; cancellation must
		// settle their resolver before aborting the rest of the execution tree.
		this.cancelAllPendingGuiLayouts();
		if (this.abortController) {
			this.abortController.abort();
			this._running = false;
			this.agent.clarificationPending = false;
			if (this.executionWorkspace && this.planTracker && !this.planTracker.allDone()) {
				void this.saveHarnessCheckpoint("PAUSED", "compile_check", "USER_CANCELLED");
			}
			logger.agent("Turn cancelled");
		}
	}

	approve(id: string, allow: boolean): void {
		if (this.pendingApproval && this.pendingApproval.id === id) {
			this.pendingApproval.resolve(allow);
			this.pendingApproval = null;
		}
	}

	/**
	 * Resolve the dedicated visual-review card. This is intentionally separate
	 * from answerClarification: a visual decision records user_confirmation and
	 * resumes the current game-test step without sending a free-form user
	 * message back to the model.
	 */
	async resolveVisualReview(id: string, decision: "accepted" | "rejected"): Promise<string> {
		if (decision !== "accepted" && decision !== "rejected") throw new Error("invalid_visual_review_decision");
		const settleDeadline = Date.now() + 5_000;
		while (this._running && Date.now() < settleDeadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		const pending = this.pendingVisualReview;
		if (!pending || pending.reviewId !== id) throw new Error("visual_review_not_pending");
		if (!this.planTracker) throw new Error("visual_review_plan_unavailable");
		const step = this.planTracker.steps.find((candidate) => candidate.kind === "game_test" && candidate.gameTest?.id === pending.scenarioId);
		if (!step?.gameTest) throw new Error("visual_review_scenario_unavailable");

		const updated = registerGameTestSpec({
			...step.gameTest,
			visualReviewDecision: decision,
			visualReviewEvidence: {
				decision,
				prompt: pending.reviewPrompt || pending.message,
				...(pending.reviewScreenshot ? {
					screenshotToolId: pending.reviewScreenshot.toolId,
					capturedAt: pending.reviewScreenshot.capturedAt
				} : {}),
				reviewedAt: Date.now()
			}
		});
		if (!updated.ok) throw new Error(`visual_review_persist_failed: ${updated.error}`);
		step.gameTest = updated.spec;
		step.status = "running";
		this.pendingVisualReview = null;
		this.emitPlanState(this.planTracker);

		if (decision === "rejected") {
			try {
				if (typeof window !== "undefined" && window.api?.mcStopAll) await window.api.mcStopAll();
			} catch {
				// Product repair remains actionable even if the old client is already down.
			}
			this.emitEvent({
				kind: EventKind.GameTestStatus,
				gameTestStatus: {
					...pending,
					state: "product_repair",
					code: "VISUAL_REVIEW_REQUIRED",
					responsibility: "visual_review",
					reviewDecision: "rejected",
					message: "视觉审核拒绝，正在进入产品修复；修复后将重建、重启并重新执行客观测试。"
				}
			});
		} else {
			this.emitEvent({
				kind: EventKind.GameTestStatus,
				gameTestStatus: {
					...pending,
					reviewDecision: "accepted",
					message: "视觉审核已接受，已记录 user_confirmation 证据；正在推进当前测试步骤。"
				}
			});
		}
		return this.retryExecuteTurn();
	}

	/** GUI 布局预览：触发预览面板并阻塞工具 Promise，等待用户确认/取消。 */
	private handleGuiLayoutPreview(payload: {
		id: string;
		title: string;
		layoutType: import("./events.ts").GuiLayoutType;
		html: string;
		elements: import("./events.ts").GuiLayoutElement[];
	}): Promise<string> {
		// 并发控制：若已有 pending 预览，自动取消旧的
		for (const [oldId, resolver] of this.pendingGuiLayoutResolvers.entries()) {
			if (oldId !== payload.id) {
				this.pendingGuiLayoutResolvers.delete(oldId);
				resolver('{"cancelled": true}');
			}
		}

		return new Promise<string>((resolve) => {
			this.approvedGuiLayoutIds.add(payload.id);
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
			try {
				const parsed = JSON.parse(layoutJson) as Record<string, unknown>;
				if (!this.approvedGuiLayoutIds.has(id) || parsed.approvalId !== id) {
					resolver(JSON.stringify({ cancelled: true, feedback: '布局批准记录缺少不可伪造的 approvalId/layoutFingerprint，请重新确认布局。' }));
					this.pendingGuiLayoutResolvers.delete(id);
					this.approvedGuiLayoutIds.delete(id);
					if (this.pendingGuiLayoutResolvers.size === 0) this.guiLayoutPending = false;
					return;
				}
				// The renderer may include a convenience fingerprint, but the host is
				// the authority. Recompute it from the approved payload before
				// persisting or returning the record so a spoofed fingerprint cannot
				// bind a scenario to a different layout oracle.
				const hostFingerprint = computeApprovedLayoutFingerprint({
					layoutType: parsed.layoutType,
					canvasWidth: parsed.canvasWidth,
					canvasHeight: parsed.canvasHeight,
					elements: parsed.elements
				});
				const approved = registerApprovedLayoutRecord({
					approvalId: id,
					layoutFingerprint: hostFingerprint,
					layoutType: parsed.layoutType,
					canvasWidth: parsed.canvasWidth,
					canvasHeight: parsed.canvasHeight,
					elements: Array.isArray(parsed.elements) ? parsed.elements : [],
					approvedAt: Date.now()
				});
				if (!approved.ok) {
					resolver(JSON.stringify({ cancelled: true, feedback: approved.error }));
					this.pendingGuiLayoutResolvers.delete(id);
					this.approvedGuiLayoutIds.delete(id);
					if (this.pendingGuiLayoutResolvers.size === 0) this.guiLayoutPending = false;
					return;
				}
			} catch {
				resolver(JSON.stringify({ cancelled: true, feedback: '布局批准记录不是有效 JSON，请重新确认布局。' }));
				this.pendingGuiLayoutResolvers.delete(id);
				this.approvedGuiLayoutIds.delete(id);
				if (this.pendingGuiLayoutResolvers.size === 0) this.guiLayoutPending = false;
				return;
			}
			this.pendingGuiLayoutResolvers.delete(id);
			this.approvedGuiLayoutIds.delete(id);
			if (this.pendingGuiLayoutResolvers.size === 0) {
				this.guiLayoutPending = false;
			}
			// Return the canonical host-owned fingerprint to the agent. This is
			// intentionally a new JSON object rather than the untrusted UI string.
			const canonical = JSON.parse(layoutJson) as Record<string, unknown>;
			canonical.layoutFingerprint = getApprovedLayoutRecord(id)?.layoutFingerprint ?? computeApprovedLayoutFingerprint(canonical);
			resolver(JSON.stringify(canonical));
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
		this.approvedGuiLayoutIds.clear();
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
		this.classifierDiagnostics = [];
		this.providerProtocolDiagnostics = [];
		this.agent.resetRunState();
		this.agent.clarificationPending = false;
		this.pendingVisualReview = null;
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
			`- Provider 协议诊断数：${this.providerProtocolDiagnostics.length}`,
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
		if (this.providerProtocolDiagnostics.length > 0) {
			lines.push("---", "", "## Provider 工具协议诊断", "", JSON.stringify(this.providerProtocolDiagnostics, null, 2), "");
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

	getClassifierDiagnosticsSnapshot(): ClassifierDiagnostics[] {
		return this.classifierDiagnostics.map((entry) => ({ ...entry }));
	}

	getProviderProtocolDiagnosticsSnapshot(): ProviderProtocolDiagnostic[] {
		return this.providerProtocolDiagnostics.map((entry) => ({ ...entry }));
	}

	/** Sanitized state for the local automation bridge; never exposes API keys. */
	getAutomationSnapshot(): Record<string, unknown> {
		return {
			running: this._running,
			phase: this._phase,
			projectPath: this._projectPath,
			composerMode: this.composerMode,
			planReady: this.planReadyAwaitingExecute,
			lastTurnMode: this.lastTurnMode,
			messages: this.messages.map((message) => ({
				role: message.role,
				name: message.name,
				content: contentAsText(message.content).slice(0, 12_000)
			})),
			planSteps: this.planTracker?.steps.map((step) => ({ ...step })) || [],
			classifierDiagnostics: this.getClassifierDiagnosticsSnapshot()
		};
	}

	restoreSnapshot(messages: ChatMessage[]): void {
		for (const message of messages) hydrateGameTestSpecsFromText(contentAsText(message.content));
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
			kind?: "inspect" | "write" | "recipe" | "mixin" | "build" | "run" | "game_test";
			targetPath?: string;
			targetPaths?: string[];
			evidence?: string;
			gameTest?: GameTestSpec;
		}>
	): void {
		if (!steps || steps.length === 0) {
			this.planTracker = null;
			return;
		}
		const restoredSteps = steps.map((step) => {
			if (!step.gameTest) return step;
			const restored = registerGameTestSpec(step.gameTest);
			if (restored.ok) return { ...step, gameTest: restored.spec };
			// Legacy sessions may contain an empty/invalid spec. Do not register a
			// phantom scenario or resume a completed step with unverifiable evidence;
			// keep the game_test step runnable so the planner can generate a fresh V2
			// scenario through the internal Evidence Repair path.
			return {
				...step,
				status: step.status === "completed" ? "running" : step.status,
				gameTest: undefined,
				evidence: `${step.evidence || "V2 GameTestSession verdict=PASS"}\n[系统] 已丢弃遗留无效游戏测试规格：${restored.error}`
			};
		});
		// Canonicalization migrates the old inspect/game-test bug before resuming.
		this.planTracker = PlanTracker.fromSteps(
			canonicalizePlanSteps(restoredSteps.map((step) => ({
				...step,
				status: step.status === "completed" ? ("completed" as const) : step.status === "running" ? ("running" as const) : step.status === "error" ? ("error" as const) : ("pending" as const)
			})))
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
