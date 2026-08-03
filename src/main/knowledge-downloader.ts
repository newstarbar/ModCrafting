/**
 * 知识库与辅助资源按需下载器（瘦包二期）。
 *
 * 把 mc-wiki-model / minecraft-data / mc-wiki-zh / mc-wiki-zh-index /
 * agent-knowledge / fabric-symbol-index / _base_mods 共约 34MB 从
 * 安装包 extraResources 移除，改为用户首启时从 Release 下载 zip 解压到
 * runtime/knowledge/。下载失败仅 warning，AI 降级运行，不阻塞启动。
 *
 * 下载源分工：
 *   - 知识库 4 件（minecraft-data / mc-wiki-zh / mc-wiki-zh-index / mc-wiki-model）
 *     从 ModCrafting-knowledge-base 仓库 Release 下载（Gitee 主，GitHub 兜底）
 *   - 辅助 3 件（agent-knowledge / fabric-symbol-index / _base_mods）
 *     从应用自身 Release 下载（与 jre/seed 分片同 tag）
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { getRuntimeRoot, loadFabricVersions, isToolchainCancellationRequested } from './build-env'
import { getSeedReleaseInfo } from './seed-downloader'
import { DOWNLOAD_USER_AGENT, getDownloadFetch } from './download-shared'
import { pickFastestUrls } from './download-probe'

// 知识库仓库（与 scripts/knowledge/download-knowledge-base.mjs 一致）
const KB_REPO_GITHUB = 'newstarbar/ModCrafting-knowledge-base'
const KB_REPO_GITEE_OWNER = 'chenmo-starry-sky'
const KB_REPO_GITEE_REPO = 'mod-crafting-knowledge-base'

// 知识库产物：从 ModCrafting-knowledge-base 仓库 Release 下载
const KB_ARTIFACTS = [
  { zip: 'minecraft-data.zip', dir: 'minecraft-data' },
  { zip: 'mc-wiki-zh.zip', dir: 'mc-wiki-zh' },
  { zip: 'mc-wiki-zh-index.zip', dir: 'mc-wiki-zh-index' },
  { zip: 'mc-wiki-model.zip', dir: 'mc-wiki-model' }
] as const

// 辅助资源：从应用自身 Release 下载（与 jre/seed 同 tag）
const EXTRA_ARTIFACTS = [
  { zip: 'agent-knowledge.zip', dir: 'agent-knowledge' },
  { zip: 'fabric-symbol-index.zip', dir: 'fabric-symbol-index' },
  { zip: 'base-mods.zip', dir: '_base_mods' }
] as const

type ProgressFn = (message: string, percent: number) => void

interface KnowledgeArtifactResult {
  dir: string
  ok: boolean
  error?: string
}

/** 下载首字节超时：服务器挂起时 30s 内 abort，触发上层换源/重试 */
const FIRST_BYTE_TIMEOUT_MS = 30_000
/** 下载 stall 检测：30s 内无新数据则 abort，覆盖 body 流半开挂起 */
const STALL_TIMEOUT_MS = 30_000
/** 进度上报节流：避免高频 IPC */
const PROGRESS_THROTTLE_BYTES = 64 * 1024
const PROGRESS_THROTTLE_MS = 300

/** 下载字节进度回调：received 已接收字节，totalBytes 来自 Content-Length（0 表示未知） */
type DownloadProgressFn = (received: number, totalBytes: number) => void

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 并发探测 ModCrafting-knowledge-base 仓库最新匹配 MC 版本的 Release tag。
 * 同时查询 Gitee 和 GitHub，返回双源 assets 供后续 pickFastestUrls 测速选优。
 * 不再硬编码 Gitee 优先 —— 不同网络环境下 GitHub 可能更快。
 */
async function resolveKnowledgeReleaseTag(mcVersion: string): Promise<{
  tag: string
  giteeAssets: { name: string; url: string }[]
  githubAssets: { name: string; url: string }[]
}> {
  const prefix = `knowledge-${mcVersion}-`

  const [giteeRes, githubRes] = await Promise.allSettled([
    getDownloadFetch()(
      `https://gitee.com/api/v5/repos/${KB_REPO_GITEE_OWNER}/${KB_REPO_GITEE_REPO}/releases?per_page=20`,
      { headers: { 'User-Agent': DOWNLOAD_USER_AGENT } }
    ),
    getDownloadFetch()(`https://api.github.com/repos/${KB_REPO_GITHUB}/releases`, {
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT, Accept: 'application/vnd.github+json' }
    })
  ])

  let tag = ''
  let giteeAssets: { name: string; url: string }[] = []
  let githubAssets: { name: string; url: string }[] = []

  // 解析 Gitee
  if (giteeRes.status === 'fulfilled' && giteeRes.value.ok) {
    try {
      const releases = (await giteeRes.value.json()) as Array<{
        tag_name: string
        assets?: Array<{ name: string; browser_download_url: string }>
      }>
      const matched = releases
        .filter((r) => r.tag_name?.startsWith(prefix))
        .sort((a, b) => b.tag_name.localeCompare(a.tag_name))
      if (matched.length > 0 && matched[0].assets?.length) {
        tag = matched[0].tag_name
        giteeAssets = matched[0].assets.map((a) => ({ name: a.name, url: a.browser_download_url }))
      }
    } catch (err) {
      console.warn(`[knowledge-downloader] Gitee Release 解析失败: ${String(err)}`)
    }
  }

  // 解析 GitHub
  if (githubRes.status === 'fulfilled' && githubRes.value.ok) {
    try {
      const releases = (await githubRes.value.json()) as Array<{
        tag_name: string
        assets?: Array<{ name: string; browser_download_url: string }>
      }>
      const matched = releases
        .filter((r) => r.tag_name?.startsWith(prefix))
        .sort((a, b) => b.tag_name.localeCompare(a.tag_name))
      if (matched.length > 0 && matched[0].assets?.length) {
        if (!tag) tag = matched[0].tag_name
        githubAssets = matched[0].assets.map((a) => ({ name: a.name, url: a.browser_download_url }))
      }
    } catch (err) {
      console.warn(`[knowledge-downloader] GitHub Release 解析失败: ${String(err)}`)
    }
  }

  if (!tag || (giteeAssets.length === 0 && githubAssets.length === 0)) {
    throw new Error(`未找到匹配 MC ${mcVersion} 的知识库 Release（前缀 ${prefix}）`)
  }

  return { tag, giteeAssets, githubAssets }
}

/**
 * 应用自身 Release 的辅助资源 URL。
 *
 * Gitee 侧：与 jre/seed 分片一起放在环境仓 mod-crafting-env（>100MB 聚合，避免主仓配额溢出）。
 * GitHub 侧：不分仓，与二进制一起放在主仓 newstarbar/ModCrafting。
 * 与 jre/seed 共用 tag，复用 seed-downloader 的 tag 常量。
 */
function resolveExtraArtifactUrl(zipName: string): { gitee: string; github: string } {
  const { giteeBase, githubBase } = getSeedReleaseInfo()
  return {
    gitee: `${giteeBase}${zipName}`,
    github: `${githubBase}${zipName}`
  }
}

/**
 * 下载单个文件到 destPath，带首字节超时、stall 检测和进度回调。
 *
 * 之前版本无任何超时/进度：服务器挂起或 body 流半开时无限等待，
 * UI 停在 "下载 agent-knowledge…" 不更新。现在参考 toolchain-download.ts
 * 的成熟模式：30s 首字节超时 + 30s stall 检测 + 节流进度回调。
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: DownloadProgressFn
): Promise<void> {
  const controller = new AbortController()
  const firstByteTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
  // stall 计时器：每个 chunk 到达时重置；超时未收到新数据则 abort
  let stallTimer: NodeJS.Timeout | null = null
  const resetStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  }
  const clearTimers = (): void => {
    clearTimeout(firstByteTimer)
    if (stallTimer) clearTimeout(stallTimer)
  }

  let res: Response
  try {
    res = await getDownloadFetch()(url, {
      redirect: 'follow',
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: controller.signal
    })
  } catch (err) {
    clearTimers()
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`下载超时（首字节 ${FIRST_BYTE_TIMEOUT_MS / 1000}s 内无响应）: ${url}`)
    }
    throw err
  }
  if (!res.ok || !res.body) {
    clearTimers()
    throw new Error(`HTTP ${res.status} for ${url}`)
  }

  const totalBytes = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastReportedBytes = 0
  let lastReportedAt = 0
  let firstByteArrived = false

  const countingStream = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) {
      if (!firstByteArrived) {
        firstByteArrived = true
        clearTimeout(firstByteTimer)
      }
      resetStall()
      received += chunk.length
      const now = Date.now()
      if (
        onProgress &&
        (received - lastReportedBytes >= PROGRESS_THROTTLE_BYTES ||
          (now - lastReportedAt >= PROGRESS_THROTTLE_MS && received > lastReportedBytes))
      ) {
        lastReportedBytes = received
        lastReportedAt = now
        onProgress(received, totalBytes)
      }
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      res.body as unknown as NodeJS.ReadableStream,
      countingStream,
      fs.createWriteStream(destPath)
    )
  } catch (err) {
    clearTimers()
    try { fs.unlinkSync(destPath) } catch { /* ignore */ }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        firstByteArrived
          ? `下载超时（${STALL_TIMEOUT_MS / 1000}s 内无新数据，stall）: ${url}`
          : `下载超时（首字节 ${FIRST_BYTE_TIMEOUT_MS / 1000}s 内无响应）: ${url}`
      )
    }
    throw err
  }
  clearTimers()
  // 下载完成，确保进度到达 100%（totalBytes 未知时补报已接收字节）
  if (onProgress) onProgress(totalBytes > 0 ? totalBytes : received, totalBytes)
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true })
    const child =
      process.platform === 'win32'
        ? spawn(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
             `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
          )
        : spawn('tar', ['-xf', zipPath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解压失败 (exit ${code}): ${stderr}`))
    })
  })
}

/**
 * 下载并解压单个 zip 到 runtime/knowledge/<dir>/。
 * 先写 staging 目录，再 rename，避免半成品。
 * 失败重试 3 次（每个 zip <25MB，单文件下载无需分片）。
 *
 * onProgress 用于实时上报下载字节进度（received, totalBytes），
 * 调用方据此更新 UI 消息，避免长时间停留 "下载 xxx…" 无变化。
 */
async function downloadAndExtractArtifact(
  url: string,
  destDir: string,
  label: string,
  onProgress?: DownloadProgressFn
): Promise<{ ok: boolean; error?: string }> {
  const staging = `${destDir}.staging`
  const zipPath = `${destDir}.zip`

  // 清理残留
  for (const p of [staging, zipPath]) {
    if (fs.existsSync(p)) {
      try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
      catch { /* ignore */ }
    }
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true })

  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await downloadFile(url, zipPath, onProgress)
      fs.mkdirSync(staging, { recursive: true })
      await extractZip(zipPath, staging)

      // 替换 destDir
      if (fs.existsSync(destDir)) {
        try { fs.rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
        catch {
          return { ok: false, error: `${label}: 无法替换现有目录（${destDir} 被占用）` }
        }
      }
      fs.renameSync(staging, destDir)
      try { fs.rmSync(zipPath, { force: true }) } catch { /* ignore */ }
      return { ok: true }
    } catch (err) {
      lastError = String(err)
      console.warn(`[knowledge-downloader] ${label} 下载第 ${attempt} 次失败: ${lastError}`)
      // 清理后重试
      for (const p of [staging, zipPath]) {
        try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ }
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
  return { ok: false, error: `${label}: ${lastError}` }
}

/**
 * 检查 runtime/knowledge/ 是否已就绪（4 个知识库 + 3 个辅助资源都存在）。
 *
 * 注意：fabric-symbol-index 目录内应包含 fabric-symbol-index-<mcVersion>.json.gz 文件。
 */
export function isKnowledgeBaseReady(): boolean {
  const root = path.join(getRuntimeRoot(), 'knowledge')
  const mcVersion = loadFabricVersions().minecraft_version
  const requiredDirs = [
    ...KB_ARTIFACTS.map((a) => a.dir),
    'agent-knowledge',
    'fabric-symbol-index',
    '_base_mods'
  ]
  for (const dir of requiredDirs) {
    if (!fs.existsSync(path.join(root, dir))) return false
  }
  // fabric-symbol-index 目录内必须有对应版本的 .json.gz
  const symbolFile = path.join(root, 'fabric-symbol-index', `fabric-symbol-index-${mcVersion}.json.gz`)
  if (!fs.existsSync(symbolFile)) return false
  return true
}

/**
 * 下载全部 7 个产物到 runtime/knowledge/。
 *
 * 进度回调：percent 0-100 表示本次下载流程的内部进度。
 * 失败不抛错，返回 { ok, error }；调用方按需降级。
 */
export async function ensureKnowledgeBase(
  onProgress: ProgressFn = () => {}
): Promise<{ ok: boolean; error?: string }> {
  if (isKnowledgeBaseReady()) {
    onProgress('知识库已就绪', 100)
    return { ok: true }
  }

  const root = path.join(getRuntimeRoot(), 'knowledge')
  fs.mkdirSync(root, { recursive: true })

  const results: KnowledgeArtifactResult[] = []
  const totalArtifacts = KB_ARTIFACTS.length + EXTRA_ARTIFACTS.length
  let completed = 0

  // ── 阶段 1：知识库 4 件（来自 ModCrafting-knowledge-base 仓库 Release） ──
  // 并发查询 Gitee + GitHub，下载时对每个 artifact 测速选优（不硬编码 Gitee 优先）
  onProgress('查询知识库 Release（Gitee + GitHub 并发）…', 2)
  let kbTag = ''
  let kbGiteeAssets: { name: string; url: string }[] = []
  let kbGithubAssets: { name: string; url: string }[] = []
  try {
    const mcVersion = loadFabricVersions().minecraft_version
    const release = await resolveKnowledgeReleaseTag(mcVersion)
    kbTag = release.tag
    kbGiteeAssets = release.giteeAssets
    kbGithubAssets = release.githubAssets
    const sources = `${kbGiteeAssets.length ? 'Gitee' : ''}${kbGiteeAssets.length && kbGithubAssets.length ? '+' : ''}${kbGithubAssets.length ? 'GitHub' : ''}`
    onProgress(`知识库 Release: ${kbTag} (${sources})`, 5)
  } catch (err) {
    console.warn(`[knowledge-downloader] 知识库 Release 探测失败: ${String(err)}`)
    onProgress('知识库 Release 不可用，跳过百科/数据下载', 50)
    for (const a of KB_ARTIFACTS) {
      results.push({ dir: a.dir, ok: false, error: 'Release 不可用' })
    }
  }

  for (const artifact of KB_ARTIFACTS) {
    if (isToolchainCancellationRequested()) {
      onProgress('已取消知识库下载（保留已完成部分）', Math.round(5 + (completed / totalArtifacts) * 90))
      break
    }
    if (kbGiteeAssets.length === 0 && kbGithubAssets.length === 0) break
    const giteeAsset = kbGiteeAssets.find((a) => a.name === artifact.zip)
    const githubAsset = kbGithubAssets.find((a) => a.name === artifact.zip)
    if (!giteeAsset && !githubAsset) {
      console.warn(`[knowledge-downloader] 知识库 Release 缺少 ${artifact.zip}`)
      results.push({ dir: artifact.dir, ok: false, error: `${artifact.zip} 缺失` })
      continue
    }
    const destDir = path.join(root, artifact.dir)
    const stepPercent = Math.round(5 + (completed / totalArtifacts) * 90)

    // 构造候选源列表，pickFastestUrls 并发测速选优
    const candidates: Array<{ url: string; label: string }> = []
    if (giteeAsset) candidates.push({ url: giteeAsset.url, label: 'Gitee' })
    if (githubAsset) candidates.push({ url: githubAsset.url, label: 'GitHub' })

    onProgress(`测速选优 ${artifact.dir}（${candidates.map((c) => c.label).join('/')}）…`, stepPercent)
    const ordered = candidates.length > 1
      ? await pickFastestUrls(candidates)
      : candidates.map((c) => ({ ...c, speedKBps: null }))

    let r: { ok: boolean; error?: string } = { ok: false, error: '无可用下载源' }
    for (const candidate of ordered) {
      r = await downloadAndExtractArtifact(candidate.url, destDir, artifact.dir, (received, total) => {
        const sizeStr = total > 0 ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received)
        onProgress(`下载 ${artifact.dir} ${sizeStr}…`, stepPercent)
      })
      if (r.ok) break
      console.warn(`[knowledge-downloader] ${artifact.dir} ${candidate.label} 失败，尝试下一个: ${r.error}`)
    }
    results.push({ dir: artifact.dir, ...r })
    completed++
    onProgress(`${artifact.dir} ${r.ok ? '完成' : '失败'}`, Math.round(5 + (completed / totalArtifacts) * 90))
  }

  // ── 阶段 2：辅助资源 3 件（来自应用自身 Release，与 jre/seed 同 tag） ──
  // Gitee + GitHub 并发测速选优，不硬编码任何源优先
  for (const artifact of EXTRA_ARTIFACTS) {
    if (isToolchainCancellationRequested()) {
      onProgress('已取消知识库下载（保留已完成部分）', Math.round(5 + (completed / totalArtifacts) * 90))
      break
    }
    const { gitee, github } = resolveExtraArtifactUrl(artifact.zip)
    const destDir = path.join(root, artifact.dir)
    const stepPercent = Math.round(5 + (completed / totalArtifacts) * 90)
    onProgress(`测速选优 ${artifact.dir}（Gitee/GitHub）…`, stepPercent)

    const ordered = await pickFastestUrls([
      { url: gitee, label: 'Gitee' },
      { url: github, label: 'GitHub' }
    ])
    let r: { ok: boolean; error?: string } = { ok: false, error: '无可用下载源' }
    for (const candidate of ordered) {
      r = await downloadAndExtractArtifact(candidate.url, destDir, artifact.dir, (received, total) => {
        const sizeStr = total > 0 ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received)
        onProgress(`下载 ${artifact.dir} ${sizeStr}…`, stepPercent)
      })
      if (r.ok) break
      console.warn(`[knowledge-downloader] ${artifact.dir} ${candidate.label} 失败，尝试下一个: ${r.error}`)
    }
    results.push({ dir: artifact.dir, ...r })
    completed++
    onProgress(`${artifact.dir} ${r.ok ? '完成' : '失败'}`, Math.round(5 + (completed / totalArtifacts) * 90))
  }

  // ── fabric-symbol-index 重命名：zip 内是 .json.gz，需保持文件名 ──
  // 已通过 extractZip 还原目录结构，无需额外处理

  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) {
    onProgress('知识库已就绪', 100)
    return { ok: true }
  }

  const summary = failed.map((f) => `${f.dir}(${f.error || '失败'})`).join(', ')
  console.warn(`[knowledge-downloader] 部分知识库下载失败: ${summary}`)
  // 部分失败也认为流程完成（降级运行），但返回警告
  onProgress(`知识库部分不可用: ${summary}`, 100)
  return { ok: true, error: `部分知识库下载失败: ${summary}` }
}
