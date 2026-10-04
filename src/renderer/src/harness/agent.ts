// ======== Agent ========
// Reasonix-style agent loop: stream → tool calls → execute → loop
// Features: readonly-tool round limit, clean message history, kick mechanism

import type { Sink, Event } from "./events.ts";
import { EventKind } from "./events.ts";
import { type Registry, executeBatch, parseToolCalls, type ToolContext, type ToolResult } from "./tools.ts";
import { FileSession } from "./file-session.ts";
import type { PlanTracker } from "./plan-tracker.ts";
import { normalizeWorkflowSteps } from "./plan-normalizer.ts";
import { WorkflowEngine } from "./workflow-engine.ts";
import { finalizeTerminalSteps } from "./finalize-terminal.ts";
import type { VerifyTarget } from "./verify-target.ts";
import { logger } from "../utils/logger.ts";
import { isRepeatGuardedToolCall } from "./repeat-guard.ts";
import { prepareMessages, estimatePromptTokens, warnTokenThreshold, DEFAULT_CONTEXT_WINDOW, RECENT_WINDOW, type CompactionResult } from "./context-compact.ts";
import { MAX_EXECUTE_CLARIFICATIONS } from "./clarify-validation.ts";
import { appendToolRoundHistory, isVisionCapableModel, withoutReasoningEcho, type ChatMessage, type ModelToolCall } from "./chat-message.ts";
import { MAX_FETCH_RETRIES, fetchRetryDelayMs, isReasoningContinuityError, isRetryableFetchError, sleep } from "./fetch-retry.ts";
import { validateToolCalls } from "./tool-call-validator.ts";
import { MAX_PLAN_OFFERED_REJECT_ROUNDS, MAX_READONLY_ROUNDS, PLAN_EXPLORATION_LOCK_KICK, PLAN_SUBMIT_NUDGE, isPlanPostLockTool, shouldNudgePlanSubmit } from "./plan-phase-gate.ts";
import { isExploreTool, planToolNames } from "./tool-policy.ts";
import { getModelContextWindow } from "../../../shared/llm-providers.ts";
import { LONG_REASONING_KICK, MAX_REASONING_HARD_CHARS, MAX_REASONING_SOFT_CHARS } from "./reasoning-limits.ts";
import { stripThinkTags, stripMinimaxProtocolTokens, extractPlanFromXml, buildSubmitPlanArgs, ThinkTagStreamFilter } from "./model-output-normalizer.ts";
import { rejectedToolCallSignature } from "./tool-rejection-guard.ts";
import type { BuildReport, ProjectProfile, RepairProposal } from "../../../shared/harness-runtime.ts";
import type { LlmProtocol, ProviderProtocolDiagnostic } from "../../../shared/harness-runtime.ts";
import { createModelAdapter } from "./model-adapter.ts";
import { ToolCallAssembler } from "./tool-call-assembler.ts";
import { createActiveToolSnapshot } from "./active-tool-snapshot.ts";

export { isRepeatGuardedToolCall } from "./repeat-guard.ts";
export type { ChatMessage } from "./chat-message.ts";
export { MAX_PLAN_OFFERED_REJECT_ROUNDS, MAX_PLAN_SUBMIT_NUDGE_ROUNDS, MAX_READONLY_ROUNDS, PLAN_SUBMIT_NUDGE, shouldNudgePlanSubmit } from "./plan-phase-gate.ts";
export { LONG_REASONING_KICK, MAX_REASONING_HARD_CHARS, MAX_REASONING_SOFT_CHARS } from "./reasoning-limits.ts";

let _toolCallIdCounter = 0;
let _modelInvocationIdCounter = 0;

export interface AgentOptions {
	registry: Registry;
	sink: Sink;
	maxSteps?: number;
	onToolDispatch?: (name: string, id: string) => void;
	onToolResult?: (name: string, id: string, output: string) => void;
	/** GUI 布局预览回调（Promise 阻塞模式）。由 Controller 提供，Agent 透传到 ToolContext。 */
	onGuiLayoutPreview?: (payload: { id: string; title: string; layoutType: import("./events.ts").GuiLayoutType; html: string; elements: import("./events.ts").GuiLayoutElement[] }) => Promise<string>;
	/** 步骤切换/修复模式进入时清理未确认的 GUI 布局预览 */
	onCancelPendingGuiLayouts?: () => void;
	/**
	 * Audit every outbound model HTTP request, including context-compaction and
	 * bounded retry requests.  Controller attaches the current role/provider
	 * identity before forwarding the event to the persistent Harness event log.
	 */
	onModelInvocation?: (event: {
		invocationId: string;
		modelId: string;
		phase: "start" | "end";
		startedAt: number;
		endedAt?: number;
		status?: "running" | "completed" | "failed";
		error?: string;
	}) => void;
	/** Host-owned repair accounting; invoked once for each new diagnostic
	 * proposal, independently of the model/provider that produced it. */
	onRepairProposal?: (proposal: RepairProposal) => void;
	onProviderProtocolDiagnostic?: (diagnostic: ProviderProtocolDiagnostic) => void;
}

export interface RunOptions {
	phase?: "plan" | "execute";
	emitLifecycle?: boolean;
	planTracker?: PlanTracker | null;
	opsOnlyPlan?: boolean;
	turnMode?: "chat" | "develop" | "plan_only" | "resume";
	composerMode?: "agent" | "plan" | "ask";
	/** Sticky user symptom: run step needs mc_inspect/mc_screenshot after ready. */
	requireInGameVerify?: boolean;
	/** GUI/preview symptoms: TitleScreen-only inspect does not count. */
	requireFeatureGuiVerify?: boolean;
	/** Explicit screen match target for in-game verification. */
	verifyTarget?: VerifyTarget | null;
	projectProfile?: ProjectProfile | null;
	previousBuildReport?: BuildReport | null;
	knowledgeFacts?: Array<{ key: string; value: string }>;
	providerId?: string;
	protocol?: LlmProtocol;
}

const REPEAT_SUCCESS_THRESHOLD = 2;
const MAX_FINAL_READINESS_BLOCKS = 3;
const CONTROL_TOOL_NAMES = ["complete_step"];
const PLAN_READONLY_TOOL_NAMES = new Set(planToolNames());

function stableStringify(args: Record<string, unknown>): string {
	const keys = Object.keys(args).sort();
	const sorted: Record<string, unknown> = {};
	for (const k of keys) sorted[k] = args[k];
	return JSON.stringify(sorted);
}

function repeatSuccessSignature(name: string, args: Record<string, unknown>): string {
	return `${name}\0${stableStringify(args)}`;
}

export class Agent {
	private registry: Registry;
	private sink: Sink;
	maxSteps: number;
	onToolDispatch?: (name: string, id: string) => void;
	onToolResult?: (name: string, id: string, output: string) => void;
	onGuiLayoutPreview?: (payload: { id: string; title: string; layoutType: import("./events.ts").GuiLayoutType; html: string; elements: import("./events.ts").GuiLayoutElement[] }) => Promise<string>;
	onCancelPendingGuiLayouts?: () => void;
	onModelInvocation?: AgentOptions["onModelInvocation"];
	onRepairProposal?: AgentOptions["onRepairProposal"];
	onProviderProtocolDiagnostic?: AgentOptions["onProviderProtocolDiagnostic"];
	private activeProviderId?: string;
	private activeProtocol?: LlmProtocol;
	private protocolFailureSignature = "";
	private protocolFailureStreak = 0;
	private xmlFallbackActive = false;
	private xmlFallbackUsed = false;
	// Once locked, readonly tools stay removed for the entire run
	private readonlyLocked = false;
	/** Plan phase: exploration tools stripped after readonly round cap. */
	private planExplorationLocked = false;
	/** Plan phase: escalate to submit_plan-only after repeated tool_not_offered. */
	private planOfferedRejectRounds = 0;
	private planForceSubmitOnly = false;
	/** Plan phase: text-only replies nudged toward submit_plan. */
	private planSubmitNudgeRounds = 0;
	private lastRejectedToolSignature = "";
	private consecutiveSameRejectedToolRounds = 0;

	// Track written files to detect duplicate writes
	private writtenFiles = new Map<string, string>();
	private consecutiveWriteOnlyRounds = 0;
	private repeatSuccessCounts = new Map<string, number>();
	private finalReadinessBlocks = 0;
	private graceRound = false;
	clarificationPending = false;
	/** Successful ask_clarification pauses this run (execute capped). */
	private clarificationCount = 0;
	// Rounds where every tool call was rejected by the loop guard (no progress)
	private consecutiveBlockedRounds = 0;
	// Rounds where the model only called complete_step without any real work
	private consecutiveStepDoneOnlyRounds = 0;
	// Rounds where model outputs mostly reasoning (>80%) with no tool calls
	private consecutiveReasoningOnlyRounds = 0;
	// Rounds with no file writes and no build/run progress
	private consecutiveIdleRounds = 0;
	private runLifecycleMeta: Pick<RunOptions, "turnMode" | "composerMode"> = {};
	/** 最近一次 runWorkflow 收集的 mc_screenshot 截图（供 Controller 任务总结使用） */
	lastCollectedScreenshots: Array<{ base64: string; mimeType: string; toolId: string; timestamp: number }> = [];
	// Context compaction
	private assistantTurnCount = 0;
	compactionTranscripts: CompactionResult[] = [];
	/** ACI: files read this agent run (read-before-edit) */
	private fileSession = new FileSession();

	constructor(opts: AgentOptions) {
		this.registry = opts.registry;
		this.sink = opts.sink;
		this.maxSteps = opts.maxSteps ?? 0; // 0 = unlimited
		this.onToolDispatch = opts.onToolDispatch;
		this.onToolResult = opts.onToolResult;
		this.onGuiLayoutPreview = opts.onGuiLayoutPreview;
		this.onCancelPendingGuiLayouts = opts.onCancelPendingGuiLayouts;
		this.onModelInvocation = opts.onModelInvocation;
		this.onRepairProposal = opts.onRepairProposal;
		this.onProviderProtocolDiagnostic = opts.onProviderProtocolDiagnostic;
	}

	setRegistry(registry: Registry): void {
		this.registry = registry;
	}

	resetRunState(): void {
		this.readonlyLocked = false;
		this.planExplorationLocked = false;
		this.planOfferedRejectRounds = 0;
		this.planForceSubmitOnly = false;
		this.planSubmitNudgeRounds = 0;
		this.lastRejectedToolSignature = "";
		this.consecutiveSameRejectedToolRounds = 0;
		this.writtenFiles.clear();
		this.consecutiveWriteOnlyRounds = 0;
		this.repeatSuccessCounts.clear();
		this.finalReadinessBlocks = 0;
		this.graceRound = false;
		this.consecutiveBlockedRounds = 0;
		this.consecutiveStepDoneOnlyRounds = 0;
		this.consecutiveReasoningOnlyRounds = 0;
		this.consecutiveIdleRounds = 0;
		this.protocolFailureSignature = "";
		this.protocolFailureStreak = 0;
		this.xmlFallbackActive = false;
		this.xmlFallbackUsed = false;
		this.clarificationPending = false;
		this.clarificationCount = 0;
		this.assistantTurnCount = 0;
		this.compactionTranscripts = [];
		this.fileSession.clear();
	}

	/** Clear only transport/protocol recovery state when Controller switches to
	 * another configured provider; plan, file-session and repair state remain. */
	resetProviderProtocolState(): void {
		this.protocolFailureSignature = "";
		this.protocolFailureStreak = 0;
		this.xmlFallbackActive = false;
		this.xmlFallbackUsed = false;
	}

	private updateProtocolRecovery(
		apiModel: string,
		rawToolCalls: ModelToolCall[],
		protocolDiagnostics: ProviderProtocolDiagnostic[]
	): {
		protocolOnlyFailure: boolean;
		fallbackActivated: boolean;
		paused: boolean;
		reason?: string;
	} {
		const protocolOnlyFailure = protocolDiagnostics.length > 0 && rawToolCalls.length > 0 && rawToolCalls.every((call) => Boolean(call.failureKind));
		if (!protocolOnlyFailure) {
			// A valid native call or a text/XML call closes the previous protocol
			// failure streak.  A later failure must earn its own two retries.
			if (protocolDiagnostics.length === 0 || rawToolCalls.some((call) => !call.failureKind)) {
				this.protocolFailureSignature = "";
				this.protocolFailureStreak = 0;
			}
			return { protocolOnlyFailure, fallbackActivated: false, paused: false };
		}

		const signature = protocolDiagnostics
			.map((diagnostic) => `${diagnostic.kind}:${diagnostic.providerIndex ?? diagnostic.providerCallId ?? diagnostic.toolName ?? ''}`)
			.sort()
			.join('|');
		this.protocolFailureStreak = signature === this.protocolFailureSignature ? this.protocolFailureStreak + 1 : 1;
		this.protocolFailureSignature = signature;

		if (this.protocolFailureStreak >= 2 && !this.xmlFallbackActive && !this.xmlFallbackUsed) {
			this.xmlFallbackActive = true;
			this.xmlFallbackUsed = true;
			const fallbackDiagnostic: ProviderProtocolDiagnostic = {
				id: `fallback:xml:${Date.now()}`,
				providerId: this.activeProviderId,
				modelId: apiModel,
				protocol: this.activeProtocol,
				kind: 'fallback',
				message: 'native tool stream failed twice; XML fallback activated',
				fallback: 'xml',
				createdAt: Date.now()
			};
			this.onProviderProtocolDiagnostic?.(fallbackDiagnostic);
			return { protocolOnlyFailure, fallbackActivated: true, paused: false };
		}

		if (this.xmlFallbackActive && this.xmlFallbackUsed && this.protocolFailureStreak >= 3) {
			return {
				protocolOnlyFailure,
				fallbackActivated: false,
				paused: true,
				reason: protocolDiagnostics.map((diagnostic) => diagnostic.message).join('; ')
			};
		}
		return { protocolOnlyFailure, fallbackActivated: false, paused: false };
	}

	private checkRepeatedSuccessBlock(name: string, args: Record<string, unknown>): string | null {
		if (!isRepeatGuardedToolCall(name, args)) return null;
		const sig = repeatSuccessSignature(name, args);
		const count = this.repeatSuccessCounts.get(sig) ?? 0;
		if (count < REPEAT_SUCCESS_THRESHOLD) return null;
		return `blocked: [loop guard] "${name}" 已用相同参数成功执行 ${count} 次。` + `请换用当前步骤所需的其他工具，勿重复执行。`;
	}

	private recordRepeatSuccess(name: string, args: Record<string, unknown>, hadError: boolean): void {
		if (hadError || !isRepeatGuardedToolCall(name, args)) return;
		const sig = repeatSuccessSignature(name, args);
		this.repeatSuccessCounts.set(sig, (this.repeatSuccessCounts.get(sig) ?? 0) + 1);
	}

	private filterExplorationTools(
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
	): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
		return tools.filter((t) => !isExploreTool(t.name, this.registry.policyFor(t.name)));
	}

	private filterControlTools(
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
	): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
		return tools.filter((t) => !CONTROL_TOOL_NAMES.includes(t.name));
	}

	private emit(e: Event): void {
		this.sink.emit(e);
	}

	/**
	 * Working context window for the active model. The provider id must participate:
	 * without it a catalog model misses the registry and fell back to 128k, which set
	 * the auto-compact threshold to ~64k and compacted the history almost every round.
	 */
	private contextWindowFor(model: string): number {
		return getModelContextWindow(model, this.activeProviderId) ?? DEFAULT_CONTEXT_WINDOW;
	}

	private async prepareApiMessages(messages: ChatMessage[], endpoint: string, apiKey: string, model: string, abortSignal?: AbortSignal): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
		const prepared = await prepareMessages(
			messages,
			this.assistantTurnCount,
			{ contextWindow: this.contextWindowFor(model) },
			async (summaryMessages) => {
				let text = "";
				await this.streamFromAPI(
					endpoint,
					apiKey,
					model,
					summaryMessages,
					[],
					abortSignal,
					(chunk) => {
						if (chunk) text += chunk;
					},
					2048
				);
				return { text };
			},
			(result) => {
				this.compactionTranscripts.push(result);
				const afterMsgs = 2 + Math.min(RECENT_WINDOW, result.savedTranscript.length); // sys + summary + recent approx
				this.emit({
					kind: EventKind.CompactionDone,
					compaction: {
						trigger: "context_budget",
						messagesBefore: result.savedTranscript.length,
						messagesAfter: afterMsgs
					}
				});
			}
		);
		return prepared;
	}

	private finishRun(emitLifecycle: boolean, error?: string, phase?: string): void {
		if (emitLifecycle) {
			this.emit({
				kind: EventKind.TurnDone,
				error,
				phase,
				turnMode: this.runLifecycleMeta.turnMode,
				composerMode: this.runLifecycleMeta.composerMode
			});
		}
	}

	private async runWorkflow(
		apiEndpoint: string,
		apiKey: string,
		apiModel: string,
		messages: ChatMessage[],
		projectPath: string | null,
		planTracker: PlanTracker,
		emitLifecycle: boolean,
		abortSignal?: AbortSignal,
		onStream?: (text: string, reasoning?: string) => void,
		requireInGameVerify = false,
		requireFeatureGuiVerify = false,
		verifyTarget: VerifyTarget | null = null,
		runId?: string,
		projectProfile?: ProjectProfile | null,
		previousBuildReport?: BuildReport | null,
		knowledgeFacts?: Array<{ key: string; value: string }>
	): Promise<string> {
		const clarificationGate = { count: this.clarificationCount };
		const engine = new WorkflowEngine({
			steps: normalizeWorkflowSteps(planTracker.steps),
			planTracker,
			registry: this.registry,
			projectPath,
			abortSignal,
			emit: (event) => this.emit(event),
			onToolDispatch: this.onToolDispatch,
			onToolResult: this.onToolResult,
			onGuiLayoutPreview: this.onGuiLayoutPreview,
			onCancelPendingGuiLayouts: this.onCancelPendingGuiLayouts,
			fileSession: this.fileSession,
			clarificationGate,
			visionModel: isVisionCapableModel(apiModel),
			requireInGameVerify,
			requireFeatureGuiVerify,
			verifyTarget,
			projectProfile,
			previousBuildReport,
			knowledgeFacts,
			onRepairProposal: this.onRepairProposal,
			runId,
			modelCall: async (workflowMessages, tools, onChunk) => {
				// Last message is the per-step workflow prompt; compact/persist history only.
				const stepPromptMsg = workflowMessages[workflowMessages.length - 1];
				const history = workflowMessages.slice(0, -1);
				const prepared = await this.prepareApiMessages(history, apiEndpoint, apiKey, apiModel, abortSignal);
				if (prepared.compacted) {
					messages.length = 0;
					messages.push(...prepared.messages);
				}
				const apiMessages = stepPromptMsg ? [...prepared.messages, stepPromptMsg] : prepared.messages;
				this.assistantTurnCount++;
				let text = "";
				let reasoningText = "";
				const result = await this.streamFromAPI(
					apiEndpoint,
					apiKey,
					apiModel,
					apiMessages,
					tools,
					abortSignal,
					(chunk, reasoning) => {
						if (chunk) {
							text += chunk;
							this.emit({ kind: EventKind.Text, text: chunk });
						}
						if (reasoning) {
							reasoningText += reasoning;
							this.emit({ kind: EventKind.Reasoning, text: reasoning });
						}
						onChunk(chunk, reasoning);
						onStream?.(text, reasoningText);
					},
					4096
				);
				const protocolDiagnostics = result.protocolDiagnostics || [];
				const protocolRecovery = this.updateProtocolRecovery(apiModel, result.toolCalls, protocolDiagnostics);
				this.emit({ kind: EventKind.Message, text, reasoning: reasoningText });
				if (result.usage && (result.usage.promptTokens || result.usage.totalTokens || result.usage.completionTokens)) {
					const u = result.usage;
					this.emit({
						kind: EventKind.Usage,
						usage: {
							promptTokens: u.promptTokens ?? 0,
							completionTokens: u.completionTokens ?? 0,
							totalTokens: u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
							cacheHitTokens: u.cacheHitTokens,
							cacheMissTokens: u.cacheMissTokens,
							finishReason: result.finishReason
						}
					});
				}
				return {
					finishReason: result.finishReason,
					toolCalls: result.toolCalls,
					text,
					reasoning: reasoningText,
					protocolDiagnostics,
					protocolRecovery,
					usage: result.usage,
					replaceBaseMessages: prepared.compacted ? prepared.messages : undefined
				};
			}
		});
		try {
			const result = await engine.run(messages);
			this.clarificationCount = clarificationGate.count;
			// 收集截图供 Controller 任务总结使用
			this.lastCollectedScreenshots = result.collectedScreenshots || [];

			if (result.needsClarification) {
				this.clarificationPending = true;
				this.emit({
					kind: EventKind.ClarificationNeeded,
					clarification: {
						question: result.clarificationQuestion || result.finalContent || "",
						options: result.clarificationOptions
					}
				});
				return result.finalContent;
			}

			if (result.finalContent.trim()) {
				messages.push({ role: "assistant", content: result.finalContent });
			}
			if (result.allDone) {
				await finalizeTerminalSteps({
					planTracker,
					projectPath,
					emit: (event) => this.emit(event)
				});
			} else if (result.partial) {
				this.emit({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: result.gameTestStatus
							? (result.gameTestStatus.state === 'terminal'
								? `游戏测试已结束为 INCONCLUSIVE（${result.gameTestStatus.code}）；无需补充断言或进入通用澄清。`
								: result.gameTestStatus.state === 'visual_review'
									? '游戏测试已进入专用视觉审核卡，请在审核卡中接受或拒绝。'
									: `游戏测试状态：${result.gameTestStatus.message}`)
							: "部分步骤未完成，已暂停自动执行。发送「继续」可从当前步骤恢复。"
					}
				});
			}
			this.finishRun(emitLifecycle);
			return result.finalContent;
		} catch (err: unknown) {
			if (err instanceof DOMException && err.name === "AbortError") {
				this.finishRun(emitLifecycle, "Cancelled");
				return "";
			}
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("Workflow error", errMsg);
			const remaining = planTracker.toContextBlock();
			const partial = `执行因错误中断：${errMsg}\n\n` + (remaining ? `当前计划进度：\n${remaining}\n\n` : "") + "发送「继续」可从当前步骤恢复执行。";
			messages.push({ role: "assistant", content: partial });
			this.emit({
				kind: EventKind.Notice,
				notice: {
					level: "error",
					text: isRetryableFetchError(err) ? `网络请求失败：${errMsg}。计划未完成，可发送「继续」恢复。` : `执行中断：${errMsg}`
				}
			});
			this.finishRun(emitLifecycle, errMsg);
			return partial;
		}
	}

	async run(
		apiEndpoint: string,
		apiKey: string,
		apiModel: string,
		messages: ChatMessage[],
		projectPath: string | null,
		abortSignal?: AbortSignal,
		onStream?: (text: string, reasoning?: string) => void,
		options: RunOptions = {}
	): Promise<string> {
		const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
		const phase = options.phase ?? "execute";
		const emitLifecycle = options.emitLifecycle ?? true;
		const planTracker = options.planTracker ?? null;
		const opsOnlyPlan = options.opsOnlyPlan ?? false;
		this.activeProviderId = options.providerId;
		this.activeProtocol = options.protocol;
		this.runLifecycleMeta = {
			turnMode: options.turnMode,
			composerMode: options.composerMode
		};

		if (options.opsOnlyPlan) {
			this.readonlyLocked = true;
		}

		if (emitLifecycle) {
			this.emit({ kind: EventKind.TurnStarted });
		}
		logger.agent("Run started", { model: apiModel, phase, steps: this.maxSteps || "unlimited" });

		if (phase === "execute" && planTracker) {
			return this.runWorkflow(
				apiEndpoint,
				apiKey,
				apiModel,
				messages,
				projectPath,
				planTracker,
				emitLifecycle,
				abortSignal,
				onStream,
				Boolean(options.requireInGameVerify),
				Boolean(options.requireFeatureGuiVerify),
				options.verifyTarget ?? null,
				runId,
				options.projectProfile ?? null,
				options.previousBuildReport ?? null,
				options.knowledgeFacts
			);
		}

		let finalContent = "";
		let readonlyRounds = 0;

		for (let step = 0; ; step++) {
			const pastMax = this.maxSteps > 0 && step >= this.maxSteps;
			if (pastMax && !this.graceRound) {
				this.graceRound = true;
				const incomplete = planTracker && !planTracker.allDone() ? `\n未完成步骤：\n${planTracker.toContextBlock()}` : "";
				messages.push({
					role: "user",
					content: `【系统】已达工具轮次上限（${this.maxSteps}）。不要再调用任何工具。` + `输出当前进度总结。${incomplete}`
				});
				this.emit({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: incomplete ? "部分步骤未完成（已达轮次上限）" : `已达轮次上限（${this.maxSteps}）`
					}
				});
				continue;
			}
			if (pastMax && this.graceRound) {
				break;
			}
			if (this.maxSteps === 0 || step < this.maxSteps) {
				logger.agent(`Step ${step + 1}${this.maxSteps > 0 ? "/" + this.maxSteps : ""}`);
			}
			if (abortSignal?.aborted) {
				this.finishRun(emitLifecycle, "Cancelled");
				return finalContent;
			}

			// Build API messages with micro-compaction applied to old tool results
			const systemIdx = messages.findIndex((m) => m.role === "system");
			const rawApiMessages: ChatMessage[] = systemIdx >= 0 ? [{ ...messages[systemIdx] }, ...messages.slice(systemIdx + 1)] : [...messages];

			const prepared = await this.prepareApiMessages(rawApiMessages, apiEndpoint, apiKey, apiModel, abortSignal);
			if (prepared.compacted) {
				messages.length = 0;
				messages.push(...prepared.messages);
			}
			const apiMessages = [...prepared.messages];

			// Token budget warning (effective working window, not vendor 1M claim)
			const estimatedTokens = estimatePromptTokens(apiMessages);
			const warnAt = warnTokenThreshold(this.contextWindowFor(apiModel));
			if (estimatedTokens > warnAt) {
				this.emit({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: `上下文已累积约 ${Math.round(estimatedTokens / 1000)}K tokens，接近工作上限。建议开启新会话或等待自动压缩。`
					}
				});
			}

			// Build available tools
			let availableTools =
				phase === "plan" ? this.filterControlTools(this.registry.schemas()).filter((t) => PLAN_READONLY_TOOL_NAMES.has(t.name)) : this.filterControlTools(this.registry.schemas());
			if (this.runLifecycleMeta.turnMode === "chat") {
				const chatTools = new Set(["read_file", "explain_code", "fabric_docs_search"]);
				availableTools = availableTools.filter((t) => chatTools.has(t.name));
			}
			if (this.graceRound) {
				availableTools = [];
			} else if (phase === "plan") {
				if (readonlyRounds >= MAX_READONLY_ROUNDS && !this.planExplorationLocked) {
					this.planExplorationLocked = true;
					this.planForceSubmitOnly = true;
					const kick = PLAN_EXPLORATION_LOCK_KICK;
					messages.push({ role: "user", content: kick });
					apiMessages.push({ role: "user", content: kick });
					logger.agent("KICK: plan phase exploration cap reached");
				}
				if (this.planForceSubmitOnly) {
					availableTools = availableTools.filter((t) => isPlanPostLockTool(t.name));
				} else if (this.planExplorationLocked) {
					availableTools = this.filterExplorationTools(availableTools);
				}
			} else if (phase === "execute") {
				if (this.readonlyLocked) {
					availableTools = this.filterExplorationTools(availableTools);
				} else if (readonlyRounds >= MAX_READONLY_ROUNDS) {
					this.readonlyLocked = true;
					readonlyRounds = 0;
					availableTools = this.filterExplorationTools(availableTools);
					const kick =
						"STOP EXPLORING. You have spent too many rounds reading files, listing directories, and running diagnostic commands. run_command, read_file, and list_directory are now LOCKED. You can ONLY write files (write_file) or build/run (trigger_build). Make a decision and execute it NOW.";
					messages.push({ role: "user", content: kick });
					apiMessages.push({ role: "user", content: kick });
					logger.agent("KICK: exploration tools permanently removed");
				}
			}

			// Resolve capabilities once for this model turn. The snapshot is what the
			// response validator enforces; it is no longer what the provider is shown.
			const activeToolSnapshot = createActiveToolSnapshot({
				registry: this.registry,
				phase,
				turnId: `${phase}:${step + 1}`,
				candidateTools: availableTools,
				...(this.runLifecycleMeta.turnMode === "chat" ? { chatToolNames: new Set(["read_file", "explain_code", "fabric_docs_search"]) } : {})
			});

			// Plan and execute advertise the immutable full catalog so the serialized
			// request prefix is byte-identical between rounds. Advertising the per-round
			// gated subset churned `tools` every turn, which is what held prompt-cache hits
			// at ~60% while DeepSeek re-billed the whole context as a cache miss.
			// Chat keeps its small fixed surface (no churn to remove), and a grace round
			// still gets no tools at all.
			const advertisedTools = this.graceRound
				? []
				: this.runLifecycleMeta.turnMode === "chat"
					? activeToolSnapshot.tools
					: this.registry.schemas();
			availableTools = advertisedTools;

			// 1. Stream
			let streamContent = "";
			let streamReasoning = "";

			try {
				const result = await this.streamFromAPI(
					apiEndpoint,
					apiKey,
					apiModel,
					apiMessages,
					availableTools,
					abortSignal,
					(text, reasoning) => {
						if (text) {
							streamContent += text;
							this.emit({ kind: EventKind.Text, text });
						}
						if (reasoning) {
							streamReasoning += reasoning;
							this.emit({ kind: EventKind.Reasoning, text: reasoning });
						}
						onStream?.(streamContent, streamReasoning);
					},
					phase === "plan" ? 8192 : 4096
				);

				this.emit({ kind: EventKind.Message, text: streamContent, reasoning: streamReasoning });

				if (result.usage && (result.usage.promptTokens || result.usage.totalTokens || result.usage.completionTokens)) {
					const u = result.usage;
					this.emit({
						kind: EventKind.Usage,
						usage: {
							promptTokens: u.promptTokens ?? 0,
							completionTokens: u.completionTokens ?? 0,
							totalTokens: u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
							cacheHitTokens: u.cacheHitTokens,
							cacheMissTokens: u.cacheMissTokens,
							finishReason: result.finishReason
						}
					});
				}

				if (result.finishReason === "length") {
					this.emit({ kind: EventKind.Notice, notice: { level: "warn", text: "Response truncated" } });
				}

				const rawToolCalls = result.toolCalls;
				const validation = validateToolCalls(rawToolCalls, activeToolSnapshot, { phase });
				const protocolDiagnostics = result.protocolDiagnostics || [];
				const protocolRecovery = this.updateProtocolRecovery(apiModel, rawToolCalls, protocolDiagnostics);
				const protocolOnlyFailure = protocolRecovery.protocolOnlyFailure;
				if (protocolRecovery.fallbackActivated) {
					messages.push({ role: 'user', content: '【系统】Provider 原生工具参数流连续两次不完整。下一轮暂时关闭 native tools，请使用文本 XML 格式：<tool_call>{"name":"工具名","args":{...}}</tool_call>。只提交完整 JSON。' });
					this.emit({ kind: EventKind.Notice, notice: { level: 'warn', text: '原生工具协议连续失败，已降级到 XML fallback；不计入代码修复预算。' } });
					continue;
				}
				if (protocolRecovery.paused) {
					finalContent = `[HARNESS_PAUSED:protocol] Provider 工具协议连续失败，已保存当前检查点。${protocolRecovery.reason || ''}`;
					this.emit({ kind: EventKind.Notice, notice: { level: 'warn', text: 'Provider 协议降级仍失败，任务已暂停；可发送「继续」切换已配置 fallback。' } });
					this.finishRun(emitLifecycle, 'provider_protocol_stalled');
					return finalContent;
				}
				for (const [id, rejected] of validation.rejected) {
					this.emit({
						kind: EventKind.ToolDispatch,
						tool: { id, name: rejected.toolName || "unknown", args: JSON.stringify(rejected.args || {}) }
					});
					this.emit({
						kind: EventKind.ToolResult,
						tool: {
							id,
							name: rejected.toolName || "unknown",
							args: JSON.stringify(rejected.args || {}),
							output: rejected.output,
							error: rejected.error,
							durationMs: 0
						}
					});
					this.onToolResult?.(rejected.toolName || "unknown", id, rejected.output);
				}
				const toolCalls = validation.accepted;
				const cleanText = streamContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
				finalContent = cleanText || streamContent;
				if (protocolOnlyFailure && rawToolCalls.length > 0 && toolCalls.length === 0) {
					messages.push({ role: 'user', content: '【系统】工具参数流未完整结束（arguments_incomplete），请重新提交同一个工具调用的完整参数；这不是白名单拒绝，也不需要知识库查询。' });
					continue;
				}

				if (rawToolCalls.length > 0 && toolCalls.length === 0) {
					// Preserve the exact rejected call and field-level result in model history.
					// Previously the model only received a generic "tool rejected" nudge and
					// therefore repeated the same malformed submit_plan forever.
					appendToolRoundHistory(messages, streamContent, rawToolCalls, validation.rejected, undefined, {
						reasoningContent: streamReasoning
					});
					const signature = rejectedToolCallSignature(validation.rejected.values());
					if (signature && signature === this.lastRejectedToolSignature) {
						this.consecutiveSameRejectedToolRounds++;
					} else {
						this.lastRejectedToolSignature = signature;
						this.consecutiveSameRejectedToolRounds = signature ? 1 : 0;
					}
					// Some providers need one extra schema-correction round when a
					// nested object array is first serialized as XML-like strings.
					// Three identical failures still terminate deterministically.
					if (this.consecutiveSameRejectedToolRounds >= 3) {
						const rejectedNames = [...new Set([...validation.rejected.values()].map((item) => item.toolName || "unknown"))].join(", ");
						finalContent = `相同的非法工具调用已连续出现三次（${rejectedNames}），已停止本轮以避免循环。请依据上方字段级错误重新生成参数。`;
						this.emit({ kind: EventKind.Notice, notice: { level: "warn", text: finalContent } });
						this.finishRun(emitLifecycle, "repeated_invalid_tool_call");
						return finalContent;
					}
					if (phase === "plan" && this.planExplorationLocked) {
						this.planOfferedRejectRounds++;
						const rejectedNames = [...new Set([...validation.rejected.values()].map((r) => r.toolName || "unknown"))].join(", ");
						if (!this.planForceSubmitOnly && this.planOfferedRejectRounds >= MAX_PLAN_OFFERED_REJECT_ROUNDS) {
							this.planForceSubmitOnly = true;
							messages.push({
								role: "user",
								content:
									`【系统】连续 ${this.planOfferedRejectRounds} 轮工具均被拒绝（曾尝试：${rejectedNames}）。` +
									"本轮起仅允许 submit_plan 与 ask_clarification。" +
									"请立即 submit_plan；不要再调用 list_directory/read_file/grep。"
							});
							logger.agent("KICK: plan phase force submit_plan after offered rejects", {
								rounds: this.planOfferedRejectRounds
							});
						} else {
							messages.push({
								role: "user",
								content: `【系统】工具未执行（${rejectedNames}）：探索工具已锁定或不在本轮工具快照。` + "请调用 submit_plan 提交计划，或用 ask_clarification 提问（须带 options）。"
							});
						}
					} else {
						this.planOfferedRejectRounds = 0;
						const failureKinds = [...validation.rejected.values()].map((item) => item.failureKind || item.errorKind || 'execution_failed');
						const guidance = failureKinds.every((kind) => kind === 'arguments_invalid' || kind === 'invalid_tool_arguments')
							? '参数已接收但不符合 Schema，请只修正具体字段。'
							: failureKinds.every((kind) => kind === 'tool_inactive' || kind === 'tool_not_offered' || kind === 'tool_not_allowed')
								? '工具存在但本轮未激活，请使用本轮工具快照中的工具。'
								: '请依据每个调用返回的具体错误码执行唯一修正动作。';
						messages.push({
							role: "user",
							content: `【系统】刚才的工具调用未执行。${guidance}不要把参数错误当作白名单错误，也不要重复读取相同日志。`
						});
					}
					continue;
				}

				if (toolCalls.length > 0) {
					this.planOfferedRejectRounds = 0;
					this.lastRejectedToolSignature = "";
					this.consecutiveSameRejectedToolRounds = 0;
				}

				// Final answer — plan phase must submit_plan (or ask); prose-only is nudged.
				// Execute phase may kick if idle / unfinished plan steps remain.
				if (toolCalls.length === 0) {
					if (phase === "plan" && !this.graceRound) {
						if (shouldNudgePlanSubmit(this.planSubmitNudgeRounds)) {
							this.planSubmitNudgeRounds++;
							this.planExplorationLocked = true;
							this.planForceSubmitOnly = true;
							if (cleanText) messages.push({ role: "assistant", content: cleanText });
							messages.push({ role: "user", content: PLAN_SUBMIT_NUDGE });
							logger.agent("KICK: plan phase text-only → submit_plan", {
								nudge: this.planSubmitNudgeRounds
							});
							continue;
						}
						this.emit({
							kind: EventKind.Notice,
							notice: {
								level: "warn",
								text: "计划阶段多次未调用 submit_plan，已结束本轮（将尝试从文字中解析计划）"
							}
						});
					}
					if (phase === "execute" && planTracker && !planTracker.allDone() && !this.graceRound) {
						this.finalReadinessBlocks++;
						const remaining = planTracker.toContextBlock();
						const cur = planTracker.currentStep;
						const stepHint = cur ? `请继续执行步骤 #${cur.id}：${cur.description}。系统会根据工具结果推进步骤。` : "";
						messages.push({
							role: "user",
							content: `【系统】尚有未完成步骤，不可结束本轮。\n${remaining}\n${stepHint}`
						});
						logger.agent("finalReadinessCheck blocked", { blocks: this.finalReadinessBlocks });
						if (this.finalReadinessBlocks >= MAX_FINAL_READINESS_BLOCKS) {
							finalContent = finalContent || `执行未完成。剩余计划：\n${remaining}`;
							this.emit({
								kind: EventKind.Notice,
								notice: { level: "warn", text: "步骤未全部完成，已结束本轮" }
							});
							logger.agent("Final answer (readiness cap)", { step, phase });
							this.finishRun(emitLifecycle);
							return finalContent;
						}
						continue;
					}
					if (phase === "execute") {
						const anyToolCalled = messages.some((m) => m.role === "tool" || (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0));
						if (!anyToolCalled && (cleanText || streamContent).length > 80 && !planTracker) {
							const kick =
								"【系统警告】你只输出了文字，没有调用任何工具！立即调用 write_file 或其他工具来实际操作项目，不要只说话不做事。可用的工具：write_file（写入文件）、trigger_build（触发构建）。";
							messages.push({ role: "user", content: kick });
							logger.agent("KICK: no tools called, forcing action");
							continue;
						}
					}
					if (finalContent.trim()) {
						messages.push({ role: "assistant", content: finalContent });
					} else if (phase === "execute" && toolCalls.length === 0) {
						this.emit({
							kind: EventKind.Notice,
							notice: { level: "warn", text: "模型本轮未返回任何内容，已结束" }
						});
					}
					logger.agent("Final answer", { step, phase });
					this.finishRun(emitLifecycle);
					return finalContent;
				}

				// Plan phase: only end the turn when there are no exploration/write tools to run.
				// If the model outputs preamble text alongside read_file/list_directory, execute
				// those tools and continue — do not stop after the first sentence.
				if (phase === "plan") {
					const nonClarificationCalls = toolCalls.filter((tc) => tc.name !== "ask_clarification");
					if (nonClarificationCalls.length === 0) {
						const clarificationCalls = toolCalls.filter((tc) => tc.name === "ask_clarification");
						if (clarificationCalls.length > 0) {
							toolCalls.splice(0, toolCalls.length, ...clarificationCalls);
						} else if (finalContent.trim()) {
							messages.push({ role: "assistant", content: finalContent });
							this.finishRun(emitLifecycle);
							return finalContent;
						} else {
							logger.agent("No content or tool calls in plan phase, finishing");
							this.finishRun(emitLifecycle);
							return finalContent;
						}
					}
				}

				// Track exploration rounds (readonly + diagnostic run_command)
				const allExploration = toolCalls.every((tc) => isExploreTool(tc.name, this.registry.policyFor(tc.name)));
				if (allExploration) readonlyRounds++;
				else readonlyRounds = 0;

				// Detect model stuck in reasoning: >80% reasoning tokens, no tool calls
				if (toolCalls.length === 0 && streamReasoning.length > streamContent.length * 4) {
					this.consecutiveReasoningOnlyRounds++;
				} else {
					this.consecutiveReasoningOnlyRounds = 0;
				}
				if (this.consecutiveReasoningOnlyRounds >= 2) {
					messages.push({
						role: "user",
						content: "你已经思考足够久，请直接调用工具执行，不要继续推理分析。"
					});
					this.consecutiveReasoningOnlyRounds = 0;
					logger.agent("KICK: reasoning-only rounds cap reached");
				} else if (streamReasoning.length >= MAX_REASONING_SOFT_CHARS) {
					// GLM-5.2 max effort: long CoT then tools — still kick so the next round stays short.
					messages.push({ role: "user", content: LONG_REASONING_KICK });
					logger.agent("KICK: long reasoning soft cap", { chars: streamReasoning.length });
				}

				// 2. Execute tools (with repeat-success loop guard)
				logger.agent(
					`Executing ${toolCalls.length} tool(s)`,
					toolCalls.map((t) => t.name)
				);

				const callsWithIds: ModelToolCall[] = toolCalls.map((tc) => ({
					id: tc.id || `call_${++_toolCallIdCounter}`,
					name: tc.name,
					args: tc.args,
					rawArguments: tc.rawArguments || JSON.stringify(tc.args)
				}));
				const executableCalls: typeof callsWithIds = [];
				const blockedResults = new Map<string, ToolResult>();

				for (const call of callsWithIds) {
					const blockMsg = this.checkRepeatedSuccessBlock(call.name, call.args);
					if (blockMsg) {
						const tool = this.registry.get(call.name);
						this.emit({
							kind: EventKind.ToolDispatch,
							tool: { id: call.id, name: call.name, args: JSON.stringify(call.args), readOnly: tool?.readOnly() }
						});
						this.onToolDispatch?.(call.name, call.id);
						blockedResults.set(call.id, {
							output: blockMsg,
							error: blockMsg,
							durationMs: 0,
							ok: false,
							toolName: call.name,
							args: call.args,
							exitCode: null,
							errorKind: "loop_guard"
						});
						this.emit({
							kind: EventKind.ToolResult,
							tool: { id: call.id, name: call.name, args: JSON.stringify(call.args), output: blockMsg, error: blockMsg, durationMs: 0 }
						});
						this.onToolResult?.(call.name, call.id, blockMsg);
						logger.agent("loop guard blocked", { tool: call.name, args: call.args });
						continue;
					}
					executableCalls.push(call);
				}

				const ctx: ToolContext = {
					projectPath,
					callId: `step_${step}`,
					runId,
					abortSignal,
					planTracker,
					fileSession: this.fileSession,
					onPlanStateChange: (steps) => {
						this.emit({ kind: EventKind.PlanState, planSteps: steps });
					},
					onGuiLayoutPreview: this.onGuiLayoutPreview,
					guiPreviewCompletedForStep: false,
					currentStepRequiresGuiPreview: false
				};

				const results = blockedResults;
				if (executableCalls.length > 0) {
					const batchResults = await executeBatch(
						executableCalls,
						this.registry,
						ctx,
						(name, id, args) => {
							const tool = this.registry.get(name);
							this.emit({ kind: EventKind.ToolDispatch, tool: { id, name, args: JSON.stringify(args), readOnly: tool?.readOnly() } });
							this.onToolDispatch?.(name, id);
						},
						(name, id, result) => {
							const call = executableCalls.find((c) => c.id === id);
							if (call) this.recordRepeatSuccess(name, call.args, Boolean(result.error));
							this.emit({
								kind: EventKind.ToolResult,
							tool: { id, name, args: JSON.stringify(result.args || {}), output: result.output, error: result.error, durationMs: result.durationMs, fileDiff: result.fileDiff, outcome: result.outcome, runId: result.runId, executionId: result.executionId, validation: result.validation, buildReport: result.buildReport, validationResult: result.validationResult }
							});
							this.onToolResult?.(name, id, result.output);
						},
						(id, chunk) => {
							this.emit({
								kind: EventKind.ToolProgress,
								tool: { id, name: "", args: "", partial: true, output: chunk }
							});
						}
					);
					for (const [id, r] of batchResults) results.set(id, r);
				}

				// Check if model is asking a clarification question (plan or chat phase)
				if (phase === "plan") {
					const submittedPlan = [...results.values()].find((r) => r.toolName === "submit_plan" && r.ok);
					if (submittedPlan) {
						appendToolRoundHistory(messages, streamContent, callsWithIds, results, undefined, {
							visionModel: isVisionCapableModel(apiModel),
							reasoningContent: streamReasoning
						});
						finalContent = submittedPlan.output;
						messages.push({ role: "assistant", content: finalContent });
						this.finishRun(emitLifecycle);
						return finalContent;
					}
				}

				// Check if model is asking a clarification question (plan or chat phase)
				for (const r of results.values()) {
					if (r.toolName === "ask_clarification" && r.ok) {
						const question = String(r.args?.question || "");
						const options = Array.isArray(r.args?.options) ? (r.args.options as string[]).map(String) : undefined;
						const text = streamContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
						appendToolRoundHistory(messages, text, callsWithIds, results, undefined, {
							visionModel: isVisionCapableModel(apiModel),
							reasoningContent: streamReasoning
						});
						this.clarificationPending = true;
						this.clarificationCount++;
						this.emit({
							kind: EventKind.ClarificationNeeded,
							clarification: { question, options }
						});
						return text || question;
					}
				}

				const executedCalls = [...callsWithIds];

				// 3. Append native function-calling history (assistant.tool_calls + role:tool)
				if (results.size > 0) {
					const lines: string[] = [];
					for (const call of executedCalls) {
						const r = results.get(call.id);
						if (r) lines.push(r.output);
					}

					let dupWarning = "";
					// The model rewrote a file it had already written this run → it is
					// stuck re-editing instead of moving on to the next plan step.
					for (const tc of executedCalls) {
						if (tc.name === "write_file" && typeof tc.args.path === "string") {
							const path = tc.args.path;
							const content = String(tc.args.content || "");
							const prev = this.writtenFiles.get(path);
							if (prev === content) {
								dupWarning = `【警告】文件 ${path} 已经写入过相同内容！不要重复写入。改用 trigger_build 构建。`;
							} else if (prev !== undefined) {
								dupWarning = `【注意】文件 ${path} 将被覆盖写入（内容已变更）。`;
							}
							this.writtenFiles.set(path, content);
						}
					}

					const hasWrite = executedCalls.some((tc) => tc.name === "write_file");
					const hasEdit = executedCalls.some((tc) => tc.name === "edit_file" || tc.name === "delete_file");
					const hasBuild = executedCalls.some((tc) => tc.name === "trigger_build");
					const hasStepDone = executedCalls.some((tc) => tc.name === "complete_step");
					const combinedOutput = lines.join("\n");
					const successfulWrites = executableCalls.filter((tc) => (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "delete_file") && !results.get(tc.id)?.error);
					const hasSuccessfulWrite = successfulWrites.length > 0;

					if ((hasWrite || hasEdit) && !hasBuild && !hasStepDone) {
						this.consecutiveWriteOnlyRounds++;
					} else {
						this.consecutiveWriteOnlyRounds = 0;
					}

					// ---- Step advancement: manual via complete_step tool (workflow handles build/run auto-detect) ----
					const roundFullyBlocked = executableCalls.length === 0 && blockedResults.size > 0;
					const curStep = planTracker?.currentStep ?? null;
					const autoAdvanceMsg = "";

					if (hasSuccessfulWrite && planTracker?.currentStep && !hasStepDone && !autoAdvanceMsg) {
						// Once a write step has produced a file, stop offering exploration
						// tools. Otherwise weak models often go back to list/read loops
						// instead of marking the current step complete.
						this.readonlyLocked = true;
					}

					const pushRoundHistory = (instruction: string): void => {
						const ephemeral = appendToolRoundHistory(messages, streamContent, executedCalls, results, instruction, { visionModel: isVisionCapableModel(apiModel), reasoningContent: streamReasoning });
						if (ephemeral) {
							messages.push({ role: "user", content: ephemeral });
						}
						this.assistantTurnCount++;
					};

					// complete_step marked the last step done → end immediately so the
					// model can't keep spamming complete_step against a finished plan.
					if (hasStepDone && planTracker?.allDone()) {
						pushRoundHistory("[SYSTEM: 全部计划步骤已完成。]");
						finalContent = finalContent.trim() || "全部计划步骤已完成。";
						this.emit({ kind: EventKind.Notice, notice: { level: "info", text: "全部步骤已完成，自动结束本轮" } });
						logger.agent("complete_step: all steps done, ending run", { step, phase });
						this.finishRun(emitLifecycle);
						return finalContent;
					}

					// Safety net: model keeps calling complete_step without doing real work.
					const stepDoneOnly = hasStepDone && !hasWrite && !hasBuild && executableCalls.length > 0;
					if (stepDoneOnly) this.consecutiveStepDoneOnlyRounds++;
					else this.consecutiveStepDoneOnlyRounds = 0;
					if (this.consecutiveStepDoneOnlyRounds >= 2) {
						const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : "";
						pushRoundHistory("检测到反复标记步骤但无实质进展。");
						finalContent = finalContent.trim() || `检测到反复标记步骤但无实质进展，已自动结束本轮。${remaining}`;
						this.emit({
							kind: EventKind.Notice,
							notice: { level: "warn", text: "检测到 complete_step 循环，已自动结束本轮" }
						});
						logger.agent("Loop escape: complete_step spam cap reached", { step, phase });
						this.finishRun(emitLifecycle);
						return finalContent;
					}

					// Safety net: model keeps spamming a blocked tool with no way forward.
					if (roundFullyBlocked) {
						this.consecutiveBlockedRounds++;
					} else if (!roundFullyBlocked) {
						this.consecutiveBlockedRounds = 0;
					}
					if (this.consecutiveBlockedRounds >= 2) {
						const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : "";
						pushRoundHistory("检测到重复调用已完成的操作。");
						finalContent = finalContent.trim() || `检测到重复调用已完成的操作，已自动结束本轮。${remaining}`;
						this.emit({
							kind: EventKind.Notice,
							notice: { level: "warn", text: "检测到工具重复调用循环，已自动结束本轮" }
						});
						logger.agent("Loop escape: blocked-round cap reached, ending run", { step, phase });
						this.finishRun(emitLifecycle);
						return finalContent;
					}

					// Idle detection (execute only): plan phase may legitimately only search docs /
					// ask clarification before emitting a plan — do not require write_file there.
					if (phase !== "plan") {
						const hadProgress = hasSuccessfulWrite || hasBuild;
						if (hadProgress) {
							this.consecutiveIdleRounds = 0;
						} else {
							this.consecutiveIdleRounds++;
						}
						if (this.consecutiveIdleRounds >= 5) {
							const remaining = planTracker ? `\n剩余计划：\n${planTracker.toContextBlock()}` : "";
							pushRoundHistory("检测到连续多轮无实质进展（无文件写入、无构建）。");
							finalContent = finalContent.trim() || `执行停滞：连续 ${this.consecutiveIdleRounds} 轮无文件写入或构建进展，已自动结束。${remaining}`;
							this.emit({
								kind: EventKind.Notice,
								notice: { level: "warn", text: `连续 ${this.consecutiveIdleRounds} 轮无进展，已自动结束本轮` }
							});
							logger.agent("Loop escape: idle rounds cap reached", { step, phase, idleRounds: this.consecutiveIdleRounds });
							this.finishRun(emitLifecycle);
							return finalContent;
						}
					} else {
						this.consecutiveIdleRounds = 0;
					}

					let instruction = "";
					if (this.consecutiveWriteOnlyRounds >= 3) {
						instruction = "【系统警告】你已经连续多次只写入文件而没有构建！立即调用 trigger_build 来构建项目，不要继续写文件！";
						this.consecutiveWriteOnlyRounds = 0;
					} else if (dupWarning) {
						instruction = dupWarning;
					} else if (hasBuild && combinedOutput.includes("BUILD SUCCESSFUL")) {
						instruction = "[SYSTEM: 构建已成功完成。不要再次调用 trigger_build，系统会根据构建结果推进步骤。]";
					} else if (hasBuild) {
						instruction = "[SYSTEM: 构建完成。检查结果后决定下一步。]";
					} else if (hasStepDone) {
						const cur = planTracker?.currentStep;
						if (cur) {
							instruction = `[SYSTEM: 步骤已推进。当前步骤 #${cur.id}：${cur.description}。请执行该步骤，系统会根据工具结果继续推进。]`;
						} else if (planTracker?.allDone()) {
							instruction = "[SYSTEM: 全部计划步骤已完成。请输出总结，不要再调用工具。]";
						} else {
							instruction = "[SYSTEM: 步骤已标记。继续下一步或调用 trigger_build。]";
						}
					} else if (hasSuccessfulWrite) {
						const cur = planTracker?.currentStep;
						instruction = cur
							? `[SYSTEM: 文件已写入。当前步骤 #${cur.id}：${cur.description}。` + "请检查是否需要执行下一步；不要 list_directory/read_file，不要重写同一个文件。]"
							: "[SYSTEM: 文件已写入。不要重复写入同一个文件，继续下一步或输出总结。]";
					} else {
						instruction = "[SYSTEM: 工具执行完毕。决定下一步。]";
					}
					if (planTracker && !hasStepDone) {
						instruction += `\n\n当前计划进度：\n${planTracker.toContextBlock()}`;
					}
					pushRoundHistory(instruction);
				}
			} catch (err: unknown) {
				if (err instanceof DOMException && err.name === "AbortError") {
					this.finishRun(emitLifecycle, "Cancelled");
					return finalContent;
				}
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("Agent error", errMsg);
				this.emit({ kind: EventKind.Notice, notice: { level: "error", text: errMsg } });
				this.finishRun(emitLifecycle, errMsg);
				return finalContent;
			}
		}

		if (this.maxSteps > 0 && !this.graceRound) {
			this.emit({ kind: EventKind.Notice, notice: { level: "warn", text: `Max steps (${this.maxSteps}) reached` } });
		}
		this.finishRun(emitLifecycle);
		return finalContent;
	}

	private async streamFromAPI(
		endpoint: string,
		apiKey: string,
		model: string,
		messages: ChatMessage[],
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
		abortSignal?: AbortSignal,
		onChunk?: (text: string, reasoning?: string) => void,
		maxTokens = 8192
	): Promise<{
		finishReason?: string;
		toolCalls: ModelToolCall[];
		usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number };
		protocolDiagnostics?: ProviderProtocolDiagnostic[];
	}> {
		let lastError: unknown;
		let requestMessages = messages;
		let reasoningRetried = false;
		for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
			const invocationId = `request_${Date.now().toString(36)}_${++_modelInvocationIdCounter}`;
			const startedAt = Date.now();
			this.onModelInvocation?.({ invocationId, modelId: model, phase: "start", startedAt, status: "running" });
			try {
				const result = await this.streamFromAPIOnce(endpoint, apiKey, model, requestMessages, tools, abortSignal, onChunk, maxTokens);
				this.onModelInvocation?.({ invocationId, modelId: model, phase: "end", startedAt, endedAt: Date.now(), status: "completed" });
				return result;
			} catch (err) {
				this.onModelInvocation?.({ invocationId, modelId: model, phase: "end", startedAt, endedAt: Date.now(), status: "failed", error: String(err) });
				const protocolMessage = String(err)
					.replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
					.replace(/(sk-|key|token|api[_-]?key)[=: ]+[^\s,;]+/gi, '$1=[redacted]')
					.slice(0, 320);
				this.onProviderProtocolDiagnostic?.({
					id: `transport:${Date.now().toString(36)}:${attempt}`,
					providerId: this.activeProviderId,
					modelId: model,
					protocol: this.activeProtocol,
					kind: 'transport',
					message: protocolMessage,
					retryCount: attempt,
					createdAt: Date.now()
				});
				lastError = err;
				// Thinking continuity is a history-shape problem, not a capacity problem:
				// retry it in place with the field dropped, and never let the caller
				// "solve" it by switching to another model.
				if (isReasoningContinuityError(err) && !reasoningRetried) {
					reasoningRetried = true;
					requestMessages = withoutReasoningEcho(requestMessages);
					this.emit({
						kind: EventKind.Notice,
						notice: { level: "warn", text: "Provider 拒绝了回传的 reasoning_content，已按无推理历史就地重试同一模型（不切换备用模型）。" }
					});
					continue;
				}
				if (!isRetryableFetchError(err) || attempt >= MAX_FETCH_RETRIES - 1) throw err;
				const delay = fetchRetryDelayMs(attempt);
				logger.agent("API fetch retry", { attempt: attempt + 1, delay, error: String(err) });
				this.emit({
					kind: EventKind.Notice,
					notice: {
						level: "warn",
						text: `API 请求失败，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${MAX_FETCH_RETRIES})…`
					}
				});
				await sleep(delay);
			}
		}
		throw lastError;
	}

	private async streamFromAPIOnce(
		endpoint: string,
		apiKey: string,
		model: string,
		messages: ChatMessage[],
		tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
		abortSignal?: AbortSignal,
		onChunk?: (text: string, reasoning?: string) => void,
		maxTokens = 8192
	): Promise<{
		finishReason?: string;
		toolCalls: ModelToolCall[];
		usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number };
		protocolDiagnostics?: ProviderProtocolDiagnostic[];
	}> {
		const adapter = createModelAdapter({ endpoint, model, providerId: this.activeProviderId, protocol: this.activeProtocol });
		const request = adapter.buildRequest({ endpoint, apiKey, model, providerId: this.activeProviderId, protocol: this.activeProtocol, messages, tools: this.xmlFallbackActive ? [] : tools, maxTokens });

		// Create a timeout signal that aborts after 120s of no response
		const API_TIMEOUT_MS = 120_000;
		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(new Error("API timeout")), API_TIMEOUT_MS);

		// Combine user abort + timeout: if either fires, abort the fetch
		const onUserAbort = () => timeoutController.abort();
		abortSignal?.addEventListener("abort", onUserAbort, { once: true });

		let response: Response;
		try {
			response = await fetch(request.url, { ...request.init, signal: timeoutController.signal });
		} catch (error) {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onUserAbort);
			throw error;
		}
		if (!response.ok) {
			const text = await response.text();
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onUserAbort);
			throw new Error(`API error ${response.status}: ${text}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onUserAbort);
			throw new Error("No response body");
		}
		const decoder = new TextDecoder();
		let buffer = "";
		let finishReason: string | undefined;
		let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cacheHitTokens?: number; cacheMissTokens?: number } = {};
		const assembler = new ToolCallAssembler({
			protocol: adapter.capabilities.protocol,
			modelId: model,
			providerId: this.activeProviderId
		});
		let fullText = "";
		let extraReasoning = "";
		let reasoningChars = 0;
		let sawToolCallDelta = false;
		let reasoningCapped = false;
		// 流式 `<think>` 标签过滤器：将 MiniMax-M3 等模型输出的 `<think>...</think>`
		// 内容路由到 reasoning 字段，避免泄露到用户可见的正文。
		const thinkFilter = new ThinkTagStreamFilter();

		let servedModelMismatchLogged = false;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (data === "[DONE]") continue;
					let parsed: any;
					try {
						parsed = JSON.parse(data);
					} catch {
						// Providers occasionally emit keep-alive/non-JSON SSE lines.
						continue;
					}
					// A gateway may serve a different id than we requested (retired DeepSeek
					// names resolve to V4.1 Flash). Cost is billed against the requested id, so
					// log the first divergence once per request instead of silently trusting it.
					if (!servedModelMismatchLogged && typeof parsed.model === "string" && parsed.model && parsed.model !== model) {
						servedModelMismatchLogged = true;
						logger.agent("Provider served a different model id than requested", { requested: model, served: parsed.model });
					}
					for (const event of adapter.normalizeEvent(parsed)) {
							if (event.type === "usage" && event.usage) {
								usage = {
									promptTokens: event.usage.promptTokens ?? usage.promptTokens,
									completionTokens: event.usage.completionTokens ?? usage.completionTokens,
									totalTokens: event.usage.totalTokens ?? usage.totalTokens,
									cacheHitTokens: (parsed.usage?.prompt_cache_hit_tokens ?? parsed.usage?.cacheHitTokens ?? usage.cacheHitTokens),
									cacheMissTokens: (parsed.usage?.prompt_cache_miss_tokens ?? parsed.usage?.cacheMissTokens ?? usage.cacheMissTokens)
								};
								continue;
							}
							if (event.type === "done" && event.finishReason) finishReason = event.finishReason;
							if (event.type === "error") throw new Error(event.error || "Provider stream error");
							if (event.type === "reasoning_delta" && event.reasoning) {
								reasoningChars += event.reasoning.length;
								onChunk?.("", event.reasoning);
							// Soft-abort endless GLM CoT before tool_calls arrive (max_tokens does not cap thinking).
							if (!sawToolCallDelta && !fullText && reasoningChars >= MAX_REASONING_HARD_CHARS) {
								reasoningCapped = true;
								finishReason = "reasoning_cap";
								logger.agent("stream abort: reasoning hard cap", { reasoningChars, model });
								try {
									await reader.cancel();
								} catch {
									/* ignore */
								}
								break;
							}
							}
							if ((event.type === "tool_call_start" || event.type === "tool_call_delta" || event.type === "tool_call_end") && event.toolCall) {
								sawToolCallDelta = true;
								assembler.add(event);
							}
							if (event.type === "text_delta" && event.text) {
								// 通过 thinkFilter 过滤 `<think>` 标签：
								// - 标签内内容 → reasoning（不显示给用户）
								// - 标签外内容 → text（正常显示）
								const filtered = thinkFilter.process(event.text);
								if (filtered.text) {
									fullText += filtered.text;
									onChunk?.(filtered.text, "");
								}
								if (filtered.reasoning) {
									extraReasoning += filtered.reasoning;
									reasoningChars += filtered.reasoning.length;
									onChunk?.("", filtered.reasoning);
								}
							}
					}
				}
				if (reasoningCapped) break;
			}
		} finally {
			clearTimeout(timeoutId);
			abortSignal?.removeEventListener("abort", onUserAbort);
		}

		if (reasoningCapped) {
			onChunk?.("", `\n\n【系统】推理已超过 ${MAX_REASONING_HARD_CHARS} 字符上限并中断，请直接调用工具。`);
		}

		// flush thinkFilter：处理流结束时 buffer 中的残留内容
		const flushed = thinkFilter.flush();
		if (flushed.text) {
			fullText += flushed.text;
		}
		if (flushed.reasoning) {
			extraReasoning += flushed.reasoning;
			reasoningChars += flushed.reasoning.length;
		}

		const finalizedNativeCalls = assembler.finish(finishReason);
		const protocolDiagnostics = assembler.getDiagnostics();
		for (const diagnostic of protocolDiagnostics) this.onProviderProtocolDiagnostic?.(diagnostic);
		const nativeCalls: ModelToolCall[] = finalizedNativeCalls.map((call) => ({
			id: call.id,
			name: call.name,
			args: call.args,
			rawArguments: call.rawArguments,
			protocol: call.protocol,
			providerIndex: call.providerIndex,
			providerId: call.providerId,
			...(call.failureKind ? { failureKind: call.failureKind } : {})
		}));

		// 后处理：清理残留的 `<think>` 标签（防御性，处理 thinkFilter 遗漏的边界情况）
		if (extraReasoning || /<think>/i.test(fullText)) {
			const stripped = stripThinkTags(fullText);
			if (stripped.reasoning) {
				extraReasoning += (extraReasoning ? "\n\n" : "") + stripped.reasoning;
			}
			if (stripped.text !== fullText) {
				fullText = stripped.text;
			}
		}

		// 后处理：清理 MiniMax 协议标记（防御性，处理流式 ThinkTagStreamFilter 遗漏的跨 chunk 标记）。
		// 必须在 parseToolCalls / extractPlanFromXml 之前执行，否则 XML 参数解析会失败。
		if (/<\]minimax\[>\[/.test(fullText)) {
			fullText = stripMinimaxProtocolTokens(fullText);
		}

		const textCalls: ModelToolCall[] = parseToolCalls(fullText).map((tc) => ({
			id: `text_call_${++_toolCallIdCounter}`,
			name: tc.name,
			args: tc.args,
			rawArguments: JSON.stringify(tc.args)
		}));

		// 如果没有原生工具调用也没有文本工具调用，但文本中包含 `<plan>` XML，
		// 则解析 XML 并创建合成的 submit_plan 工具调用。
		// 这处理 MiniMax-M3 等模型用 XML 格式输出计划而非调用工具的情况。
		let planCall: ModelToolCall[] = [];
		if (nativeCalls.length === 0 && textCalls.length === 0) {
			const planSteps = extractPlanFromXml(fullText);
			if (planSteps && planSteps.length > 0) {
				planCall = [
					{
						id: `plan_xml_${++_toolCallIdCounter}`,
						name: "submit_plan",
						args: buildSubmitPlanArgs(planSteps),
						rawArguments: JSON.stringify(buildSubmitPlanArgs(planSteps))
					}
				];
				logger.agent("plan XML detected, converted to submit_plan call", {
					steps: planSteps.length,
					kinds: planSteps.map((s) => s.kind)
				});
			}
		}

		const allCalls = nativeCalls.length > 0 ? nativeCalls : textCalls.length > 0 ? textCalls : planCall;
		return { finishReason, toolCalls: allCalls, usage, protocolDiagnostics };
	}
}
