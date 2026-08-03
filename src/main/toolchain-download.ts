import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, cpSync, readdirSync, renameSync, readFileSync, openSync, readSync, closeSync } from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { execSync, spawn } from 'child_process'
import * as path from 'path'
import { createHash } from 'crypto'
import { DOWNLOAD_USER_AGENT, getDownloadFetch } from './download-shared'
import { pickFastestUrls } from './download-probe'

export const GRADLE_VERSION = '9.5.0'
export const GRADLE_DIST_NAME = `gradle-${GRADLE_VERSION}-bin`
export const GRADLE_RUNTIME_FOLDER = 'gradle-9.5'
export const GRADLE_LAUNCHER_JAR = `gradle-launcher-${GRADLE_VERSION}.jar`
export const JDK_VERSION = '21.0.11+10'
export const JDK_ARCHIVE_NAME = 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.11_10.zip'
const JDK_SHA256 = 'd3625e7cadf23787ea540229544b6e2ab494b3b54da1801879e583e1dfee0a64'
const GRADLE_SHA256 = '553c78f50dafcd54d65b9a444649057857469edf836431389695608536d6b746'

// Gradle 发行版候选源（下载前会实测各源速度并优先用最快的；默认顺序仅作测速失败时的兜底）
export const GRADLE_MIRROR_URLS = [
  `https://mirrors.cloud.tencent.com/gradle/${GRADLE_DIST_NAME}.zip`,
  `https://mirrors.huaweicloud.com/gradle/${GRADLE_DIST_NAME}.zip`,
  `https://services.gradle.org/distributions/${GRADLE_DIST_NAME}.zip`
]

// 国内 JDK 镜像（Windows x64，按优先级排序）
// 优先于 Adoptium API 使用，显著提升国内下载速度
const JDK_MIRROR_URLS_WIN_X64 = [
  `https://mirror.nju.edu.cn/adoptium/21/jdk/x64/windows/${JDK_ARCHIVE_NAME}`,
  `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/${JDK_ARCHIVE_NAME}`
]

function adoptiumOs(): string {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function adoptiumArch(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

export function javaBinName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

export function isValidJdkDir(jdkDir: string): boolean {
  const binDir = path.join(jdkDir, 'bin')
  const bin = path.join(binDir, javaBinName())
  const javac = path.join(binDir, process.platform === 'win32' ? 'javac.exe' : 'javac')
  const jar = path.join(binDir, process.platform === 'win32' ? 'jar.exe' : 'jar')
  const release = path.join(jdkDir, 'release')
  if (!existsSync(bin) || !existsSync(javac) || !existsSync(jar) || !existsSync(release)) return false
  try {
    return statSync(bin).size > 10_000 && /JAVA_VERSION="21\./.test(readFileSync(release, 'utf8'))
  } catch {
    return false
  }
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

export function isCompleteGradleDist(gradleDir: string): boolean {
  const launcher = path.join(gradleDir, 'lib', GRADLE_LAUNCHER_JAR)
  const bin = path.join(gradleDir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  return existsSync(bin) && existsSync(launcher)
}

function isValidArchive(filePath: string, minBytes = 1_000_000): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).size > minBytes
  } catch {
    return false
  }
}

function removeDirBestEffort(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch {
    /* ignore */
  }
}

/** 下载进度回调：receivedBytes 已接收字节数，totalBytes 总字节数（Content-Length，可能为 0 表示未知） */
export type DownloadProgressFn = (receivedBytes: number, totalBytes: number) => void

/** 进度上报节流：字节增量 ≥256KB 或时间间隔 ≥300ms 且收到新数据才上报，避免高频回调刷爆 IPC */
const PROGRESS_THROTTLE_BYTES = 256 * 1024
const PROGRESS_THROTTLE_MS = 300

async function downloadWithPowerShell(url: string, dest: string): Promise<void> {
  const escapedUrl = url.replace(/'/g, "''")
  const escapedDest = dest.replace(/'/g, "''")
  const escapedUa = DOWNLOAD_USER_AGENT.replace(/'/g, "''")
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedDest}' -UserAgent '${escapedUa}' -UseBasicParsing}`
      ],
      { stdio: ['ignore', 'inherit', 'pipe'], shell: false }
    )
    // 捕获 stderr 以便失败时给出确切原因（如 HTTP 403 / 无法解析主机）
    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString()).slice(-4000)
    })
    child.on('close', (code) => {
      if (code === 0) return resolve()
      const detail = stderrBuf.trim().split('\n').pop()?.trim() || ''
      reject(new Error(`Download failed (exit ${code})${detail ? `: ${detail}` : ''}`))
    })
    child.on('error', reject)
  })
}

/** 下载首字节超时：连接建立后服务器无数据（挂起/空 body）时失败触发换源。
 * 30s 平衡两点：挂起源不至于无限等待；慢速但可用的源（国内访问国外 CDN 首字节可达 20s+）不被误杀。
 * 空 body（立即 EOF）场景不依赖此超时（快速完成 → 上层大小校验失败换源）。 */
const FIRST_BYTE_TIMEOUT_MS = 30_000

async function downloadWithFetch(url: string, dest: string, onProgress?: DownloadProgressFn): Promise<void> {
  // 首字节超时：挂起的下载源（如间歇空 body 的镜像）在 15s 内失败，触发下载循环换源
  const controller = new AbortController()
  const firstByteTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
  let res: Response
  try {
    res = await getDownloadFetch()(url, {
      redirect: 'follow',
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: controller.signal
    })
  } catch (err) {
    clearTimeout(firstByteTimer)
    throw err
  }
  if (!res.ok) {
    clearTimeout(firstByteTimer)
    throw new Error(`HTTP ${res.status}`)
  }
  if (!res.body) {
    clearTimeout(firstByteTimer)
    throw new Error('Empty response body')
  }
  const totalBytes = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastReportedBytes = 0
  let lastReportedAt = 0
  let firstByteArrived = false
  const countingStream = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) {
      // 首个 chunk 到达：数据开始流动，取消首字节超时
      if (!firstByteArrived) {
        firstByteArrived = true
        clearTimeout(firstByteTimer)
      }
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
    await pipeline(res.body as unknown as NodeJS.ReadableStream, countingStream, createWriteStream(dest))
  } finally {
    // pipeline 完成后（含首个 chunk 已清除）清理计时器，防止挂起时泄漏
    if (!firstByteArrived) clearTimeout(firstByteTimer)
  }
  // 下载完成，确保进度到达 100%（totalBytes 未知时补报已接收字节）
  if (onProgress) onProgress(totalBytes > 0 ? totalBytes : received, totalBytes)
}

export async function downloadFile(url: string, dest: string, onProgress?: DownloadProgressFn): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await downloadWithFetch(url, dest, onProgress)
      return
    } catch (err) {
      // HTTP 状态错误（4xx/5xx）fetch 已精确报告；PowerShell 的 Invoke-WebRequest
      // 对部分 4xx 响应不抛异常也不置非零退出码，无法可靠检测，因此不回退
      if (err instanceof Error && /^HTTP \d{3}$/.test(err.message)) throw err
      // 超时类错误（首字节挂起）不回退：PowerShell 同样会挂起，直接抛出让下载循环换源；
      // 错误消息可读化（聚合错误中显示"下载超时"而非内部 AbortError）
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('下载超时：服务器连接后无响应，已跳过该源')
      }
      // 其他网络层失败（DNS/TLS/代理等）时回退 PowerShell 兜底
      console.warn(`[download] fetch 失败，回退 PowerShell: ${String(err)}`)
      try {
        rmSync(dest, { force: true })
      } catch {
        /* ignore */
      }
    }
    await downloadWithPowerShell(url, dest)
  } else {
    await downloadWithFetch(url, dest, onProgress)
  }
}

/**
 * Download to a persistent .part file. A server that ignores Range starts a
 * clean replacement; a valid 206 response resumes exactly where it stopped.
 */
export async function downloadFileResumable(
  url: string,
  destination: string,
  expectedSha256: string,
  onProgress?: DownloadProgressFn
): Promise<void> {
  const part = `${destination}.part`
  const existing = existsSync(part) ? statSync(part).size : 0
  const controller = new AbortController()
  const firstByteTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
  let response: Response
  try {
    response = await getDownloadFetch()(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': DOWNLOAD_USER_AGENT,
        ...(existing > 0 ? { Range: `bytes=${existing}-` } : {})
      },
      signal: controller.signal
    })
  } catch (error) {
    clearTimeout(firstByteTimer)
    throw error
  }
  if (!response.ok || (existing > 0 && response.status !== 206 && response.status !== 200)) {
    clearTimeout(firstByteTimer)
    throw new Error(`HTTP ${response.status}`)
  }
  const type = response.headers.get('content-type') || ''
  if (/text\/html|application\/json/i.test(type)) {
    clearTimeout(firstByteTimer)
    throw new Error(`下载源返回非归档内容 (${type})`)
  }
  if (!response.body) {
    clearTimeout(firstByteTimer)
    throw new Error('Empty response body')
  }
  const append = existing > 0 && response.status === 206
  if (!append && existsSync(part)) rmSync(part, { force: true })
  const base = append ? existing : 0
  const contentLength = Number(response.headers.get('content-length') || 0)
  const total = contentLength ? base + contentLength : 0
  let received = base
  let firstByte = false
  let lastActivity = Date.now()
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > 45_000) controller.abort()
  }, 5_000)
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!firstByte) { firstByte = true; clearTimeout(firstByteTimer) }
      lastActivity = Date.now()
      received += chunk.length
      onProgress?.(received, total)
      callback(null, chunk)
    }
  })
  try {
    await pipeline(response.body as unknown as NodeJS.ReadableStream, counting, createWriteStream(part, { flags: append ? 'a' : 'w' }))
  } finally {
    clearTimeout(firstByteTimer)
    clearInterval(idleTimer)
  }
  const actual = sha256File(part)
  if (actual !== expectedSha256.toLowerCase()) {
    // A completed but invalid archive cannot be repaired by resuming from a
    // different source: discard it so the next retry starts with trusted bytes.
    rmSync(part, { force: true })
    throw new Error(`SHA256 校验失败: expected ${expectedSha256}, got ${actual}`)
  }
  renameSync(part, destination)
  onProgress?.(statSync(destination).size, statSync(destination).size)
}

async function resolveJdkDownloadUrl(onLog?: (msg: string) => void): Promise<string | null> {
  const log = onLog || (() => {})
  const candidates: Array<{ url: string; label: string }> = []

  // Candidate order is pinned to a full JDK. Never select a JRE/API result.
  if (process.platform === 'win32' && adoptiumArch() === 'x64') {
    for (const url of JDK_MIRROR_URLS_WIN_X64) {
      candidates.push({ url, label: new URL(url).host })
    }
  }

  if (candidates.length === 0) return null

  // 测速选优：不同网络下各源速度差异大，实测最快者优先（探测失败的排最后兜底）；结果经面板展示
  const ordered = await pickFastestUrls(candidates)
  return ordered[0].url
}

function findJdkRootInDir(dir: string): string | null {
  const javaName = javaBinName()
  const directJava = path.join(dir, 'bin', javaName)
  if (existsSync(directJava)) return dir

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(dir, entry.name)
    if (existsSync(path.join(candidate, 'bin', javaName))) return candidate
  }
  return null
}

export function extractJdkArchive(archivePath: string, targetDir: string, tempParent: string): void {
  const tempExtract = path.join(tempParent, '_jdk_extract')
  removeDirBestEffort(tempExtract)
  mkdirSync(tempExtract, { recursive: true })

  const isZip = archivePath.endsWith('.zip')
  if (isZip) {
    const escaped = archivePath.replace(/'/g, "''")
    const dest = tempExtract.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "& {Expand-Archive -Path '${escaped}' -DestinationPath '${dest}' -Force}"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`tar -xzf '${archivePath}' -C '${tempExtract}'`, { stdio: 'inherit' })
  }

  const jdkRoot = findJdkRootInDir(tempExtract)
  if (!jdkRoot) {
    removeDirBestEffort(tempExtract)
    throw new Error('JDK 解压后未找到 bin/java')
  }

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
  cpSync(jdkRoot, targetDir, { recursive: true })
  removeDirBestEffort(tempExtract)

  if (!isValidJdkDir(targetDir)) {
    throw new Error('JDK setup failed after extract')
  }
}

/** 下载解压过程日志回调：msg 文本消息，pct 可选下载进度 0-100 */
export type DownloadLogFn = (msg: string, pct?: number) => void

export async function downloadAndExtractJdk(
  targetDir: string,
  workDir: string,
  onLog?: DownloadLogFn
): Promise<void> {
  const log = onLog || (() => {})
  mkdirSync(workDir, { recursive: true })
  const archivePath = path.join(
    workDir,
    `_jdk-21-download${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
  )

  if (isValidJdkDir(targetDir)) return

  const urls: string[] = []
  const adoptium = await resolveJdkDownloadUrl(log)
  if (adoptium) urls.push(adoptium)

  const seen = new Set<string>()
  const failures: string[] = []
  let downloaded = false
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    log(`正在下载 JDK 21…（源：${new URL(url).host}）`)
    try {
      await downloadFileResumable(url, archivePath, JDK_SHA256, (received, total) => {
        if (total > 0) {
          const pct = Math.floor((received / total) * 100)
          log(`正在下载 JDK 21… ${pct}%`, pct)
        } else {
          log(`正在下载 JDK 21… 已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
        }
      })
      if (isValidArchive(archivePath, 40_000_000)) {
        downloaded = true
        break
      }
      failures.push(`${new URL(url).host}: 下载文件校验失败（大小异常）`)
    } catch (err) {
      const reason = `${new URL(url).host}: ${String(err)}`
      failures.push(reason)
      log(`JDK 下载失败: ${reason}`)
    }
  }

  if (!downloaded) {
    throw new Error(
      `无法下载 JDK 21（便携版需联网）: ${failures.join('；') || '无可用下载源'}。请检查网络连接与系统代理设置后重试`
    )
  }

  log('正在解压 JDK 21…')
  extractJdkArchive(archivePath, targetDir, workDir)
  try {
    if (existsSync(archivePath)) rmSync(archivePath)
  } catch { /* ignore */ }
}

export function extractGradleArchive(zipPath: string, targetDir: string, tempParent: string): void {
  const tempExtract = path.join(tempParent, '_gradle_extract')
  removeDirBestEffort(tempExtract)
  mkdirSync(tempExtract, { recursive: true })

  if (process.platform === 'win32') {
    const escaped = zipPath.replace(/'/g, "''")
    const dest = tempExtract.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "& {Expand-Archive -Path '${escaped}' -DestinationPath '${dest}' -Force}"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`unzip -q '${zipPath}' -d '${tempExtract}'`, { stdio: 'inherit' })
  }

  const extracted = path.join(tempExtract, `gradle-${GRADLE_VERSION}`)
  const alt = path.join(tempExtract, GRADLE_DIST_NAME)
  const src = existsSync(extracted) ? extracted : existsSync(alt) ? alt : null
  if (!src) {
    removeDirBestEffort(tempExtract)
    throw new Error(`Expected gradle-${GRADLE_VERSION} after extract`)
  }

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
  cpSync(src, targetDir, { recursive: true })
  removeDirBestEffort(tempExtract)

  if (!isCompleteGradleDist(targetDir)) {
    throw new Error('Gradle setup failed after extract')
  }
}

export async function downloadAndExtractGradle(
  targetDir: string,
  workDir: string,
  onLog?: DownloadLogFn
): Promise<void> {
  const log = onLog || (() => {})
  mkdirSync(workDir, { recursive: true })
  const zipPath = path.join(workDir, `${GRADLE_DIST_NAME}.zip`)

  if (isCompleteGradleDist(targetDir)) return

  // 测速选优：不同网络下各源速度差异巨大（实测官方源 43KB/s vs 腾讯云 14MB/s），
  // 先并发探测候选源，按最快顺序依次下载（失败自动换下一个）；结果经 env:sourceProbe 面板展示
  const ordered = await pickFastestUrls(
    GRADLE_MIRROR_URLS.map((url) => ({ url, label: new URL(url).host }))
  )

  const failures: string[] = []
  let downloaded = false
  for (const { url, label } of ordered) {
    log(`正在下载 Gradle 9.5…（源：${label}）`)
    try {
      await downloadFileResumable(url, zipPath, GRADLE_SHA256, (received, total) => {
        if (total > 0) {
          const pct = Math.floor((received / total) * 100)
          log(`正在下载 Gradle 9.5… ${pct}%`, pct)
        } else {
          log(`正在下载 Gradle 9.5… 已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
        }
      })
      if (isValidArchive(zipPath, 1_000_000)) {
        downloaded = true
        break
      }
      failures.push(`${new URL(url).host}: 下载文件校验失败（大小异常）`)
    } catch (err) {
      const reason = `${new URL(url).host}: ${String(err)}`
      failures.push(reason)
      log(`Gradle 下载失败: ${reason}`)
    }
  }

  if (!downloaded) {
    throw new Error(
      `无法下载 Gradle（便携版需联网）: ${failures.join('；') || '无可用下载源'}。请检查网络连接与系统代理设置后重试`
    )
  }

  log('正在解压 Gradle…')
  extractGradleArchive(zipPath, targetDir, workDir)
  try {
    if (existsSync(zipPath)) rmSync(zipPath)
  } catch { /* ignore */ }
}
