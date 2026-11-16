import { execFile } from 'node:child_process'
import path from 'node:path'
import { inspectFabricProject } from '../../../packages/modcrafting-core/src/node.ts'

/**
 * How the workbench URL reaches the user.
 * - `system`  launch the OS browser through PowerShell (win32 only, legacy behaviour)
 * - `builtin` do not launch anything: return a hand-off the host agent can pass to its own
 *             embedded browser (WorkBuddy: `present_files`). No shell, no extra process.
 * - `link`    return the URL only.
 * - `auto`    resolved from the server start-up flag, defaulting to `system`.
 */
export type WorkbenchMode = 'auto' | 'system' | 'builtin' | 'link'

export async function launchBrowser(url: string): Promise<void> {
  if (process.platform !== 'win32') throw Error('当前系统不支持自动打开，请点击工作台链接。')
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:MODCRAFTING_BROWSER_URL"], {
      windowsHide: true, timeout: 8000, env: { ...process.env, MODCRAFTING_BROWSER_URL: url }
    }, (error) => error ? reject(error) : resolve())
  })
}

/** Always targets the same backend as the calling MCP session. Never creates another owner. */
export async function openWorkbench(
  baseUrl: string | undefined,
  options: { projectPath?: string; view?: string; open?: boolean; sessionId?: string; backendId?: string; mode?: WorkbenchMode; defaultMode?: Exclude<WorkbenchMode, 'auto'> },
  open = launchBrowser
) {
  if (!baseUrl) return { ok: false, code: 'WORKBENCH_DISABLED', message: '工作台服务尚未启用，请用包含 --web 的完整插件包重新连接。' }
  const url = new URL(baseUrl), fragment = new URLSearchParams(url.hash.slice(1))
  if (options.projectPath) {
    if (!path.isAbsolute(options.projectPath)) throw Error('工程路径需要使用绝对路径。')
    const project = inspectFabricProject(options.projectPath)
    if (!project.valid || project.minecraftVersion !== '1.21.4') return { ok: false, code: 'PROJECT_UNAVAILABLE', message: '当前文件夹还不是可编辑的 Fabric 1.21.4 工程，请先创建或选择工程。', errors: project.errors }
    fragment.set('project', project.path)
  }
  if (!options.sessionId) throw Error('打开工作台需要任务 sessionId。')
  if (!options.backendId) throw Error('当前工作台后端标识不可用，请重新连接插件。')
  fragment.set('sessionId', options.sessionId)
  fragment.set('backendId', options.backendId)
  fragment.set('view', options.view || 'overview'); url.hash = fragment.toString()
  const mode: Exclude<WorkbenchMode, 'auto'> = options.mode && options.mode !== 'auto' ? options.mode : options.defaultMode ?? 'system'
  if (options.open === false || mode === 'link') return { ok: true, browserUrl: url.href, opened: false, mode: 'link', message: '工作台链接已准备好。' }
  if (mode === 'builtin') {
    return {
      ok: true, browserUrl: url.href, opened: false, mode: 'builtin',
      suggestedTool: { name: 'present_files', arguments: { files: [url.href] } },
      message: '工作台地址已就绪。请调用 present_files 在宿主内置浏览器中打开；在用户确认看到页面之前，不要说“已打开”。'
    }
  }
  try {
    await open(url.href)
    return { ok: true, browserUrl: url.href, opened: true, mode: 'system', message: '已请求系统浏览器打开工作台；请在浏览器中查看。', visibilityConfirmed: false }
  } catch {
    return { ok: true, browserUrl: url.href, opened: false, mode: 'system', code: 'BROWSER_OPEN_FAILED', message: '浏览器未能自动打开，请点击此工作台链接。' }
  }
}
