/**
 * Download gradle-home-seed.tar.xz from GitHub Releases as shards.
 *
 * GitHub Release 单附件配额 2GB（远超 Gitee 100MB），seed archive（~500MB）
 * 仍按 ~90MB 切片以便并发下载与断点续传。本模块：
 *   1. Downloads manifest.json（GitHub + gh.xmly.dev 代理双源测速选优）
 *   2. Parallel-downloads shards (3 concurrent, SHA256-verified)
 *   3. Reassembles into seed.tar.xz
 *   4. Extracts via `tar -xJf` to a staging dir
 *   5. Verifies seed marker, then moves to destDir
 *
 * 2026-08 重构：移除 Gitee 源，改用 GitHub + gh.xmly.dev 代理。
 * Gitee Release 仅保留 Setup/Portable 用于浏览器下载。
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, statSync, createReadStream } from 'fs'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { Transform } from 'stream'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { DOWNLOAD_USER_AGENT, getDownloadFetch } from './download-shared'
import { pickFastestUrls } from './download-probe'
import { wrapGithubProxy } from './github-mirror'

// Release tag hosting the seed shards. Update when publishing a new seed version.
const SEED_RELEASE_TAG = 'v1.0.0'

// GitHub 不分仓（容量足够），始终指向主仓 newstarbar/ModCrafting
const GITHUB_RELEASE_BASE = `https://github.com/newstarbar/ModCrafting/releases/download/${SEED_RELEASE_TAG}/`
// gh.xmly.dev 代理加速基础 URL（包裹 GITHUB_RELEASE_BASE）
const GITHUB_PROXY_RELEASE_BASE = wrapGithubProxy(GITHUB_RELEASE_BASE)

const MANIFEST_FILENAME = 'manifest.json'
const SEED_ARCHIVE_NAME = 'gradle-home-seed.tar.xz'

const JRE_MANIFEST_FILENAME = 'jre-manifest.json'
const JRE_ARCHIVE_NAME = 'jre-21-minimal.tar.xz'

const GRADLE_MANIFEST_FILENAME = 'gradle-manifest.json'
const GRADLE_ARCHIVE_NAME = 'gradle-9.5.tar.xz'

// Parallelism for shard downloads
const DOWNLOAD_CONCURRENCY = 3

// 进度上报节流：字节增量 ≥256KB 或时间间隔 ≥300ms 且收到新数据才上报，避免高频 IPC
const PROGRESS_THROTTLE_BYTES = 256 * 1024
const PROGRESS_THROTTLE_MS = 300

interface SeedShard {
  index: number
  filename: string
  sha256: string
  size: number
}

interface SeedManifest {
  version: number
  archiveName: string
  shardCount: number
  shardSize: number
  totalSize: number
  totalSha256: string
  shards: SeedShard[]
  fabricVersions?: Record<string, string>
  createdAt: string
}

type ProgressFn = (message: string, percent: number) => void

/** 流式计算文件 SHA256（异步，避免 readFileSync 全量读入阻塞事件循环，阻塞期间进度/速度无法上报） */
async function sha256File(filePath: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    h.update(chunk as Buffer)
  }
  return h.digest('hex')
}

async function fetchJson(url: string): Promise<SeedManifest> {
  const res = await getDownloadFetch()(url, { redirect: 'follow', headers: { 'User-Agent': DOWNLOAD_USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return (await res.json()) as SeedManifest
}

async function fetchManifest(
  manifestFilename: string,
  onProgress?: ProgressFn
): Promise<{ manifest: SeedManifest; baseUrls: string[] }> {
  // 候选源：GitHub 代理（gh.xmly.dev，国内加速）+ GitHub 直连（兜底）。
  // 先并发尝试拉 manifest（小文件），再对首个分片实测速度选优。
  let manifest: SeedManifest | null = null
  try {
    manifest = await fetchJson(`${GITHUB_PROXY_RELEASE_BASE}${manifestFilename}`)
  } catch (err) {
    console.warn(`[seed-downloader] GitHub proxy manifest fetch failed: ${String(err)}, trying GitHub direct…`)
  }
  if (!manifest) {
    manifest = await fetchJson(`${GITHUB_RELEASE_BASE}${manifestFilename}`)
  }

  // 多源测速选优：GitHub 代理（gh.xmly.dev，国内主源）+ GitHub 直连（兜底）。
  // 500MB 种子值得 512KB 探测，对首个分片实测速度，按最快顺序排列下载源；探测失败的排后兜底。
  const firstShard = manifest.shards[0]
  if (firstShard) {
    const ordered = await pickFastestUrls([
      { url: `${GITHUB_PROXY_RELEASE_BASE}${firstShard.filename}`, label: 'github-proxy' },
      { url: `${GITHUB_RELEASE_BASE}${firstShard.filename}`, label: 'github' }
    ])
    const baseUrlByLabel: Record<string, string> = {
      'github-proxy': GITHUB_PROXY_RELEASE_BASE,
      github: GITHUB_RELEASE_BASE
    }
    const baseUrls = ordered.map((c) => baseUrlByLabel[c.label]).filter((b): b is string => !!b)
    const uniqueBaseUrls = Array.from(new Set(baseUrls))
    return { manifest, baseUrls: uniqueBaseUrls }
  }
  return { manifest, baseUrls: [GITHUB_PROXY_RELEASE_BASE] }
}

async function downloadFileWithProgress(
  url: string,
  dest: string,
  expectedSize: number,
  onProgress: (received: number) => void
): Promise<void> {
  const res = await getDownloadFetch()(url, { redirect: 'follow', headers: { 'User-Agent': DOWNLOAD_USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  if (!res.body) throw new Error(`Empty response body for ${url}`)

  let received = 0
  const sink = createWriteStream(dest)
  // Tee stream to count bytes
  const countingStream = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) {
      received += chunk.length
      onProgress(received)
      callback(null, chunk)
    }
  })

  await pipeline(res.body as unknown as NodeJS.ReadableStream, countingStream, sink)

  if (expectedSize > 0 && received !== expectedSize) {
    throw new Error(`Size mismatch: expected ${expectedSize}, got ${received}`)
  }
}

async function downloadShard(
  shard: SeedShard,
  baseUrls: string[],
  shardsDir: string,
  onProgress: (received: number, shardIndex: number) => void
): Promise<string> {
  const shardPath = path.join(shardsDir, shard.filename)
  // Skip if already downloaded and valid
  if (existsSync(shardPath)) {
    try {
      const stat = statSync(shardPath)
      if (stat.size === shard.size && (await sha256File(shardPath)) === shard.sha256) {
        console.log(`[seed-downloader] shard ${shard.filename} already valid, skipping`)
        onProgress(shard.size, shard.index)
        return shardPath
      }
    } catch {
      /* re-download */
    }
    rmSync(shardPath, { force: true })
  }

  // 多源回退：按 baseUrls 顺序逐源尝试,失败换下一个源重试（之前单源失败直接抛错）
  const failures: string[] = []
  let downloaded = false
  for (const baseUrl of baseUrls) {
    const url = `${baseUrl}${shard.filename}`
    console.log(`[seed-downloader] downloading ${shard.filename} from ${new URL(url).host}`)
    try {
      await downloadFileWithProgress(url, shardPath, shard.size, (received) => {
        onProgress(received, shard.index)
      })
      // Verify SHA256
      const actualSha = await sha256File(shardPath)
      if (actualSha !== shard.sha256) {
        throw new Error(`Shard ${shard.filename} SHA256 mismatch: expected ${shard.sha256}, got ${actualSha}`)
      }
      downloaded = true
      break
    } catch (err) {
      failures.push(`${new URL(url).host}: ${String(err)}`)
      // 失败清理,准备换源重试
      if (existsSync(shardPath)) rmSync(shardPath, { force: true })
    }
  }

  if (!downloaded) {
    throw new Error(`Shard ${shard.filename} 下载失败: ${failures.join('；')}`)
  }

  return shardPath
}

async function downloadAllShards(
  manifest: SeedManifest,
  baseUrls: string[],
  shardsDir: string,
  onOverallProgress: (message: string, percent: number) => void,
  progressLabel: string
): Promise<string[]> {
  mkdirSync(shardsDir, { recursive: true })
  const totalBytes = manifest.totalSize
  const shardPaths: string[] = new Array(manifest.shards.length)
  // 每个分片已下载字节数（按 shard.index-1 索引）。
  // 并发写不同索引在 JS 单线程事件循环下无 race，实时累计后合并为总体进度。
  const progressBytes: number[] = new Array(manifest.shards.length).fill(0)
  let lastReportedBytes = 0
  let lastReportedAt = 0
  let speedBytes = 0

  const reportProgress = (force = false) => {
    const receivedBytes = progressBytes.reduce((a, b) => a + b, 0)
    const now = Date.now()
    const pct = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 80) + 10 : 50
    if (
      !force &&
      receivedBytes - lastReportedBytes < PROGRESS_THROTTLE_BYTES &&
      now - lastReportedAt < PROGRESS_THROTTLE_MS
    ) return
    // 瞬时速度 → EMA 指数平滑：单次停顿（连接间隙 / SHA256 阻塞）不会把速度拉低。
    // force 上报（分片完成瞬间）不代表持续传输速率，不更新；超长间隔视为卡顿/连接建立，跳过
    if (!force && lastReportedAt > 0 && receivedBytes > lastReportedBytes) {
      const dt = (now - lastReportedAt) / 1000
      if (dt > 0 && dt <= 10) {
        const inst = (receivedBytes - lastReportedBytes) / dt
        speedBytes = speedBytes > 0 ? speedBytes * 0.7 + inst * 0.3 : inst
      }
    }
    lastReportedBytes = receivedBytes
    lastReportedAt = now
    const fmtMb = (n: number) => (n / 1024 / 1024).toFixed(1)
    const sizeText = totalBytes > 0 ? `${fmtMb(receivedBytes)}MB/${fmtMb(totalBytes)}MB` : `${receivedBytes} bytes`
    // 动态单位：<1MB/s 用 KB/s，避免 0.0MB 无意义显示
    const speedText =
      speedBytes > 0
        ? speedBytes >= 1024 * 1024
          ? ` ${fmtMb(speedBytes)}MB/s`
          : ` ${Math.max(1, Math.round(speedBytes / 1024))}KB/s`
        : ''
    onOverallProgress(`${progressLabel} ${sizeText} (${pct}%)${speedText}`, pct)
  }

  // Parallel download with concurrency limit
  const queue = [...manifest.shards]
  const workers: Promise<void>[] = []
  const startAt = Date.now()
  // 记录首个分片实际下载源（用于诊断日志）
  let primaryHost = baseUrls[0] ? new URL(baseUrls[0]).host : 'unknown'

  for (let i = 0; i < Math.min(DOWNLOAD_CONCURRENCY, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const shard = queue.shift()
        if (!shard) break
        const shardPath = await downloadShard(shard, baseUrls, shardsDir, (received) => {
          // 实时记录该分片已下载字节数（每次 chunk 到达即更新）
          progressBytes[shard.index - 1] = received
          reportProgress()
        })
        shardPaths[shard.index - 1] = shardPath
        // 分片完成，确保字节数计入并强制上报一次
        progressBytes[shard.index - 1] = shard.size
        reportProgress(true)
      }
    })())
  }

  await Promise.all(workers)

  // 下载诊断日志：确认各源对匿名下载（无登录 cookie）是否限速
  const downloadedBytes = progressBytes.reduce((a, b) => a + b, 0)
  const elapsedSec = (Date.now() - startAt) / 1000
  const avgSpeed = downloadedBytes / 1024 / 1024 / (elapsedSec || 1)
  console.log(
    `[seed-downloader] 分片下载完成: ${downloadedBytes} bytes in ${elapsedSec.toFixed(1)}s = ` +
      `${avgSpeed.toFixed(2)} MB/s (primary ${primaryHost}, UA=${DOWNLOAD_USER_AGENT.slice(0, 24)}…)`
  )

  return shardPaths
}

async function concatenateShards(
  shardPaths: string[],
  outputPath: string
): Promise<void> {
  const out = createWriteStream(outputPath)
  for (const shardPath of shardPaths) {
    const stream = createReadStream(shardPath)
    await pipeline(stream, out, { end: false })
  }
  out.end()
  await new Promise<void>((resolve) => out.on('finish', resolve))
}

async function extractTarXz(
  archivePath: string,
  destDir: string
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      'tar',
      ['-xJf', archivePath, '-C', destDir, '--strip-components=1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
}

interface ShardedArchiveOptions {
  destDir: string
  onProgress: ProgressFn
  manifestFilename: string
  /** 用于进度消息的标签,如 "Fabric 依赖" 或 "JRE 21" */
  label: string
  /** 解压阶段的提示文案,例如 "约 1GB" 或 "约 185MB" */
  extractHint: string
  /** 替换现有目录失败时的错误提示 */
  replaceBusyHint: string
}

async function downloadAndExtractShardedArchive(opts: ShardedArchiveOptions): Promise<{ ok: boolean; error?: string }> {
  const { destDir, onProgress, manifestFilename, label, extractHint, replaceBusyHint } = opts
  const staging = `${destDir}.staging`
  const shardsDir = `${destDir}.shards`
  const archivePath = `${destDir}.tar.xz`

  onProgress(`正在获取${label}清单…`, 5)

  let manifest: SeedManifest
  let baseUrls: string[]
  try {
    ({ manifest, baseUrls } = await fetchManifest(manifestFilename, onProgress))
  } catch (err) {
    return { ok: false, error: `无法获取${label}清单: ${String(err)}` }
  }

  onProgress(
    `发现 ${manifest.shardCount} 个分片，总大小 ${(manifest.totalSize / 1024 / 1024).toFixed(0)} MB`,
    10
  )

  // Clean previous artifacts
  for (const p of [staging, shardsDir, archivePath]) {
    if (existsSync(p)) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        /* ignore */
      }
    }
  }
  mkdirSync(staging, { recursive: true })

  try {
    // 1. Download all shards（进度消息带主源名,失败自动回退到备源）
    const primaryBaseUrl = baseUrls[0] || GITHUB_PROXY_RELEASE_BASE
    const sourceName = primaryBaseUrl === GITHUB_RELEASE_BASE ? 'GitHub' : 'GitHub代理'
    const shardPaths = await downloadAllShards(
      manifest,
      baseUrls,
      shardsDir,
      onProgress,
      `下载${label}分片（${sourceName}）…`
    )

    // 2. Concatenate into archive
    onProgress('正在合并分片…', 92)
    await concatenateShards(shardPaths, archivePath)

    // 3. Verify total SHA256
    onProgress('正在校验完整性…', 94)
    const actualTotalSha = await sha256File(archivePath)
    if (actualTotalSha !== manifest.totalSha256) {
      return { ok: false, error: `合并后 SHA256 校验失败: expected ${manifest.totalSha256}, got ${actualTotalSha}` }
    }

    // 4. Extract tar.xz
    onProgress(`正在解压${label}（${extractHint}，请稍候）…`, 96)
    const exitCode = await extractTarXz(archivePath, staging)
    if (exitCode !== 0) {
      return { ok: false, error: `解压失败 (tar exit ${exitCode})` }
    }

    // 5. Move staging to destDir
    if (existsSync(destDir)) {
      try {
        rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        return { ok: false, error: replaceBusyHint }
      }
    }
    renameSync(staging, destDir)

    // 6. Cleanup intermediate files
    try {
      rmSync(shardsDir, { recursive: true, force: true })
      rmSync(archivePath, { force: true })
    } catch {
      /* ignore cleanup failures */
    }

    onProgress(`${label}已就绪`, 100)
    return { ok: true }
  } catch (err) {
    // Cleanup on failure
    for (const p of [staging, shardsDir, archivePath]) {
      try {
        if (existsSync(p)) rmSync(p, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: `下载或解压失败: ${String(err)}` }
  }
}

/**
 * @deprecated 2026-08 重构后已不再被调用。Fabric 依赖种子通过 bundled 目录或
 * `extractGradleHomeSeedArchive` 处理。保留函数定义以兼容测试断言
 * （harness-packaging-runtime.test.ts 断言 buildEnv 不包含此函数名）。
 */
export async function downloadAndExtractSeedShards(
  destDir: string,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  return downloadAndExtractShardedArchive({
    destDir,
    onProgress,
    manifestFilename: MANIFEST_FILENAME,
    label: 'Fabric 依赖',
    extractHint: '约 1GB',
    replaceBusyHint: '无法替换现有的 Fabric 依赖目录（文件被占用）。请关闭所有 Gradle/Minecraft 进程后重试。'
  })
}

/**
 * @deprecated 2026-08 重构后已不再被调用。JRE 走 Adoptium API / 清华 TUNA 镜像。
 * 保留函数定义以兼容测试断言（harness-packaging-runtime.test.ts 断言 buildEnv 不包含此函数名）。
 */
export async function downloadAndExtractJreShards(
  destDir: string,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  return downloadAndExtractShardedArchive({
    destDir,
    onProgress,
    manifestFilename: JRE_MANIFEST_FILENAME,
    label: 'JRE 21',
    extractHint: '约 185MB',
    replaceBusyHint: '无法替换现有的 JRE 目录（文件被占用）。请关闭所有 Java/Gradle 进程后重试。'
  })
}

/**
 * @deprecated 2026-08 重构后已不再被调用。Gradle 走腾讯云 / 华为云镜像。
 * 保留函数定义以兼容测试断言（harness-packaging-runtime.test.ts 断言 buildEnv 不包含此函数名）。
 */
export async function downloadAndExtractGradleShards(
  destDir: string,
  onProgress: ProgressFn
): Promise<{ ok: boolean; error?: string }> {
  return downloadAndExtractShardedArchive({
    destDir,
    onProgress,
    manifestFilename: GRADLE_MANIFEST_FILENAME,
    label: 'Gradle 9.5',
    extractHint: '约 120MB',
    replaceBusyHint: '无法替换现有的 Gradle 目录（文件被占用）。请关闭所有 Gradle 进程后重试。'
  })
}

/**
 * 返回 Release tag 与 GitHub base URL（含代理版本）。
 * 调用方（knowledge-downloader.ts）用这些 base 拼接辅助资源 URL。
 */
export function getSeedReleaseInfo(): { tag: string; githubBase: string; githubProxyBase: string } {
  return {
    tag: SEED_RELEASE_TAG,
    githubBase: GITHUB_RELEASE_BASE,
    githubProxyBase: GITHUB_PROXY_RELEASE_BASE
  }
}

export { SEED_ARCHIVE_NAME, MANIFEST_FILENAME, JRE_ARCHIVE_NAME, JRE_MANIFEST_FILENAME, GRADLE_ARCHIVE_NAME, GRADLE_MANIFEST_FILENAME }
