import { app, dialog, shell, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import * as fs from 'fs'
import * as path from 'path'
import { getDownloadFetch } from './download-shared'
import { wrapGithubProxy } from './github-mirror'

const { autoUpdater } = electronUpdater
import { is } from '@electron-toolkit/utils'
import { isFullEdition, isPortableEdition } from './edition'

const MANIFEST_TIMEOUT_MS = 8000

/**
 * 读取 Gitee 主仓 owner/repo（仅用于打开浏览器 Release 页让用户手动下载安装包）。
 *
 * Gitee Release 不再承载环境分片 / 知识库 / 辅助资源 —— 这些已迁移到 GitHub + gh.xmly.dev 代理。
 * 仅保留 Setup/Portable 两条浏览器下载入口（Gitee 浏览器下载不限速）。
 */
function loadGiteeRepo(): { owner: string; repo: string } {
  const candidates = [
    path.join(process.resourcesPath || '', 'gitee-config.json'),
    path.join(__dirname, '..', '..', 'build', 'gitee-config.json')
  ]
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { owner?: string; repo?: string }
      if (data.owner && data.repo) return { owner: data.owner, repo: data.repo }
    } catch {
      /* ignore */
    }
  }
  return { owner: 'chenmo-starry-sky', repo: 'mod-crafting' }
}

const giteeRepo = loadGiteeRepo()

// Manifest 仅从 GitHub 拉取（含 gh.xmly.dev 代理加速）。Gitee 不再承载 manifest。
const MANIFEST_URLS = {
  github: 'https://raw.githubusercontent.com/newstarbar/ModCrafting/main/packaging/update-manifest.json'
}

const DEFAULT_RELEASE_PAGES = {
  gitee: `https://gitee.com/${giteeRepo.owner}/${giteeRepo.repo}/releases`,
  github: 'https://github.com/newstarbar/ModCrafting/releases'
}

export type UpdateFeedInfo = {
  manifest: string
  setup: string
  portable: string
  releasesPage: string
}

export type UpdateManifest = {
  version: string
  releaseDate?: string
  notes?: string
  feeds: {
    // gitee 仅保留浏览器下载入口（Setup/Portable），不再承载 manifest
    gitee: UpdateFeedInfo
    // github 的 manifest/setup/portable URL 在打包时已包裹 gh.xmly.dev 代理前缀
    github: UpdateFeedInfo
  }
}

export type UpdateCheckResult = {
  ok: boolean
  currentVersion: string
  latestVersion?: string
  hasUpdate?: boolean
  manifest?: UpdateManifest
  source?: 'github' | 'github-proxy'
  error?: string
}

let pendingManifest: UpdateManifest | null = null
let pendingSource: 'github' | 'github-proxy' | null = null
let updateInstallRequested = false

export function isUpdateInstallRequested(): boolean {
  return updateInstallRequested
}
let downloadSource: 'github' | 'github-proxy' | null = null
let checking = false

function compareVersions(remote: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const r = parse(remote)
  const c = parse(current)
  const len = Math.max(r.length, c.length)
  for (let i = 0; i < len; i++) {
    const a = r[i] || 0
    const b = c[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await getDownloadFetch()(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchManifestFrom(source: 'github' | 'github-proxy'): Promise<UpdateManifest | null> {
  const url = source === 'github-proxy' ? wrapGithubProxy(MANIFEST_URLS.github) : MANIFEST_URLS.github
  const res = await fetchWithTimeout(url, MANIFEST_TIMEOUT_MS)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as UpdateManifest
  if (!data?.version || !data?.feeds?.github) {
    throw new Error('Invalid manifest')
  }
  return data
}

/**
 * 依次尝试 GitHub 代理（gh.xmly.dev 包裹 raw URL）→ GitHub 直连。
 * 不再查 Gitee：Gitee 已不承载 manifest。
 */
export async function fetchManifestWithFallback(): Promise<{
  manifest: UpdateManifest
  source: 'github' | 'github-proxy'
} | null> {
  const order: Array<'github-proxy' | 'github'> = ['github-proxy', 'github']
  const results = await Promise.allSettled(order.map((src) => fetchManifestFrom(src)))

  for (let i = 0; i < order.length; i++) {
    const result = results[i]
    if (result.status === 'fulfilled' && result.value) {
      return { manifest: result.value, source: order[i] }
    }
  }
  return null
}

export async function checkForUpdates(manual = false): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()

  if (is.dev) {
    return { ok: true, currentVersion, hasUpdate: false, error: manual ? '开发模式不检查更新' : undefined }
  }

  if (checking) {
    return { ok: false, currentVersion, error: '正在检查更新…' }
  }

  checking = true
  try {
    const fetched = await fetchManifestWithFallback()
    if (!fetched) {
      return {
        ok: false,
        currentVersion,
        error: '无法连接更新服务器（GitHub / 加速代理均不可用）'
      }
    }

    const { manifest, source } = fetched
    const hasUpdate = compareVersions(manifest.version, currentVersion)

    if (hasUpdate) {
      pendingManifest = manifest
      pendingSource = source
    }

    return { ok: true, currentVersion, latestVersion: manifest.version, hasUpdate, manifest, source }
  } catch (err) {
    return { ok: false, currentVersion, error: String(err) }
  } finally {
    checking = false
  }
}

function feedBaseUrl(manifest: UpdateManifest): string {
  // feeds.github.manifest 在打包时已包裹 gh.xmly.dev 代理前缀，直接作为 autoUpdater feed URL。
  const manifestUrl = manifest.feeds.github.manifest
  return manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1)
}

function configureAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null
}

function sendUpdateStatus(payload: object): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send('updater:status', payload)
  })
}

/**
 * 使用 GitHub 源（含 gh.xmly.dev 代理）下载更新。
 * electron-updater setFeedURL 单 URL 限制：直接用 manifest 中的代理 URL（已包裹），
 * 失败时调用方引导用户打开浏览器手动下载。
 */
async function downloadFromSource(manifest: UpdateManifest): Promise<boolean> {
  const base = feedBaseUrl(manifest)
  autoUpdater.setFeedURL({ provider: 'generic', url: base })
  downloadSource = 'github-proxy'
  sendUpdateStatus({ phase: 'downloading', source: downloadSource, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    console.error(`Update download failed (github-proxy):`, err)
    return false
  }
}

export async function promptAndDownloadUpdate(manifest: UpdateManifest): Promise<void> {
  const notes = manifest.notes || `ModCrafting ${manifest.version}`
  const confirm = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 v${manifest.version}（当前 v${app.getVersion()}）`,
    detail: `${notes}\n\n更新源：GitHub 加速代理\n是否下载并安装？`,
    buttons: ['下载更新', '稍后'],
    defaultId: 0,
    cancelId: 1
  })

  if (confirm.response !== 0) return

  const ok = await downloadFromSource(manifest)
  if (!ok) {
    await dialog.showMessageBox({
      type: 'error',
      title: '更新下载失败',
      message: 'GitHub 加速代理下载失败',
      detail: '请通过浏览器从 Gitee 或 GitHub 发布页手动下载安装包。',
      buttons: ['打开发布页', '关闭']
    }).then((r) => {
      if (r.response === 0) void openReleasePages(manifest)
    })
  }
}

/**
 * 打开浏览器 Release 页：
 * - 便携版 / 安装包失败兜底：同时打开 Gitee + GitHub Release 页（Gitee 浏览器下载不限速）。
 * - Gitee Release 仅承载 Setup/Portable，环境产物请见 GitHub Release。
 */
export async function openReleasePages(manifest?: UpdateManifest | null): Promise<void> {
  const gitee = manifest?.feeds?.gitee?.releasesPage || DEFAULT_RELEASE_PAGES.gitee
  const github = manifest?.feeds?.github?.releasesPage || DEFAULT_RELEASE_PAGES.github
  await shell.openExternal(gitee)
  await shell.openExternal(github)
}

async function onUpdateDownloaded(): Promise<void> {
  const confirm = await dialog.showMessageBox({
    type: 'info',
    title: '更新已就绪',
    message: '新版本已下载完成',
    detail: '是否立即重启并安装？',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1
  })
  if (confirm.response === 0) {
    updateInstallRequested = true
    autoUpdater.quitAndInstall(false, true)
  }
}

export async function runUpdateCheckFlow(manual: boolean): Promise<void> {
  if (isPortableEdition()) {
    const result = await checkForUpdates(manual)
    if (!result.ok) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'warning',
          title: '检查更新',
          message: result.error || '无法检查更新',
          buttons: ['打开发布页', '关闭']
        }).then((r) => {
          if (r.response === 0) void openReleasePages()
        })
      }
      return
    }
    if (!result.hasUpdate) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: '检查更新',
          message: '已是最新版本',
          detail: `当前版本 v${result.currentVersion}`
        })
      }
      return
    }
    await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `便携版最新版本 v${result.latestVersion}`,
      detail: '便携版不支持应用内自动升级，请从发布页下载新版 Portable 并替换旧文件。\n（Gitee / GitHub 均可浏览器下载）',
      buttons: ['打开发布页', '稍后']
    }).then((r) => {
      if (r.response === 0) void openReleasePages(result.manifest)
    })
    return
  }

  if (!isFullEdition()) return

  const result = await checkForUpdates(manual)
  if (!result.ok) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'warning',
        title: '检查更新',
        message: result.error || '无法连接更新服务器',
        detail: '请稍后重试，或访问 GitHub 发布页手动下载。',
        buttons: ['打开发布页', '关闭']
      }).then((r) => {
        if (r.response === 0) void openReleasePages()
      })
    }
    return
  }

  if (!result.hasUpdate) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '已是最新版本',
        detail: `当前版本 v${result.currentVersion}（源：${result.source}）`
      })
    }
    return
  }

  if (result.manifest) {
    await promptAndDownloadUpdate(result.manifest)
  }
}

export function initUpdater(): void {
  if (is.dev || !isFullEdition()) return

  configureAutoUpdater()

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      phase: 'downloading',
      source: downloadSource,
      percent: Math.round(progress.percent || 0)
    })
  })

  autoUpdater.on('update-downloaded', () => {
    sendUpdateStatus({ phase: 'downloaded', source: downloadSource })
    void onUpdateDownloaded()
  })

  autoUpdater.on('error', (err) => {
    console.error('autoUpdater error:', err)
    sendUpdateStatus({ phase: 'error', error: String(err) })
  })

  setTimeout(() => {
    void runUpdateCheckFlow(false)
  }, 5000)
}

export function getPendingUpdateInfo(): { manifest: UpdateManifest | null; source: 'github' | 'github-proxy' | null } {
  return { manifest: pendingManifest, source: pendingSource }
}
