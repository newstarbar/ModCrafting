/** Public data contracts. No Electron, MCP SDK or Node runtime imports. */
import type { FABRIC_TARGET } from './domain.ts'
import type { StorageStatus } from './storage.ts'
import type { WorkspaceKind } from './workspace-model.ts'

export type RuntimePaths = { dataRoot: string; knowledgeRoot: string; assetsRoot: string; reportsRoot: string; logsRoot: string }
export type RuntimeEvents = { onLog?: (scope: string, line: string) => void; onState?: (scope: string, state: Record<string, unknown>) => void }
export type JavaSource = 'configured' | 'modcrafting-env' | 'java-home' | 'path' | 'discovered'
export type JavaCandidate = { path: string; source: JavaSource; version?: string; javac: boolean; ok: boolean; error?: string }
export type JavaStatus = { ok: boolean; version?: string; path?: string; source?: JavaSource; error?: string; javac?: boolean; candidates?: JavaCandidate[]; configPath?: string; configError?: string }
export type EnvironmentTarget = { id: string; loader: string; minecraft: string; status: string; javaTarget: number; runtimeObserver: boolean; reason?: string }
export type EnvironmentStatus = { ok: boolean; platform: string; node: string; java: JavaStatus; gradleWrapper: boolean; target: typeof FABRIC_TARGET; targets?: EnvironmentTarget[]; remediation: string[]; storage?: StorageStatus }
export type FabricProject = { path: string; valid: boolean; loader?: 'fabric' | 'neoforge' | 'forge'; modId?: string; minecraftVersion?: string; wrapperPath?: string; errors: string[] }
export type JobStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
export type JobSnapshot = { id: string; kind: string; sessionId?: string; status: JobStatus; startedAt: string; finishedAt?: string; output: string[]; pid?: number; result?: Record<string, unknown>; error?: string; code?: string }
export type CoreFailure = { ok: false; error: string; code: string }
export type BridgeResult = { ok: boolean; status: number; data: Record<string, unknown>; error?: string }
export type LocalAssetStatus = { name: string; path: string; status: 'missing' | 'present' | 'invalid'; error?: string; remediation?: string }
export type GameInstance = {
  instanceId: string
  sessionId?: string
  projectPath: string
  gameDirectory: string
  jobId: string
  preparationJobId?: string
  profile?: Record<string, unknown>
  /** Which launch path produced this process. Omitted means the legacy Gradle dev run. */
  launcher?: 'gradle' | 'standalone'
  /** Catalog key the instance was assembled for, e.g. `fabric@1.21.4`. */
  targetId?: string
}
export type TaskSession = {
  sessionId: string
  name: string
  /**
   * Compatibility projection of the active member's path. Every existing caller
   * (build, run, workspaces, reports) keeps reading this; it is never removed.
   */
  projectPath?: string
  /** Set whenever a workspace is bound. For a single-mod project this equals `projectPath`. */
  workspacePath?: string
  workspaceKind?: WorkspaceKind
  /** Which member the authoring tools act on. Defaults to `main`. */
  activeMemberId?: string
  status: 'active' | 'ended'
  createdAt: string
  updatedAt: string
  phase: string
  currentModule: string
  recommendedModules: string[]
  profile?: Record<string, unknown>
  jobs: JobSnapshot[]
  instances: GameInstance[]
}
export type CoreRuntimeState = { contractVersion: 1; backendId?: string; sessionId?: string; sessions?: TaskSession[]; jobs: JobSnapshot[]; instances: GameInstance[] }
export type GameRuntimeStatus = GameInstance & { ok: true; job: JobSnapshot | CoreFailure; bridgeReady: boolean; canRunTests: boolean; preparation: { phase: string; blockedReason?: string; screen?: Record<string, unknown>; job?: JobSnapshot | CoreFailure }; capabilities?: Record<string, unknown>; code?: string; message?: string }
export type CoreCapabilities = {
  contractVersion: 1; supportedAssertions: readonly string[]; unsupportedAssertions: readonly string[]
  entityQuery: { radius: 32; limit: 64; tagFilters: false }
  toolchain: { source: 'system'; automaticDownload: false; scaffoldIncludesWrapper: boolean }
}
export type CoreEnvironmentStatus = EnvironmentStatus & { contractVersion: 1; paths: RuntimePaths; assets: LocalAssetStatus[]; capabilities: CoreCapabilities }
