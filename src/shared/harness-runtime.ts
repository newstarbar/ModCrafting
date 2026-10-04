/**
 * Runtime contracts shared by the Electron host and the renderer Harness.
 *
 * Keep these types data-only.  They are deliberately independent from
 * Electron, Node and any particular model provider so that replay tests can
 * exercise the failure state machine without launching the application.
 */

export type ValidationStage =
  | 'baseline'
  | 'profiled'
  | 'generating'
  | 'static_validate'
  | 'compile_check'
  | 'quick_game'
  | 'final_build'
  | 'final_game'
  | 'promote'
  | 'complete'

export type HarnessRunState =
  | 'BASELINE'
  | 'PROFILED'
  | 'GENERATING'
  | 'STATIC_VALIDATE'
  | 'COMPILE_CHECK'
  | 'DIAGNOSTIC_REPAIR'
  | 'QUICK_GAME_TEST'
  | 'FINAL_BUILD'
  | 'FINAL_GAME_TEST'
  | 'PROMOTE'
  | 'COMPLETE'
  | 'PAUSED'

export type ValidationVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

/** Host-owned result contract shared by static, compile and game validators. */
export interface ValidationResult {
  verdict: ValidationVerdict
  stage: 'static' | 'compile' | 'quick_game' | 'final_game'
  checkedAt: number
  diagnosticIds?: string[]
  message?: string
  evidence?: string[]
}

export type DiagnosticStage =
  | 'configuration'
  | 'dependency'
  | 'java_compile'
  | 'resource'
  | 'mixin'
  | 'startup'
  | 'game_test'
  | 'toolchain'
  | 'unknown'

export type DiagnosticResponsibility =
  | 'baseline'
  | 'project'
  | 'generated_code'
  | 'test_design'
  | 'environment'
  | 'provider'
  | 'harness'
  | 'unknown'

export interface Diagnostic {
  id: string
  stage: DiagnosticStage
  responsibility: DiagnosticResponsibility
  message: string
  normalizedMessage: string
  raw: string
  file?: string
  line?: number
  column?: number
  symbol?: string
  relatedFiles?: string[]
  rootCauseId?: string
  /**
   * Adjudication by the host:
   *   - "hard": a real, blocking error. Repair loop must fix it.
   *   - "soft": a plausible concern that javac couldn't fully prove (e.g. AW-widened
   *     member, split-environment cross-side reference). Surfaced as guidance; the
   *     full Gradle build still runs to authoritatively decide.
   */
  severity?: 'hard' | 'soft'
}

export interface BuildReport {
  version: 1
  task: string
  projectPath: string
  ok: boolean
  exitCode: number
  stage: DiagnosticStage
  responsibility: DiagnosticResponsibility
  diagnostics: Diagnostic[]
  output: string
  outputFingerprint: string
  usedOnlineFallback?: boolean
  cancelled?: boolean
  generatedAt: number
  sourceRevision?: string
  /**
   * Set when the validation gate ran in a degraded mode (e.g. fast-compile classpath
   * missing some project deps). Caller should fall back to a full Gradle build to
   * rule out false positives before declaring the unit OK.
   */
  degraded?: boolean
}

/** Input accepted by the host-side compiler/Gradle diagnostic normalizer. */
export interface BuildReportOptions {
  projectPath: string
  task: string
  output: string
  exitCode: number
  usedOnlineFallback?: boolean
  cancelled?: boolean
  sourceRevision?: string
  /** Marks failures that existed before the candidate patch was generated. */
  baseline?: boolean
}

export interface ProjectProfile {
  version: 1
  projectPath: string
  fingerprint: string
  minecraftVersion?: string
  yarnMappings?: string
  loaderVersion?: string
  fabricApiVersion?: string
  loomVersion?: string
  javaVersion?: string
  modId?: string
  entrypoints: { main: string[]; client: string[]; server: string[] }
  mixinConfigs: string[]
  accessWideners: string[]
  sourceSets: Array<'main' | 'client' | 'server' | string>
  splitEnvironment: boolean
  dependencies: string[]
  gradleTasks: string[]
  javaFiles: string[]
  resourceFiles: string[]
  registeredSymbols: string[]
  eventHandlers: string[]
  symbolIndex: { available: boolean; minecraftVersion?: string; yarnMappings?: string; classes?: number; error?: string }
  warnings: string[]
}

export interface WorkspaceManifestEntry {
  path: string
  sha256: string
  size: number
}

export interface WorkspacePatchEntry {
  path: string
  operation: 'create' | 'modify' | 'delete'
  beforeSha256?: string
  afterSha256?: string
  recordedAt: number
}

export interface ExecutionWorkspace {
  version: 1
  id: string
  userProjectPath: string
  shadowPath: string
  baseline: WorkspaceManifestEntry[]
  createdAt: number
  status: 'active' | 'promoted' | 'paused' | 'promotion_conflict' | 'rolled_back' | 'discarded'
  changedPaths?: string[]
  conflictPaths?: string[]
  patchJournal?: WorkspacePatchEntry[]
}

export interface RepairProposal {
  id: string
  diagnosticIds: string[]
  hypothesis: string
  files: string[]
  expectedResolution: string
  modelRole?: string
  modelId?: string
}

export interface TaskCheckpoint {
  version: 1
  /** Version of the persisted Harness execution schema.  `version` remains
   * 1 for backwards compatibility with existing checkpoints. */
  schemaVersion?: 2
  taskId: string
  workspace: ExecutionWorkspace
  state: HarnessRunState
  stage: ValidationStage
  profile?: ProjectProfile
  planStepId?: string
  diagnosticIds: string[]
  resolvedDiagnosticIds: string[]
  /** Last host-owned report, retained so a restarted renderer can resume the
   * same repair state without asking the model to rediscover the failure. */
  lastBuildReport?: BuildReport
  repairProposals: RepairProposal[]
  modelRole?: string
  fallbackIndex: number
  budgets: {
    repairProposals: number
    modelRounds: number
    toolCalls: number
    startedAt: number
    maxRepairProposals?: number
    maxModelRounds?: number
    maxToolCalls?: number
    maxMinutes?: number
  }
  updatedAt: number
  quickGameStatus?: 'pending' | 'pass' | 'fail' | 'inconclusive'
  finalGameStatus?: 'pending' | 'pass' | 'fail' | 'inconclusive'
  knowledgeFactKeys: string[]
  /** Cached fact payloads are kept with the checkpoint so an application
   * restart can answer an exact query without replaying knowledge I/O. */
  knowledgeFacts?: Array<{ key: string; value: string }>
  pauseReason?: string
  /** Serializable plan snapshot used to resume after an application restart. */
  plan?: Array<{
    id: string
    description: string
    status: 'pending' | 'running' | 'completed' | 'error'
    kind?: 'inspect' | 'write' | 'recipe' | 'mixin' | 'build' | 'run' | 'game_test'
    targetPath?: string
    targetPaths?: string[]
    evidence?: string
    gameTest?: unknown
  }>
  /** Model/fallback audit entries retained without provider secrets. */
  modelCalls?: Array<{ roleId: string; providerId: string; modelId: string; status: string; startedAt?: number; endedAt?: number }>
  /** Provider protocol/fallback diagnostics retained without secrets. */
  providerProtocolDiagnostics?: ProviderProtocolDiagnostic[]
}

export type LlmProtocol = 'auto' | 'openai-chat' | 'anthropic-messages'

export interface ModelCapabilities {
  providerId?: string
  modelId: string
  protocol?: LlmProtocol
  nativeToolCalls: boolean
  nativeToolStreaming?: boolean
  jsonSchema: boolean
  vision: boolean
  streaming: boolean
  reasoning: boolean
  contextWindow?: number
  maxOutputTokens?: number
  probedAt: number
}

export interface NormalizedToolCallEvent {
  /** Provider-native position in the assistant response. */
  providerIndex?: number
  /** Provider-native tool call id.  It may only be present on the first chunk. */
  providerId?: string
  /** A complete name or a name fragment, depending on the provider. */
  nameDelta?: string
  /** Raw JSON argument fragment.  It is never parsed at this layer. */
  argumentsDelta?: string
}

export interface NormalizedModelEvent {
  type: 'text_delta' | 'reasoning_delta' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'usage' | 'done' | 'error'
  text?: string
  reasoning?: string
  toolCall?: NormalizedToolCallEvent
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  finishReason?: string
  error?: string
}

export type ToolFailureKind =
  | 'tool_unknown'
  | 'tool_inactive'
  | 'arguments_incomplete'
  | 'arguments_invalid'
  | 'policy_blocked'
  | 'execution_failed'

export interface FinalizedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  rawArguments: string
  protocol?: LlmProtocol
  providerIndex?: number
  providerId?: string
  complete: boolean
  failureKind?: 'arguments_incomplete' | 'arguments_invalid'
}

export interface ActiveToolSnapshot {
  version: 1
  turnId: string
  phase: 'plan' | 'execute' | 'chat'
  stepId?: number
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  inactiveReasons: Record<string, string>
  createdAt: number
}

export type ToolDecision =
  | { decision: 'allowed'; snapshot: ActiveToolSnapshot }
  | { decision: 'inactive'; snapshot: ActiveToolSnapshot; reason: string }
  | { decision: 'policy_blocked'; snapshot: ActiveToolSnapshot; reason: string }

export interface ProviderProtocolDiagnostic {
  id: string
  providerId?: string
  modelId: string
  protocol?: LlmProtocol
  kind: 'assembly' | 'arguments_incomplete' | 'arguments_invalid' | 'fallback' | 'transport'
  message: string
  toolName?: string
  providerIndex?: number
  providerCallId?: string
  rawArgumentLength?: number
  retryCount?: number
  fallback?: 'xml' | 'configured_provider' | 'paused'
  createdAt: number
}
