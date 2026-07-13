import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { app, shell } from 'electron'

export interface OpenCodeDetectResult {
  installed: boolean
  version?: string
  command?: string
  error?: string
}

export interface OpenCodeOpenResult {
  success: boolean
  error?: string
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Resolve opencode executable: bundled path (future), project node_modules, then PATH. */
export function resolveOpenCodeCommand(): string {
  const binName = isWindows() ? 'opencode.cmd' : 'opencode'

  const candidates: string[] = []

  try {
    const appPath = app.getAppPath()
    candidates.push(path.join(appPath, 'node_modules', '.bin', binName))
    candidates.push(path.join(appPath, 'node_modules', 'opencode-ai', 'bin', binName))
  } catch {
    // app not ready
  }

  candidates.push(path.join(process.cwd(), 'node_modules', '.bin', binName))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return isWindows() ? 'opencode.cmd' : 'opencode'
}

function spawnCapture(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      shell: isWindows(),
      windowsHide: true,
      env: process.env
    })
    let stdout = ''
    let stderr = ''
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          proc.kill()
          reject(new Error(`timeout after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      : null

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

export async function detectOpenCode(): Promise<OpenCodeDetectResult> {
  const command = resolveOpenCodeCommand()
  try {
    const result = await spawnCapture(command, ['--version'], { timeoutMs: 15_000 })
    const version = (result.stdout || result.stderr).trim().split('\n')[0]?.trim()
    if (result.code === 0 && version) {
      return { installed: true, version, command }
    }
    return {
      installed: false,
      command,
      error: (result.stderr || result.stdout || `exit ${result.code}`).trim()
    }
  } catch (err) {
    return {
      installed: false,
      command,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Launch opencode in a new terminal at projectPath (Windows: start cmd). */
export async function openProjectInOpenCode(projectPath: string): Promise<OpenCodeOpenResult> {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { success: false, error: '项目路径无效或不存在' }
  }

  const detect = await detectOpenCode()
  if (!detect.installed) {
    return {
      success: false,
      error: detect.error
        ? `未检测到 OpenCode：${detect.error}。请运行 npm i -g opencode-ai@latest`
        : '未检测到 OpenCode。请运行 npm i -g opencode-ai@latest'
    }
  }

  const command = detect.command || resolveOpenCodeCommand()
  const quotedPath = `"${projectPath.replace(/"/g, '')}"`
  const quotedCmd = `"${command.replace(/"/g, '')}"`

  try {
    if (isWindows()) {
      const child = spawn(
        'cmd.exe',
        ['/c', 'start', 'OpenCode', 'cmd.exe', '/k', `cd /d ${quotedPath} && ${quotedCmd}`],
        { detached: true, stdio: 'ignore', windowsHide: true }
      )
      child.unref()
      return { success: true }
    }

    if (process.platform === 'darwin') {
      const script = `cd ${JSON.stringify(projectPath)} && ${command}`
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`], {
        detached: true,
        stdio: 'ignore'
      }).unref()
      return { success: true }
    }

    const terminals = [
      ['x-terminal-emulator', '-e', 'bash', '-lc', `cd ${JSON.stringify(projectPath)} && exec ${command}`],
      ['gnome-terminal', '--', 'bash', '-lc', `cd ${JSON.stringify(projectPath)} && exec ${command}`],
      ['konsole', '-e', 'bash', '-lc', `cd ${JSON.stringify(projectPath)} && exec ${command}`]
    ]
    for (const args of terminals) {
      try {
        spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore' }).unref()
        return { success: true }
      } catch {
        continue
      }
    }

    await shell.openPath(projectPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
