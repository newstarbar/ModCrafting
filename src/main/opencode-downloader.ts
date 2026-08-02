/**
 * opencode.exe 按需下载器（瘦包三期）。
 *
 * 把 opencode-ai/bin/opencode.exe（约 184MB 未压缩）从安装包移除，改为
 * 用户首启时从 Release 下载 opencode-windows-x64.tar.xz（预计 70-90MB）
 * 解压到 runtime/opencode/opencode.exe。下载失败仅 warning，AI 降级运行，
 * 不阻塞启动。
 *
 * 下载源：复用 seed-downloader 的 v1.0.0 Release（Gitee 主，GitHub 兜底）。
 * 压缩格式：.tar.xz（tar 包内仅含 opencode.exe），可复用 seed-downloader
 * 的 `tar -xJf` 解压模式，无需引入额外 xz 解压依赖。
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { getRuntimeRoot } from './build-env'
import { getSeedReleaseInfo } from './seed-downloader'
import { DOWNLOAD_USER_AGENT, getDownloadFetch } from './download-shared'
import { pickFastestUrls } from './download-probe'

const OPENCODE_ARCHIVE_NAME = 'opencode-windows-x64.tar.xz'
const OPENCODE_EXE_NAME = 'opencode.exe'
const OPENCODE_DIR = 'opencode'

type ProgressFn = (message: string, percent: number) => void

/** runtime/opencode/opencode.exe 的目标路径。 */
export function getOpencodeExePath(): string {
  return path.join(getRuntimeRoot(), OPENCODE_DIR, OPENCODE_EXE_NAME)
}

/** 检查 runtime/opencode/opencode.exe 是否已存在。 */
export function isOpencodeReady(): boolean {
  return fs.existsSync(getOpencodeExePath())
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await getDownloadFetch()(url, { redirect: 'follow', headers: { 'User-Agent': DOWNLOAD_USER_AGENT } })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
  const sink = fs.createWriteStream(destPath)
  try {
    for await (const chunk of res.body as unknown as NodeJS.ReadableStream) {
      sink.write(chunk)
    }
    sink.end()
    await new Promise<void>((resolve, reject) => {
      sink.on('finish', resolve)
      sink.on('error', reject)
    })
  } catch (err) {
    try { fs.unlinkSync(destPath) } catch { /* ignore */ }
    throw err
  }
}

function extractTarXz(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true })
    const child = spawn(
      'tar',
      ['-xJf', archivePath, '-C', destDir],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败 (tar exit ${code}): ${stderr}`))
    })
  })
}

/**
 * 下载并解压 opencode.exe 到 runtime/opencode/。
 *
 * 进度回调：percent 0-100 表示本次下载流程的内部进度。
 * 失败不抛错，返回 { ok, error }；调用方按需降级。
 */
export async function ensureOpencode(
  onProgress: ProgressFn = () => {}
): Promise<{ ok: boolean; error?: string }> {
  if (isOpencodeReady()) {
    onProgress('opencode 引擎已就绪', 100)
    return { ok: true }
  }

  const destDir = path.join(getRuntimeRoot(), OPENCODE_DIR)
  const staging = `${destDir}.staging`
  const archivePath = `${destDir}.tar.xz`

  // 清理残留
  for (const p of [staging, archivePath]) {
    if (fs.existsSync(p)) {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
      catch { /* ignore */ }
    }
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true })

  const { giteeBase, githubBase } = getSeedReleaseInfo()
  const giteeUrl = `${giteeBase}${OPENCODE_ARCHIVE_NAME}`
  const githubUrl = `${githubBase}${OPENCODE_ARCHIVE_NAME}`

  // 测速选优：Gitee/GitHub 按实测速度决定尝试顺序（会话缓存，仅首次探测；失败源排最后兜底）；结果经面板展示
  const ordered = await pickFastestUrls([
    { url: giteeUrl, label: 'Gitee' },
    { url: githubUrl, label: 'GitHub' }
  ])

  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const candidate of ordered) {
      onProgress(`下载 opencode 引擎（第 ${attempt} 次，${candidate.label}）…`, 10)
      const r = await tryDownloadAndExtract(candidate.url, archivePath, staging, destDir)
      if (r.ok) {
        try { fs.rmSync(archivePath, { force: true }) } catch { /* ignore */ }
        onProgress('opencode 引擎已就绪', 100)
        return { ok: true }
      }
      lastError = r.error || `${candidate.label} 下载失败`
      console.warn(`[opencode-downloader] ${candidate.label} 第 ${attempt} 次失败: ${lastError}`)
    }

    // 清理后重试
    for (const p of [staging, archivePath]) {
      try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt))
  }

  return { ok: false, error: `opencode 引擎下载失败: ${lastError}` }
}

async function tryDownloadAndExtract(
  url: string,
  archivePath: string,
  staging: string,
  destDir: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await downloadFile(url, archivePath)
    fs.mkdirSync(staging, { recursive: true })
    await extractTarXz(archivePath, staging)

    // 校验：staging 目录内应存在 opencode.exe
    const stagedExe = path.join(staging, OPENCODE_EXE_NAME)
    if (!fs.existsSync(stagedExe)) {
      throw new Error('解压后未找到 opencode.exe')
    }

    // 替换 destDir
    if (fs.existsSync(destDir)) {
      try { fs.rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
      catch {
        return { ok: false, error: `无法替换现有目录（${destDir} 被占用）` }
      }
    }
    fs.renameSync(staging, destDir)
    return { ok: true }
  } catch (err) {
    // 清理 staging
    try { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, error: String(err) }
  }
}
