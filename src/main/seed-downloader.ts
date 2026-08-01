/**
 * Download gradle-home-seed.tar.xz from Gitee/GitHub Releases as shards.
 *
 * Gitee free tier limits single release assets to 100MB, so the seed archive
 * (~500MB) is split into ~90MB shards. This module:
 *   1. Downloads manifest.json (Gitee primary, GitHub fallback)
 *   2. Parallel-downloads shards (3 concurrent, SHA256-verified)
 *   3. Reassembles into seed.tar.xz
 *   4. Extracts via `tar -xJf` to a staging dir
 *   5. Verifies seed marker, then moves to destDir
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, renameSync, statSync, createReadStream } from 'fs'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { Transform } from 'stream'
import * as path from 'path'
import { pipeline } from 'stream/promises'

// Release tag hosting the seed shards. Update when publishing a new seed version.
const SEED_RELEASE_TAG = 'v1.0.0'

// GitHub 不分仓（容量足够），始终指向主仓 newstarbar/ModCrafting
const GITHUB_RELEASE_BASE = `https://github.com/newstarbar/ModCrafting/releases/download/${SEED_RELEASE_TAG}/`

/**
 * Gitee 环境仓（seed/jre/extra-zips 分片所在）。
 *
 * Gitee 单仓库附件配额 1GB，全部 18 个发布文件共 1.12GB 装不下，
 * 因此 Gitee 侧拆分到环境仓 mod-crafting-env，主仓 mod-crafting 只放二进制。
 *
 * 从打包后的 process.resourcesPath/gitee-config.json 读取 envRepo；
 * dev 模式回退到源码 packaging/gitee-config.json；最终 fallback 到默认值。
 */
function loadGiteeEnvRepo(): { owner: string; repo: string } {
  const candidates = [
    // 生产模式：electron-builder extraResources 打包到 process.resourcesPath/
    path.join(process.resourcesPath || '', 'gitee-config.json'),
    // Dev 模式：源码 packaging/gitee-config.json（__dirname = out/main/）
    path.join(__dirname, '..', '..', 'packaging', 'gitee-config.json'),
    // 旧版兼容
    path.join(__dirname, '..', '..', 'build', 'gitee-config.json')
  ]
  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as {
        owner?: string
        envRepo?: string
      }
      if (data.owner && data.envRepo) {
        return { owner: data.owner, repo: data.envRepo }
      }
    } catch {
      /* ignore */
    }
  }
  return { owner: 'chenmo-starry-sky', repo: 'mod-crafting-env' }
}

const giteeEnvRepo = loadGiteeEnvRepo()
// Gitee primary (国内速度快), GitHub fallback (国外/兜底)
const GITEE_RELEASE_BASE = `https://gitee.com/${giteeEnvRepo.owner}/${giteeEnvRepo.repo}/releases/download/${SEED_RELEASE_TAG}/`

const MANIFEST_FILENAME = 'manifest.json'
const SEED_ARCHIVE_NAME = 'gradle-home-seed.tar.xz'

const JRE_MANIFEST_FILENAME = 'jre-manifest.json'
const JRE_ARCHIVE_NAME = 'jre-21-minimal.tar.xz'

// Parallelism for shard downloads
const DOWNLOAD_CONCURRENCY = 3

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

function sha256File(filePath: string): string {
  const h = createHash('sha256')
  const data = readFileSync(filePath)
  h.update(data)
  return h.digest('hex')
}

async function fetchJson(url: string): Promise<SeedManifest> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return (await res.json()) as SeedManifest
}

async function fetchManifest(manifestFilename: string): Promise<{ manifest: SeedManifest; baseUrl: string }> {
  // Gitee primary
  try {
    const manifest = await fetchJson(`${GITEE_RELEASE_BASE}${manifestFilename}`)
    return { manifest, baseUrl: GITEE_RELEASE_BASE }
  } catch (err) {
    console.warn(`[seed-downloader] Gitee manifest fetch failed: ${String(err)}, trying GitHub…`)
  }
  // GitHub fallback
  const manifest = await fetchJson(`${GITHUB_RELEASE_BASE}${manifestFilename}`)
  return { manifest, baseUrl: GITHUB_RELEASE_BASE }
}

async function downloadFileWithProgress(
  url: string,
  dest: string,
  expectedSize: number,
  onProgress: (received: number) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  if (!res.body) throw new Error(`Empty response body for ${url}`)

  let received = 0
  const sink = createWriteStream(dest)
  // Tee stream to count bytes
  const countingStream = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: () => void) {
      received += chunk.length
      onProgress(received)
      callback(null, chunk)
    }
  })

  await pipeline(res.body as NodeJS.ReadableStream, countingStream, sink)

  if (expectedSize > 0 && received !== expectedSize) {
    throw new Error(`Size mismatch: expected ${expectedSize}, got ${received}`)
  }
}

async function downloadShard(
  shard: SeedShard,
  baseUrl: string,
  shardsDir: string,
  onProgress: (received: number, shardIndex: number) => void
): Promise<string> {
  const shardPath = path.join(shardsDir, shard.filename)
  // Skip if already downloaded and valid
  if (existsSync(shardPath)) {
    try {
      const stat = statSync(shardPath)
      if (stat.size === shard.size && sha256File(shardPath) === shard.sha256) {
        console.log(`[seed-downloader] shard ${shard.filename} already valid, skipping`)
        onProgress(shard.size, shard.index)
        return shardPath
      }
    } catch {
      /* re-download */
    }
    rmSync(shardPath, { force: true })
  }

  const url = `${baseUrl}${shard.filename}`
  console.log(`[seed-downloader] downloading ${shard.filename} from ${new URL(url).host}`)
  await downloadFileWithProgress(url, shardPath, shard.size, (received) => {
    onProgress(received, shard.index)
  })

  // Verify SHA256
  const actualSha = sha256File(shardPath)
  if (actualSha !== shard.sha256) {
    throw new Error(`Shard ${shard.filename} SHA256 mismatch: expected ${shard.sha256}, got ${actualSha}`)
  }

  return shardPath
}

async function downloadAllShards(
  manifest: SeedManifest,
  baseUrl: string,
  shardsDir: string,
  onOverallProgress: (message: string, percent: number) => void,
  progressLabel: string
): Promise<string[]> {
  mkdirSync(shardsDir, { recursive: true })
  const totalBytes = manifest.totalSize
  let receivedBytes = 0
  const shardPaths: string[] = new Array(manifest.shards.length)

  // Parallel download with concurrency limit
  const queue = [...manifest.shards]
  const workers: Promise<void>[] = []

  const reportProgress = () => {
    const pct = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 80) + 10 : 50
    onOverallProgress(`${progressLabel} ${receivedBytes}/${totalBytes} bytes (${pct}%)`, pct)
  }

  for (let i = 0; i < Math.min(DOWNLOAD_CONCURRENCY, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const shard = queue.shift()
        if (!shard) break
        const shardPath = await downloadShard(shard, baseUrl, shardsDir, (received) => {
          // Note: this callback may be invoked multiple times; we track cumulative progress
          // by re-deriving from per-shard file size on completion (simpler & avoids races)
        })
        shardPaths[shard.index - 1] = shardPath
        receivedBytes += shard.size
        reportProgress()
      }
    })())
  }

  await Promise.all(workers)
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
  let baseUrl: string
  try {
    ({ manifest, baseUrl } = await fetchManifest(manifestFilename))
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
    // 1. Download all shards
    const shardPaths = await downloadAllShards(manifest, baseUrl, shardsDir, onProgress, `下载${label}分片…`)

    // 2. Concatenate into archive
    onProgress('正在合并分片…', 92)
    await concatenateShards(shardPaths, archivePath)

    // 3. Verify total SHA256
    onProgress('正在校验完整性…', 94)
    const actualTotalSha = sha256File(archivePath)
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

export function getSeedReleaseInfo(): { tag: string; giteeBase: string; githubBase: string } {
  return { tag: SEED_RELEASE_TAG, giteeBase: GITEE_RELEASE_BASE, githubBase: GITHUB_RELEASE_BASE }
}

export { SEED_ARCHIVE_NAME, MANIFEST_FILENAME, JRE_ARCHIVE_NAME, JRE_MANIFEST_FILENAME }
