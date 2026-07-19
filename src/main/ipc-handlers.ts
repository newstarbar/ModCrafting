import { ipcMain, dialog, BrowserWindow, app, shell, type IpcMainInvokeEvent } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  loadApiConfig,
  saveApiConfig,
  saveApiKey,
  getApiKey,
  clearApiKey
} from './api-config'
import {
  resolveJdkPath,
  ensureJdkReady,
  downloadJdk,
  ensureGradleWrapper,
  copyBundledGradle,
  ensureProjectToolchain,
  ensureProjectEnvironment,
  prepareBuild,
  runGradleTask,
  getToolchainStatus,
  checkRuntimeWritable,
  ensureGradleHomeFromSeed,
  loadFabricVersions,
  initToolchain,
  isGlobalToolchainReady,
  resetToolchainInitState,
  createWindowProgressSender,
  getAppEdition,
  searchLocalFabricSources
} from './build-env'
import { checkForUpdates, openReleasePages } from './updater'
import { lookupFabricSymbol, verifyFabricSymbolIndex, type FabricSymbolLookupRequest } from './fabric-metadata'
import {
  listRecentProjects,
  addRecentProject,
  removeRecentProject,
  clearRecentProjects,
  getLastRecentProject
} from './recent-projects'
import { loadAgentConfig, saveAgentConfig, type AgentConfig } from './agent-config'
import {
  fetchUrlText,
  listKnowledgeFiles,
  readKnowledgeFile,
  saveKnowledgeFile
} from './knowledge-service'
import { openExternalWithFallback } from './external-url'
import { clearBadge, notifyTaskComplete } from './app-badge'
import {
  loadProjectSessions,
  saveProjectSessions,
  saveCurrentSessionIdDisk
} from './session-store'

// Track active watchers
const watchers = new Map<string, fs.FSWatcher>()

export function setupIpcHandlers(): void {
  // Dialog: select project directory
  ipcMain.handle('dialog:selectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Dialog: select directory for new project
  ipcMain.handle('dialog:selectNewProjectDirectory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目存放位置'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // File system: list directory contents
  ipcMain.handle('fs:listDirectory', async (_event, dirPath: string) => {
    try {
      // Agent often passes a file path by mistake; avoid ENOTDIR stack spam.
      try {
        const st = fs.statSync(dirPath)
        if (!st.isDirectory()) return []
      } catch (statErr) {
        const statCode =
          statErr && typeof statErr === 'object' && 'code' in statErr
            ? String((statErr as NodeJS.ErrnoException).code)
            : ''
        if (statCode === 'ENOENT') return []
        // Fall through to readdir for other stat failures
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      return entries
        .filter((entry) => !entry.name.startsWith('.')) // hide hidden files
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: path.join(dirPath, entry.name)
        }))
        .sort((a, b) => {
          // directories first, then alphabetical
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.name.localeCompare(b.name)
        })
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as NodeJS.ErrnoException).code) : ''
      // ENOENT / ENOTDIR are expected when path is missing or is a file
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.error('fs:listDirectory error:', err)
      }
      return []
    }
  })

  // File system: read file content
  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // File system: write file content and notify renderer
  ipcMain.handle('fs:writeFile', async (event, filePath: string, content: string) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      // Notify all windows that a file changed
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file:changed', filePath)
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // File system: check if path exists
  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    return fs.existsSync(filePath)
  })

  // File system: create directory
  ipcMain.handle('fs:createDirectory', async (_event, dirPath: string) => {
    try {
      fs.mkdirSync(dirPath, { recursive: true })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // File system: delete file
  ipcMain.handle('fs:deleteFile', async (_event, filePath: string) => {
    try {
      fs.unlinkSync(filePath)
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('file:changed', filePath, 'delete')
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // Project: detect if a directory is a valid Gradle/Fabric project
  ipcMain.handle('project:detect', async (_event, projectPath: string) => {
    try {
      const hasBuildGradle = fs.existsSync(path.join(projectPath, 'build.gradle')) ||
                            fs.existsSync(path.join(projectPath, 'build.gradle.kts'))
      const hasFabricModJson = fs.existsSync(path.join(projectPath, 'src', 'main', 'resources', 'fabric.mod.json'))
      const hasGradleWrapper = fs.existsSync(path.join(projectPath, 'gradlew')) ||
                              fs.existsSync(path.join(projectPath, 'gradlew.bat'))
      return {
        isValid: hasBuildGradle,
        isFabric: hasFabricModJson,
        hasBuildGradle,
        hasFabricModJson,
        hasGradleWrapper
      }
    } catch {
      return { isValid: false, isFabric: false }
    }
  })

  ipcMain.handle('project:getFabricVersions', async () => loadFabricVersions())

  ipcMain.handle('fabric:lookupSymbol', async (_event, request: FabricSymbolLookupRequest) =>
    lookupFabricSymbol(request)
  )

  ipcMain.handle('fabric:verifySymbolIndex', async () => verifyFabricSymbolIndex())

  // Window: set title
  ipcMain.handle('window:setTitle', async (_event, title: string) => {
    BrowserWindow.getFocusedWindow()?.setTitle(title)
  })

  // Taskbar / Dock badge when a workflow completes while unfocused
  ipcMain.handle('app:notifyTaskComplete', async () => {
    notifyTaskComplete()
  })
  ipcMain.handle('app:clearBadge', async () => {
    clearBadge()
  })

  // File system: watch directory for changes
  ipcMain.handle('fs:watchDirectory', async (event, dirPath: string) => {
    // Stop existing watcher for this path
    const existing = watchers.get(dirPath)
    if (existing) {
      existing.close()
    }

    try {
      const watcher = fs.watch(dirPath, { recursive: true }, (eventType, filename) => {
        if (filename) {
          const fullPath = path.join(dirPath, filename)
          // Notify the renderer that a file changed
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('file:changed', fullPath, eventType)
          })
        }
      })
      watchers.set(dirPath, watcher)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // File system: stop watching directory
  ipcMain.handle('fs:unwatchDirectory', async (_event, dirPath: string) => {
    const watcher = watchers.get(dirPath)
    if (watcher) {
      watcher.close()
      watchers.delete(dirPath)
    }
    return { success: true }
  })

  // Execute a shell command (for AI agent tool use) - non-blocking async spawn
  ipcMain.handle('app:runCommand', async (_event, command: string, cwd: string) => {
    try {
      const { spawn } = require('child_process')
      return await new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill()
          resolve({ output: stdout + stderr + '\n[timeout after 5 minutes]', exitCode: -1 })
        }, 300000)
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
        child.on('close', (code: number | null) => {
          clearTimeout(timer)
          resolve({ output: stdout + stderr, exitCode: code ?? -1 })
        })
        child.on('error', (err: Error) => {
          clearTimeout(timer)
          resolve({ output: String(err), exitCode: -1 })
        })
      })
    } catch (err) {
      return { output: String(err), exitCode: -1 }
    }
  })

  // Run command with streaming output (for long-running commands like builds)
  ipcMain.handle('app:runCommandStream', async (event, command: string, cwd: string) => {
    try {
      const { spawn } = require('child_process')
      const child = spawn(command, { cwd, shell: true })
      let fullOutput = ''
      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        fullOutput += text
        event.sender.send('command:output', text)
      })
      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        fullOutput += text
        event.sender.send('command:output', text)
      })
      return await new Promise((resolve) => {
        child.on('close', (code: number | null) => {
          event.sender.send('command:done', { exitCode: code })
          resolve({ output: fullOutput, exitCode: code ?? -1 })
        })
        child.on('error', (err: Error) => {
          event.sender.send('command:done', { exitCode: -1, error: String(err) })
          resolve({ output: String(err), exitCode: -1 })
        })
      })
    } catch (err) {
      return { output: String(err), exitCode: -1 }
    }
  })

  // Recent projects
  ipcMain.handle('app:saveRecentProject', async (_event, projectPath: string) => {
    try {
      addRecentProject(projectPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('app:loadRecentProject', async () => {
    try {
      return { success: true, data: getLastRecentProject() }
    } catch (err) {
      return { success: false, error: String(err), data: null }
    }
  })

  ipcMain.handle('app:listRecentProjects', async () => listRecentProjects())

  ipcMain.handle('app:removeRecentProject', async (_event, projectPath: string) => {
    try {
      return { success: true, data: removeRecentProject(projectPath) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('app:clearRecentProjects', async () => {
    try {
      clearRecentProjects()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ── Bundled JDK / Gradle toolchain ──

  const ipcProgress = (event: IpcMainInvokeEvent) =>
    createWindowProgressSender((channel, payload) => {
      if (channel === 'env:toolchainProgress') {
        event.sender.send(channel, payload)
      } else {
        event.sender.send(channel, typeof payload === 'string' ? payload : payload.message)
      }
    })

  ipcMain.handle('env:initToolchain', async (event, force?: boolean) =>
    initToolchain(ipcProgress(event), Boolean(force))
  )

  ipcMain.handle('env:isToolchainReady', async () => isGlobalToolchainReady())

  ipcMain.handle('env:findJdk', async () => {
    const jdkPath = resolveJdkPath()
    if (jdkPath) {
      const javaBin = path.join(jdkPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
      return { found: true, path: jdkPath, java: javaBin }
    }
    return { found: false }
  })

  ipcMain.handle('env:ensureJdkReady', async (event) => ensureJdkReady(ipcProgress(event)))

  ipcMain.handle('env:downloadJdk', async (event) => downloadJdk(ipcProgress(event)))

  ipcMain.handle('env:ensureGradleWrapper', async (event, projectPath: string) =>
    ensureGradleWrapper(projectPath, ipcProgress(event))
  )

  ipcMain.handle('env:copyBundledGradle', async (_event, projectPath: string) =>
    copyBundledGradle(projectPath)
  )

  ipcMain.handle('env:ensureProjectEnvironment', async (event, projectPath: string) =>
    ensureProjectEnvironment(projectPath, ipcProgress(event))
  )

  ipcMain.handle('env:ensureProjectToolchain', async (event, projectPath: string) =>
    ensureProjectToolchain(projectPath, ipcProgress(event))
  )

  ipcMain.handle('env:prepareBuild', async (_event, projectPath: string) =>
    prepareBuild(projectPath)
  )

  ipcMain.handle('env:runGradleTask', async (event, projectPath: string, task: string) =>
    runGradleTask(projectPath, task, (text) => {
      event.sender.send('command:output', text)
    })
  )

  ipcMain.handle('env:getToolchainStatus', async () => getToolchainStatus())

  ipcMain.handle('env:ensureGradleHomeFromSeed', async (event) =>
    ensureGradleHomeFromSeed(ipcProgress(event))
  )

  ipcMain.handle('env:checkRuntimeWritable', async () => checkRuntimeWritable())

  ipcMain.handle('env:getEdition', async () => getAppEdition())

  ipcMain.handle('updater:check', async () => checkForUpdates(true))

  ipcMain.handle('updater:getVersion', async () => app.getVersion())

  ipcMain.handle('updater:openReleases', async () => {
    await openReleasePages()
    return { success: true }
  })

  // API config (non-sensitive settings + encrypted API key)
  ipcMain.handle('config:load', async () => loadApiConfig())

  ipcMain.handle('config:save', async (_event, config: { endpoint: string; model: string }) =>
    saveApiConfig(config)
  )

  ipcMain.handle('secrets:saveApiKey', async (_event, key: string, providerId?: string) =>
    saveApiKey(key, providerId)
  )

  ipcMain.handle('secrets:getApiKey', async (_event, providerId?: string) => getApiKey(providerId))

  ipcMain.handle('secrets:clearApiKey', async (_event, providerId?: string) => clearApiKey(providerId))

  ipcMain.handle('deepseek:balance', async (_event, apiKey?: string) => {
    const { fetchDeepSeekBalance } = await import('./deepseek-balance')
    return fetchDeepSeekBalance(typeof apiKey === 'string' ? apiKey : undefined)
  })

  ipcMain.handle('shell:openExternal', async (_event, url: string) => openExternalWithFallback(url))

  ipcMain.handle('shell:showItemInFolder', async (_event, targetPath: string) => {
    try {
      if (typeof targetPath !== 'string' || !targetPath.trim()) {
        return { success: false, error: '路径无效' }
      }
      const resolved = path.resolve(targetPath)
      if (!fs.existsSync(resolved)) {
        return { success: false, error: '文件不存在' }
      }
      shell.showItemInFolder(resolved)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('project:findExportJar', async (_event, projectPath: string) => {
    try {
      if (typeof projectPath !== 'string' || !projectPath.trim()) {
        return { success: false, error: '项目路径无效' }
      }
      const libsDir = path.join(path.resolve(projectPath), 'build', 'libs')
      if (!fs.existsSync(libsDir) || !fs.statSync(libsDir).isDirectory()) {
        return { success: false, error: '未找到 build/libs 目录' }
      }
      const candidates = fs
        .readdirSync(libsDir)
        .filter((name) => {
          if (!name.toLowerCase().endsWith('.jar')) return false
          const lower = name.toLowerCase()
          if (lower.endsWith('-sources.jar') || lower.endsWith('-javadoc.jar')) return false
          if (lower.includes('-dev')) return false
          return true
        })
        .map((name) => {
          const jarPath = path.join(libsDir, name)
          return { name, path: jarPath, mtime: fs.statSync(jarPath).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length === 0) {
        return { success: false, error: '构建成功但未找到可导出的 jar（已排除 sources/dev/javadoc）' }
      }
      const primary = candidates[0]
      return { success: true, jarPath: primary.path, jarName: primary.name }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle(
    'dialog:exportJar',
    async (event, sourcePath: string, suggestedName?: string) => {
      try {
        if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
          return { success: false, cancelled: false, path: '', name: '', error: '源文件路径无效' }
        }
        const resolved = path.resolve(sourcePath)
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
          return { success: false, cancelled: false, path: '', name: '', error: '源 jar 不存在' }
        }
        if (!resolved.toLowerCase().endsWith('.jar')) {
          return { success: false, cancelled: false, path: '', name: '', error: '仅支持导出 .jar 文件' }
        }
        const win = BrowserWindow.fromWebContents(event.sender)
        const defaultName = (suggestedName || path.basename(resolved)).replace(
          /[<>:"/\\|?*\x00-\x1f]/g,
          '_'
        )
        const saveOpts: Electron.SaveDialogOptions = {
          title: '导出模组 JAR',
          defaultPath: path.join(app.getPath('desktop'), defaultName),
          filters: [{ name: 'JAR', extensions: ['jar'] }]
        }
        const result = win
          ? await dialog.showSaveDialog(win, saveOpts)
          : await dialog.showSaveDialog(saveOpts)
        if (result.canceled || !result.filePath) {
          return { success: false, cancelled: true, path: '', name: '' }
        }
        let filePath = result.filePath
        if (!/\.jar$/i.test(filePath)) {
          filePath = `${filePath}.jar`
        }
        fs.copyFileSync(resolved, filePath)
        return {
          success: true,
          cancelled: false,
          path: filePath,
          name: path.basename(filePath)
        }
      } catch (err) {
        return {
          success: false,
          cancelled: false,
          path: '',
          name: '',
          error: String(err)
        }
      }
    }
  )

  // Agent config (knowledge sources, tool toggles, MCP placeholders)
  ipcMain.handle('agentConfig:load', async () => loadAgentConfig())

  ipcMain.handle('agentConfig:save', async (_event, config: AgentConfig) =>
    saveAgentConfig(config)
  )

  // Knowledge base: local md + remote fetch
  ipcMain.handle('knowledge:listFiles', async () => listKnowledgeFiles())

  ipcMain.handle('knowledge:readLocal', async (_event, relPath: string) =>
    readKnowledgeFile(relPath)
  )

  ipcMain.handle('knowledge:saveLocal', async (_event, relPath: string, content: string) =>
    saveKnowledgeFile(relPath, content)
  )

  ipcMain.handle('knowledge:fetchUrl', async (_event, url: string, maxChars?: number) =>
    fetchUrlText(url, maxChars)
  )

  ipcMain.handle('knowledge:searchLocalSources', async (_event, keyword: string, maxResults?: number) =>
    searchLocalFabricSources(keyword, maxResults ?? 5)
  )

  // Chat sessions — persisted under userData (survives Vite port / origin changes)
  ipcMain.handle('sessions:load', async (_event, projectPath: string | null) =>
    loadProjectSessions(projectPath)
  )

  ipcMain.handle(
    'sessions:save',
    async (
      _event,
      projectPath: string | null,
      sessions: unknown[],
      currentSessionId?: string | null,
      options?: { allowEmptyOverwrite?: boolean; projectCost?: number }
    ) => saveProjectSessions(projectPath, sessions as never, currentSessionId ?? null, options)
  )

  ipcMain.handle(
    'sessions:saveCurrent',
    async (_event, projectPath: string | null, currentSessionId: string | null) =>
      saveCurrentSessionIdDisk(projectPath, currentSessionId)
  )

  // Session export — save Markdown via system Save dialog
  ipcMain.handle('session:export', async (event, payload: string, suggestedName?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const base = (suggestedName || 'mc-session').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.md$/i, '')
    const defaultName = `${base}-${ts}.md`
    const desktopDir = app.getPath('desktop')
    const saveOpts: Electron.SaveDialogOptions = {
      title: '导出会话',
      defaultPath: path.join(desktopDir, defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    }
    const result = win
      ? await dialog.showSaveDialog(win, saveOpts)
      : await dialog.showSaveDialog(saveOpts)
    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true, path: '', name: '' }
    }
    let filePath = result.filePath
    if (!/\.md$/i.test(filePath)) {
      filePath = `${filePath}.md`
    }
    fs.writeFileSync(filePath, payload, 'utf-8')
    return { success: true, cancelled: false, path: filePath, name: path.basename(filePath) }
  })
}
