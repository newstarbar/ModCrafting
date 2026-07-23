/// <reference types="vite/client" />

interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

interface ProjectInfo {
  isValid: boolean
  isFabric: boolean
  hasBuildGradle?: boolean
  hasFabricModJson?: boolean
  hasGradleWrapper?: boolean
}

interface FabricVersions {
  minecraft_version: string
  loader_version: string
  fabric_version: string
  yarn_mappings: string
  loom_version: string
  gradle_version: string
}

interface FabricMemberRecord {
  name: string
  descriptor: string
  static: boolean
}

interface FabricSymbolLookupRequest {
  className: string
  memberName?: string
  descriptor?: string
  memberKind?: 'method' | 'field' | 'any'
}

interface FabricSymbolLookupResult {
  ok: boolean
  version: string
  yarnMappings: string
  class?: {
    name: string
    side: 'common' | 'client'
    fields: FabricMemberRecord[]
    methods: FabricMemberRecord[]
  }
  methods: FabricMemberRecord[]
  fields: FabricMemberRecord[]
  suggestions: string[]
  ambiguous?: boolean
  error?: string
}

interface RecentProject {
  path: string
  name: string
  openedAt: string
}

interface FileResult {
  success: boolean
  content?: string
  error?: string
}

interface WriteResult {
  success: boolean
  error?: string
}

interface ModCraftingApi {
  selectDirectory: () => Promise<string | null>
  selectNewProjectDirectory: () => Promise<string | null>
  listDirectory: (dirPath: string) => Promise<FileEntry[]>
  readFile: (filePath: string) => Promise<FileResult>
  writeFile: (filePath: string, content: string) => Promise<WriteResult>
  deleteFile: (filePath: string) => Promise<WriteResult>
  exists: (filePath: string) => Promise<boolean>
  createDirectory: (dirPath: string) => Promise<WriteResult>
  detectProject: (projectPath: string) => Promise<ProjectInfo>
  getFabricVersions: () => Promise<FabricVersions>
  lookupFabricSymbol: (request: FabricSymbolLookupRequest) => Promise<FabricSymbolLookupResult>
  verifyFabricSymbolIndex: () => Promise<{ ok: boolean; error?: string; classes?: number }>
  setTitle: (title: string) => Promise<void>
  notifyTaskComplete: () => Promise<void>
  clearBadge: () => Promise<void>
  onMenuNewProject: (callback: () => void) => () => void
  onMenuOpenProject: (callback: () => void) => () => void
  onToolBuild: (callback: () => void) => () => void
  onToolRunClient: (callback: () => void) => () => void
  onToolStop: (callback: () => void) => () => void
  watchDirectory: (dirPath: string) => Promise<WriteResult>
  unwatchDirectory: (dirPath: string) => Promise<WriteResult>
  onFileChanged: (callback: (filePath: string, eventType?: string) => void) => () => void
  terminalCreate: (cwd?: string) => Promise<string>
  terminalWrite: (id: string, data: string) => Promise<WriteResult>
  terminalResize: (id: string, cols: number, rows: number) => Promise<WriteResult>
  terminalKill: (id: string) => Promise<WriteResult>
  terminalSetCwd: (id: string, cwd: string) => Promise<WriteResult>
  onTerminalData: (callback: (id: string, data: string) => void) => () => void
  mcCreateInstance: (projectPath: string, name?: string) => Promise<{id: string; name: string; status: string}>
  mcStart: (id: string) => Promise<WriteResult>
  mcStartOrCreate: (projectPath: string, name?: string) => Promise<WriteResult & { id?: string }>
  mcStop: (id: string) => Promise<WriteResult>
  mcStopAll: () => Promise<WriteResult>
  mcGetInstance: (id: string) => Promise<object | null>
  mcListInstances: () => Promise<object[]>
  mcGetCrashReport: (crashReportPath: string) => Promise<FileResult>
  mcDeleteInstance: (id: string) => Promise<WriteResult>
  mcBridgeStatus: (instanceId?: string) => Promise<{
    ready: boolean
    instanceId?: string
    status?: string
    port?: number | null
    modVersion?: string | null
    gameDir?: string | null
    error?: string
  }>
  mcBridgeCall: (payload: {
    instanceId?: string
    method?: 'GET' | 'POST'
    path: string
    body?: Record<string, unknown>
    timeoutMs?: number
  }) => Promise<{
    ok: boolean
    status: number
    data: Record<string, unknown>
    error?: string
  }>
  onMcLog: (callback: (id: string, text: string) => void) => () => void
  onMcStateChanged: (callback: (id: string, state: object) => void) => () => void
  onMcCrashed: (callback: (id: string, exitCode: number, crashReportPath: string | null) => void) => () => void
  saveRecentProject: (projectPath: string) => Promise<WriteResult>
  loadRecentProject: () => Promise<{ success: boolean; data: string | null; error?: string }>
  listRecentProjects: () => Promise<RecentProject[]>
  removeRecentProject: (projectPath: string) => Promise<{ success: boolean; data?: RecentProject[]; error?: string }>
  clearRecentProjects: () => Promise<WriteResult>
  runCommand: (command: string, cwd: string) => Promise<{ output: string; exitCode: number }>
  runCommandStream: (command: string, cwd: string) => Promise<{ output: string; exitCode: number }>
  onCommandOutput: (callback: (data: string) => void) => () => void
  onCommandDone: (callback: (result: { exitCode: number }) => void) => () => void
  // Environment
  findJdk: () => Promise<{ found: boolean; path?: string; java?: string }>
  downloadJdk: () => Promise<{ success: boolean; path?: string; error?: string }>
  onDownloadProgress: (callback: (msg: string) => void) => () => void
  onToolchainProgress: (callback: (payload: {
    phase: 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'
    message: string
    percent: number
    error?: string
  }) => void) => () => void
  initToolchain: (force?: boolean) => Promise<{ ok: boolean; error?: string }>
  isToolchainReady: () => Promise<boolean>
  ensureGradleWrapper: (projectPath: string) => Promise<{ exists: boolean; copied?: boolean; downloaded?: boolean; error?: string }>
  copyBundledGradle: (projectPath: string) => Promise<{ copied: boolean; reason?: string; error?: string }>
  ensureProjectToolchain: (projectPath: string) => Promise<{ ok: boolean; jdkReady: boolean; gradleReady: boolean; depsReady: boolean; errors: string[] }>
  ensureProjectEnvironment: (projectPath: string) => Promise<{ ok: boolean; errors: string[] }>
  ensureJdkReady: () => Promise<{ ok: boolean; path?: string; error?: string }>
  ensureGradleHomeFromSeed: () => Promise<{ ok: boolean; error?: string }>
  prepareBuild: (projectPath: string) => Promise<{ ok: boolean; jdkPath?: string; cmdPrefix: string; powershellEnv: string; error?: string }>
  runGradleTask: (projectPath: string, task: string) => Promise<{ output: string; exitCode: number; usedOnlineFallback: boolean }>
  getToolchainStatus: () => Promise<{ jdk: string; gradle: string; deps: string; jdkPath: string | null; runtimeRoot: string; isPackaged: boolean; edition: 'dev' | 'full' | 'portable' }>
  checkRuntimeWritable: () => Promise<{ writable: boolean; runtimeRoot: string; error?: string }>
  getEdition: () => Promise<'dev' | 'full' | 'portable'>
  checkForUpdates: () => Promise<{ ok: boolean; currentVersion: string; latestVersion?: string; hasUpdate?: boolean; source?: 'gitee' | 'github'; error?: string }>
  getAppVersion: () => Promise<string>
  openReleasePages: () => Promise<{ success: boolean }>
  onUpdateStatus: (callback: (payload: { phase: string; source?: string; percent?: number; error?: string }) => void) => () => void
  loadApiConfig: () => Promise<{ endpoint: string; model: string; providerId: string; hasApiKey: boolean; savedProviderIds: string[]; encryptionAvailable: boolean }>
  saveApiConfig: (config: { endpoint: string; model: string; providerId?: string }) => Promise<{ success: boolean; error?: string }>
  saveApiKey: (key: string, providerId?: string) => Promise<{ success: boolean; error?: string }>
  getApiKey: (providerId?: string) => Promise<{ success: boolean; apiKey?: string; error?: string }>
  clearApiKey: (providerId?: string) => Promise<{ success: boolean; error?: string }>
  fetchDeepSeekBalance: (apiKey?: string) => Promise<{
    success: boolean
    isAvailable?: boolean
    balances?: Array<{
      currency: string
      totalBalance: string
      grantedBalance: string
      toppedUpBalance: string
    }>
    displayCurrency?: string
    displayTotal?: string
    error?: string
  }>
  openExternalUrl: (url: string) => Promise<{ success: boolean; usedFallback?: boolean; error?: string }>
  showItemInFolder: (targetPath: string) => Promise<{ success: boolean; error?: string }>
  findExportJar: (
    projectPath: string
  ) => Promise<{ success: boolean; jarPath?: string; jarName?: string; error?: string }>
  exportJar: (
    sourcePath: string,
    suggestedName?: string
  ) => Promise<{
    success: boolean
    cancelled?: boolean
    path: string
    name: string
    error?: string
  }>
  loadAgentConfig: () => Promise<{
    knowledgeSourceOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }>
    disabledTools: string[]
    mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
    useOpenCodeDelegate?: boolean
    openCodeModel?: string
  }>
  saveAgentConfig: (config: {
    knowledgeSourceOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }>
    disabledTools: string[]
    mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
    useOpenCodeDelegate?: boolean
    openCodeModel?: string
  }) => Promise<{ success: boolean; error?: string }>
  listKnowledgeFiles: () => Promise<Array<{ path: string; bundled: boolean; overridden: boolean }>>
  knowledgeReadLocal: (relPath: string) => Promise<{ success: boolean; content?: string; source?: 'override' | 'bundled'; error?: string }>
  knowledgeSaveLocal: (relPath: string, content: string) => Promise<{ success: boolean; error?: string }>
  knowledgeFetchUrl: (url: string, maxChars?: number) => Promise<{
    success: boolean
    text?: string
    url: string
    truncated?: boolean
    error?: string
  }>
  sessionExport: (payload: string, suggestedName?: string) => Promise<{
    success: boolean
    cancelled?: boolean
    path: string
    name: string
  }>
  sessionsLoad: (projectPath: string | null) => Promise<{
    projectPath: string
    sessions: import('./types/chat').ChatSession[]
    currentSessionId: string | null
    projectCost: number
  }>
  sessionsSave: (
    projectPath: string | null,
    sessions: import('./types/chat').ChatSession[],
    currentSessionId?: string | null,
    options?: { allowEmptyOverwrite?: boolean; projectCost?: number }
  ) => Promise<{ success: boolean; error?: string; projectPath: string; skipped?: boolean }>
  sessionsSaveCurrent: (
    projectPath: string | null,
    currentSessionId: string | null
  ) => Promise<{ success: boolean; error?: string }>
  opencodeDetect: () => Promise<{ installed: boolean; version?: string; command?: string; error?: string }>
  opencodeOpenProject: (projectPath: string) => Promise<{ success: boolean; error?: string }>
  opencodeServerStart: (projectPath: string, config?: Record<string, unknown>) => Promise<{
    running: boolean
    url?: string
    port?: number
    projectPath?: string
    version?: string
    error?: string
  }>
  opencodeServerStop: () => Promise<{ success: boolean }>
  opencodeServerState: () => Promise<{
    running: boolean
    url?: string
    port?: number
    projectPath?: string
    version?: string
    error?: string
  }>
  opencodeSessionCreate: (title?: string) => Promise<{ id?: string; error?: string }>
  opencodeSessionPrompt: (sessionId: string, text: string, agent?: string) => Promise<{
    ok: boolean
    data?: unknown
    error?: string
  }>
  opencodeSessionAbort: (sessionId: string) => Promise<{ success: boolean }>
  onOpenCodeEvent: (callback: (payload: unknown) => void) => () => void
}

declare global {
  interface Window {
    api: ModCraftingApi
  }
}
