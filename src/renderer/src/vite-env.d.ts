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
  exists: (filePath: string) => Promise<boolean>
  createDirectory: (dirPath: string) => Promise<WriteResult>
  detectProject: (projectPath: string) => Promise<ProjectInfo>
  getFabricVersions: () => Promise<FabricVersions>
  setTitle: (title: string) => Promise<void>
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
  loadApiConfig: () => Promise<{ endpoint: string; model: string; providerId: string; hasApiKey: boolean; encryptionAvailable: boolean }>
  saveApiConfig: (config: { endpoint: string; model: string; providerId?: string }) => Promise<{ success: boolean; error?: string }>
  saveApiKey: (key: string) => Promise<{ success: boolean; error?: string }>
  getApiKey: () => Promise<{ success: boolean; apiKey?: string; error?: string }>
  clearApiKey: () => Promise<{ success: boolean; error?: string }>
  loadAgentConfig: () => Promise<{
    knowledgeSourceOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }>
    disabledTools: string[]
    mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
  }>
  saveAgentConfig: (config: {
    knowledgeSourceOverrides: Array<{ id: string; title?: string; url?: string; useFor?: string; enabled?: boolean }>
    disabledTools: string[]
    mcpServers: Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }>
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
}

declare global {
  interface Window {
    api: ModCraftingApi
  }
}
