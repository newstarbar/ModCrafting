import { app, dialog, shell, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { isFullEdition, isPortableEdition } from './edition'

const MANIFEST_TIMEOUT_MS = 8000

const MANIFEST_URLS = {
  gitee: 'https://gitee.com/newstarbar/ModCrafting/raw/main/build/update-manifest.json',
  github: 'https://raw.githubusercontent.com/newstarbar/ModCrafting/main/build/update-manifest.json'
}

const DEFAULT_RELEASE_PAGES = {
  gitee: 'https://gitee.com/newstarbar/ModCrafting/releases',
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
    gitee: UpdateFeedInfo
    github: UpdateFeedInfo
  }
}

export type UpdateCheckResult = {
  ok: boolean
  currentVersion: string
  latestVersion?: string
  hasUpdate?: boolean
  manifest?: UpdateManifest
  source?: 'gitee' | 'github'
  error?: string
}

let pendingManifest: UpdateManifest | null = null
let pendingSource: 'gitee' | 'github' | null = null
let downloadSource: 'gitee' | 'github' | null = null
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

function preferredMirror(): 'gitee' | 'github' {
  const forced = process.env.MODCRAFTING_UPDATE_MIRROR?.toLowerCase()
  if (forced === 'github' || forced === 'gitee') return forced
  return 'gitee'
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchManifestFrom(source: 'gitee' | 'github'): Promise<UpdateManifest | null> {
  const res = await fetchWithTimeout(MANIFEST_URLS[source], MANIFEST_TIMEOUT_MS)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as UpdateManifest
  if (!data?.version || !data?.feeds?.gitee || !data?.feeds?.github) {
    throw new Error('Invalid manifest')
  }
  return data
}

export async function fetchManifestWithFallback(): Promise<{
  manifest: UpdateManifest
  source: 'gitee' | 'github'
} | null> {
  const order: Array<'gitee' | 'github'> =
    preferredMirror() === 'gitee' ? ['gitee', 'github'] : ['github', 'gitee']

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
        error: '无法连接更新服务器（Gitee / GitHub 均超时或不可用）'
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

function feedBaseUrl(manifest: UpdateManifest, source: 'gitee' | 'github'): string {
  const manifestUrl = manifest.feeds[source].manifest
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

async function downloadFromSource(source: 'gitee' | 'github', manifest: UpdateManifest): Promise<boolean> {
  const base = feedBaseUrl(manifest, source)
  autoUpdater.setFeedURL({ provider: 'generic', url: base })
  downloadSource = source
  sendUpdateStatus({ phase: 'downloading', source, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    console.error(`Update download failed (${source}):`, err)
    return false
  }
}

export async function promptAndDownloadUpdate(manifest: UpdateManifest, source: 'gitee' | 'github'): Promise<void> {
  const notes = manifest.notes || `ModCrafting ${manifest.version}`
  const confirm = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 v${manifest.version}（当前 v${app.getVersion()}）`,
    detail: `${notes}\n\n更新源：${source === 'gitee' ? 'Gitee（国内优先）' : 'GitHub'}\n是否下载并安装？`,
    buttons: ['下载更新', '稍后'],
    defaultId: 0,
    cancelId: 1
  })

  if (confirm.response !== 0) return

  let ok = await downloadFromSource(source, manifest)
  if (!ok) {
    const fallback: 'gitee' | 'github' = source === 'gitee' ? 'github' : 'gitee'
    const retry = await dialog.showMessageBox({
      type: 'warning',
      title: '下载失败',
      message: `${source === 'gitee' ? 'Gitee' : 'GitHub'} 源下载失败`,
      detail: `是否尝试从 ${fallback === 'gitee' ? 'Gitee' : 'GitHub'} 重新下载？`,
      buttons: ['重试', '手动下载', '取消'],
      defaultId: 0,
      cancelId: 2
    })
    if (retry.response === 0) {
      ok = await downloadFromSource(fallback, manifest)
    } else if (retry.response === 1) {
      await openReleasePages(manifest)
      return
    }
  }

  if (!ok) {
    await dialog.showMessageBox({
      type: 'error',
      title: '更新下载失败',
      message: '无法完成自动下载',
      detail: '请通过浏览器从 Gitee 或 GitHub 发布页手动下载安装包。',
      buttons: ['打开发布页', '关闭']
    }).then((r) => {
      if (r.response === 0) void openReleasePages(manifest)
    })
  }
}

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
      detail: '便携版不支持应用内自动升级，请从发布页下载新版 Portable 并替换旧文件。',
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
        detail: '国内用户可优先访问 Gitee 发布页手动下载。',
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

  if (result.manifest && result.source) {
    await promptAndDownloadUpdate(result.manifest, result.source)
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

export function getPendingUpdateInfo(): { manifest: UpdateManifest | null; source: 'gitee' | 'github' | null } {
  return { manifest: pendingManifest, source: pendingSource }
}
