import { contextBridge, ipcRenderer } from 'electron'

export interface FileEntry {
  name: string
  isDirectory: boolean
  path: string
}

export interface ProjectInfo {
  isValid: boolean
  isFabric: boolean
  hasBuildGradle?: boolean
  hasFabricModJson?: boolean
  hasGradleWrapper?: boolean
}

export interface FabricVersions {
  minecraft_version: string
  loader_version: string
  fabric_version: string
  yarn_mappings: string
  loom_version: string
  gradle_version: string
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface FileResult {
  success: boolean
  content?: string
  error?: string
}

export interface WriteResult {
  success: boolean
  error?: string
}

// Expose a safe API to the renderer
const api = {
  // Dialog
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory'),
  selectNewProjectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectNewProjectDirectory'),

  // File system
  listDirectory: (dirPath: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke('fs:listDirectory', dirPath),
  readFile: (filePath: string): Promise<FileResult> =>
    ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string): Promise<WriteResult> =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  exists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('fs:exists', filePath),
  createDirectory: (dirPath: string): Promise<WriteResult> =>
    ipcRenderer.invoke('fs:createDirectory', dirPath),

  // Project
  detectProject: (projectPath: string): Promise<ProjectInfo> =>
    ipcRenderer.invoke('project:detect', projectPath),
  getFabricVersions: (): Promise<FabricVersions> =>
    ipcRenderer.invoke('project:getFabricVersions'),

  // Window
  setTitle: (title: string): Promise<void> =>
    ipcRenderer.invoke('window:setTitle', title),

  // Menu event listeners
  onMenuNewProject: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('menu:new-project', handler)
    return () => ipcRenderer.removeListener('menu:new-project', handler)
  },
  onMenuOpenProject: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('menu:open-project', handler)
    return () => ipcRenderer.removeListener('menu:open-project', handler)
  },
  onToolBuild: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('tool:build', handler)
    return () => ipcRenderer.removeListener('tool:build', handler)
  },
  onToolRunClient: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('tool:run-client', handler)
    return () => ipcRenderer.removeListener('tool:run-client', handler)
  },
  onToolStop: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('tool:stop', handler)
    return () => ipcRenderer.removeListener('tool:stop', handler)
  },

  // File watching
  watchDirectory: (dirPath: string): Promise<WriteResult> =>
    ipcRenderer.invoke('fs:watchDirectory', dirPath),
  unwatchDirectory: (dirPath: string): Promise<WriteResult> =>
    ipcRenderer.invoke('fs:unwatchDirectory', dirPath),

  // File change listener (triggered by main process when files are written or changed externally)
  onFileChanged: (callback: (filePath: string, eventType?: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, filePath: string, eventType?: string): void =>
      callback(filePath, eventType)
    ipcRenderer.on('file:changed', handler)
    return () => ipcRenderer.removeListener('file:changed', handler)
  },

  // Terminal
  terminalCreate: (cwd?: string): Promise<string> =>
    ipcRenderer.invoke('terminal:create', cwd),
  terminalWrite: (id: string, data: string): Promise<WriteResult> =>
    ipcRenderer.invoke('terminal:write', id, data),
  terminalResize: (id: string, cols: number, rows: number): Promise<WriteResult> =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  terminalKill: (id: string): Promise<WriteResult> =>
    ipcRenderer.invoke('terminal:kill', id),
  terminalSetCwd: (id: string, cwd: string): Promise<WriteResult> =>
    ipcRenderer.invoke('terminal:setCwd', id, cwd),

  // Terminal data listener
  onTerminalData: (callback: (id: string, data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, data: string): void =>
      callback(id, data)
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },

  // MC Runtime
  mcCreateInstance: (projectPath: string, name?: string): Promise<{id: string; name: string; status: string}> =>
    ipcRenderer.invoke('mc:createInstance', projectPath, name),
  mcStart: (id: string): Promise<WriteResult> =>
    ipcRenderer.invoke('mc:start', id),
  mcStartOrCreate: (projectPath: string, name?: string): Promise<WriteResult & { id?: string }> =>
    ipcRenderer.invoke('mc:startOrCreate', projectPath, name),
  mcStop: (id: string): Promise<WriteResult> =>
    ipcRenderer.invoke('mc:stop', id),
  mcStopAll: (): Promise<WriteResult> =>
    ipcRenderer.invoke('mc:stopAll'),
  mcGetInstance: (id: string): Promise<object | null> =>
    ipcRenderer.invoke('mc:getInstance', id),
  mcListInstances: (): Promise<object[]> =>
    ipcRenderer.invoke('mc:listInstances'),
  mcGetCrashReport: (crashReportPath: string): Promise<FileResult> =>
    ipcRenderer.invoke('mc:getCrashReport', crashReportPath),
  mcDeleteInstance: (id: string): Promise<WriteResult> =>
    ipcRenderer.invoke('mc:deleteInstance', id),

  // MC Runtime listeners
  onMcLog: (callback: (id: string, text: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, text: string): void => callback(id, text)
    ipcRenderer.on('mc:log', handler)
    return () => ipcRenderer.removeListener('mc:log', handler)
  },
  onMcStateChanged: (callback: (id: string, state: object) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, state: object): void => callback(id, state)
    ipcRenderer.on('mc:stateChanged', handler)
    return () => ipcRenderer.removeListener('mc:stateChanged', handler)
  },
  onMcCrashed: (callback: (id: string, exitCode: number, crashReportPath: string | null) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number, crashReportPath: string | null): void =>
      callback(id, exitCode, crashReportPath)
    ipcRenderer.on('mc:crashed', handler)
    return () => ipcRenderer.removeListener('mc:crashed', handler)
  },

  // Recent projects
  saveRecentProject: (projectPath: string): Promise<WriteResult> =>
    ipcRenderer.invoke('app:saveRecentProject', projectPath),
  loadRecentProject: (): Promise<{ success: boolean; data: string | null; error?: string }> =>
    ipcRenderer.invoke('app:loadRecentProject'),
  listRecentProjects: (): Promise<RecentProject[]> =>
    ipcRenderer.invoke('app:listRecentProjects'),
  removeRecentProject: (projectPath: string): Promise<{ success: boolean; data?: RecentProject[]; error?: string }> =>
    ipcRenderer.invoke('app:removeRecentProject', projectPath),
  clearRecentProjects: (): Promise<WriteResult> =>
    ipcRenderer.invoke('app:clearRecentProjects'),

  // Run command (for AI agent)
  runCommand: (command: string, cwd: string): Promise<{ output: string; exitCode: number }> =>
    ipcRenderer.invoke('app:runCommand', command, cwd),

  // Run command with streaming output (for builds)
  runCommandStream: (command: string, cwd: string): Promise<{ output: string; exitCode: number }> =>
    ipcRenderer.invoke('app:runCommandStream', command, cwd),

  // Listen for streaming command output
  onCommandOutput: (callback: (data: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on('command:output', handler)
    return () => ipcRenderer.removeListener('command:output', handler)
  },
  onCommandDone: (callback: (result: { exitCode: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: { exitCode: number }) => callback(result)
    ipcRenderer.on('command:done', handler)
    return () => ipcRenderer.removeListener('command:done', handler)
  },

  // Environment management
  findJdk: (): Promise<{ found: boolean; path?: string; java?: string }> =>
    ipcRenderer.invoke('env:findJdk'),
  downloadJdk: (): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('env:downloadJdk'),
  onDownloadProgress: (callback: (msg: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: string) => callback(msg)
    ipcRenderer.on('env:downloadProgress', handler)
    return () => ipcRenderer.removeListener('env:downloadProgress', handler)
  },
  onToolchainProgress: (callback: (payload: {
    phase: 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'
    message: string
    percent: number
    error?: string
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: {
      phase: 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'
      message: string
      percent: number
      error?: string
    }) => callback(payload)
    ipcRenderer.on('env:toolchainProgress', handler)
    return () => ipcRenderer.removeListener('env:toolchainProgress', handler)
  },
  initToolchain: (force?: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('env:initToolchain', force),
  isToolchainReady: (): Promise<boolean> =>
    ipcRenderer.invoke('env:isToolchainReady'),
  ensureGradleWrapper: (projectPath: string): Promise<{ exists: boolean; copied?: boolean; downloaded?: boolean; error?: string }> =>
    ipcRenderer.invoke('env:ensureGradleWrapper', projectPath),
  copyBundledGradle: (projectPath: string): Promise<{ copied: boolean; reason?: string; error?: string }> =>
    ipcRenderer.invoke('env:copyBundledGradle', projectPath),
  ensureProjectToolchain: (projectPath: string): Promise<{ ok: boolean; jdkReady: boolean; gradleReady: boolean; depsReady: boolean; errors: string[] }> =>
    ipcRenderer.invoke('env:ensureProjectToolchain', projectPath),
  ensureProjectEnvironment: (projectPath: string): Promise<{ ok: boolean; errors: string[] }> =>
    ipcRenderer.invoke('env:ensureProjectEnvironment', projectPath),
  ensureJdkReady: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('env:ensureJdkReady'),
  ensureGradleHomeFromSeed: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('env:ensureGradleHomeFromSeed'),
  prepareBuild: (projectPath: string): Promise<{
    ok: boolean
    jdkPath?: string
    cmdPrefix: string
    powershellEnv: string
    error?: string
  }> => ipcRenderer.invoke('env:prepareBuild', projectPath),
  runGradleTask: (projectPath: string, task: string): Promise<{ output: string; exitCode: number; usedOnlineFallback: boolean }> =>
    ipcRenderer.invoke('env:runGradleTask', projectPath, task),
  getToolchainStatus: (): Promise<{ jdk: string; gradle: string; deps: string; jdkPath: string | null; runtimeRoot: string; isPackaged: boolean }> =>
    ipcRenderer.invoke('env:getToolchainStatus'),
  checkRuntimeWritable: (): Promise<{ writable: boolean; runtimeRoot: string; error?: string }> =>
    ipcRenderer.invoke('env:checkRuntimeWritable'),

  // API config & secrets
  loadApiConfig: (): Promise<{ endpoint: string; model: string; hasApiKey: boolean; encryptionAvailable: boolean }> =>
    ipcRenderer.invoke('config:load'),
  saveApiConfig: (config: { endpoint: string; model: string }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('config:save', config),
  saveApiKey: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('secrets:saveApiKey', key),
  getApiKey: (): Promise<{ success: boolean; apiKey?: string; error?: string }> =>
    ipcRenderer.invoke('secrets:getApiKey'),
  clearApiKey: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('secrets:clearApiKey')
}

contextBridge.exposeInMainWorld('api', api)
