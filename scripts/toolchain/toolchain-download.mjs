/**
 * Shared JDK / Gradle download helpers (setup-toolchain + portable runtime).
 *
 * 注意：src/main/toolchain-download.ts 在 Electron 主进程运行，下载已切换为
 * Chromium 网络栈（net.fetch，绕过 Gitee 等源的 TLS 指纹限速）；本文件是纯
 * Node CLI（toolchain:setup 等），无 Electron，保持全局 fetch（undici）。
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, cpSync, readdirSync } from 'fs'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { execSync } from 'child_process'
import path from 'path'

export const GRADLE_VERSION = '9.5.0'
export const GRADLE_DIST_NAME = `gradle-${GRADLE_VERSION}-bin`
export const GRADLE_RUNTIME_FOLDER = 'gradle-9.5'
export const GRADLE_LAUNCHER_JAR = `gradle-launcher-${GRADLE_VERSION}.jar`

// 与 src/main/download-shared.ts 保持一致（mjs 为纯 Node CLI，无法 import ts 模块）
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// Gradle 发行版候选源（下载前会实测各源速度并优先用最快的；默认顺序仅作测速失败时的兜底）
export const GRADLE_MIRROR_URLS = [
  `https://mirrors.cloud.tencent.com/gradle/${GRADLE_DIST_NAME}.zip`,
  `https://mirrors.huaweicloud.com/gradle/${GRADLE_DIST_NAME}.zip`,
  `https://services.gradle.org/distributions/${GRADLE_DIST_NAME}.zip`
]

// JDK 21 GitHub release 地址（Adoptium Temurin 21.0.12+8，作为代理源与官方兜底的基础）
const GITHUB_JDK_URL = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12%2B8/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_8.zip'

// 清华 TUNA Adoptium 镜像（国内主源，实测同步完整且满速）
const TUNA_JDK_URL = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12_8.zip'

// 国内 JDK 镜像（Windows x64，按优先级排序）
// 实测 2026-08-03：清华 TUNA 14MB/s（200 OK）；ghproxy.com / gh-proxy.com 均已失效或极慢；
// 阿里云/中科大该版本 404；GitHub 直连 302 后无响应。
// 清华 TUNA 作为国内绝对主源，api.adoptium.net 与 GitHub 直连作为兜底；
// pickFastestUrls 实测选优，失效源自动排最后。
// 与 src/main/toolchain-download.ts 的 JDK_MIRROR_URLS_WIN_X64 保持完全一致（AGENTS.md 维护红线）。
const JDK_MIRROR_URLS_WIN_X64 = [
  TUNA_JDK_URL,                                  // 清华 TUNA（国内主源，实测 14MB/s 满速）
  'https://api.adoptium.net/v3/binary/version/jdk-21.0.12%2B8/windows/x64/jdk/hotspot/normal/eclipse',
  GITHUB_JDK_URL                                 // GitHub 直连（官方兜底）
]

export function adoptiumOs() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

export function adoptiumArch() {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

export function javaBinName() {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

export function isValidJdkDir(jdkDir) {
  const bin = path.join(jdkDir, 'bin', javaBinName())
  if (!existsSync(bin)) return false
  try {
    return statSync(bin).size > 10_000
  } catch {
    return false
  }
}

export function isCompleteGradleDist(gradleDir) {
  const launcher = path.join(gradleDir, 'lib', GRADLE_LAUNCHER_JAR)
  const bin = path.join(gradleDir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  return existsSync(bin) && existsSync(launcher)
}

export function isValidArchive(filePath, minBytes = 1_000_000) {
  try {
    return existsSync(filePath) && statSync(filePath).size > minBytes
  } catch {
    return false
  }
}

export function removeDirBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch (err) {
    console.warn(`Warning: could not remove ${dir}: ${err.message || err}`)
  }
}

/** 进度上报节流：字节增量 ≥256KB 或时间间隔 ≥300ms 且收到新数据才上报，避免高频回调刷爆 IPC */
const PROGRESS_THROTTLE_BYTES = 256 * 1024
const PROGRESS_THROTTLE_MS = 300

// 测速选优（与 src/main/download-probe.ts 逻辑同步，CLI 用 Node fetch/undici）
const PROBE_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 6000
const probeCache = new Map()

async function probeSpeed(url) {
  if (probeCache.has(url)) return probeCache.get(url)
  let speed = null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const t0 = Date.now()
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const reader = res.body.getReader()
    let received = 0
    while (received < PROBE_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
    }
    await reader.cancel().catch(() => {})
    const secs = (Date.now() - t0) / 1000
    if (received > 0 && secs > 0) speed = Math.round(received / 1024 / secs)
  } catch {
    /* 探测失败 → null */
  } finally {
    clearTimeout(timer)
  }
  probeCache.set(url, speed)
  return speed
}

async function pickFastestUrls(candidates, onLog) {
  if (candidates.length <= 1) return candidates
  onLog?.('正在检测下载源速度…')
  const results = await Promise.all(
    candidates.map(async (c) => ({ ...c, speedKBps: await probeSpeed(c.url) }))
  )
  const sorted = [...results].sort((a, b) => (b.speedKBps ?? -1) - (a.speedKBps ?? -1))
  const fastest = sorted[0]
  if (fastest.speedKBps && fastest.speedKBps > 0) {
    const s = fastest.speedKBps >= 1024 ? `${(fastest.speedKBps / 1024).toFixed(1)}MB/s` : `${fastest.speedKBps}KB/s`
    onLog?.(`已选择最快下载源：${fastest.label}（${s}）`)
  } else {
    onLog?.('下载源测速失败，按默认顺序下载')
  }
  return sorted
}

export async function downloadWithPowerShell(url, dest) {
  const escapedUrl = url.replace(/'/g, "''")
  const escapedDest = dest.replace(/'/g, "''")
  const escapedUa = DOWNLOAD_USER_AGENT.replace(/'/g, "''")
  try {
    execSync(
      `powershell -NoProfile -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedDest}' -UserAgent '${escapedUa}' -UseBasicParsing}"`,
      { stdio: ['ignore', 'inherit', 'pipe'] }
    )
  } catch (err) {
    const raw = err.stderr ? Buffer.from(err.stderr).toString() : String(err.message || err)
    const detail = raw.trim().split('\n').pop()?.trim() || ''
    throw new Error(`Download failed (exit ${err.status ?? '?'})${detail ? `: ${detail}` : ''}`)
  }
}

// 下载首字节超时：连接建立后服务器无数据（挂起/空 body）时失败触发换源。
// 30s 平衡两点：挂起源不至于无限等待；慢速但可用的源（国内访问国外 CDN 首字节可达 20s+）不被误杀。
const FIRST_BYTE_TIMEOUT_MS = 30_000

export async function downloadWithFetch(url, dest, onProgress) {
  const controller = new AbortController()
  const firstByteTimer = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)
  let res
  try {
    res = await fetch(url, {
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
    transform(chunk, _encoding, callback) {
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
    await pipeline(res.body, countingStream, createWriteStream(dest))
  } finally {
    if (!firstByteArrived) clearTimeout(firstByteTimer)
  }
  // 下载完成，确保进度到达 100%（totalBytes 未知时补报已接收字节）
  if (onProgress) onProgress(totalBytes > 0 ? totalBytes : received, totalBytes)
}

export async function downloadFile(url, dest, onProgress) {
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
      console.warn(`[download] fetch 失败，回退 PowerShell: ${err.message || err}`)
      try {
        rmSync(dest, { force: true })
      } catch { /* ignore */ }
    }
    await downloadWithPowerShell(url, dest)
  } else {
    await downloadWithFetch(url, dest, onProgress)
  }
}

export async function resolveJdkDownloadUrls() {
  const candidates = []

  // 候选源：GitHub 代理 + Adoptium API + GitHub 直连 + API 动态查询（测速选优，最快者优先）
  if (process.platform === 'win32' && adoptiumArch() === 'x64') {
    for (const url of JDK_MIRROR_URLS_WIN_X64) {
      candidates.push({ url, label: new URL(url).host })
    }
  }

  const os = adoptiumOs()
  const arch = adoptiumArch()
  const api =
    `https://api.adoptium.net/v3/assets/latest/21/hotspot` +
    `?os=${os}&architecture=${arch}&image_type=jdk&release_type=ga`

  try {
    const res = await fetch(api, {
      headers: { Accept: 'application/json', 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) throw new Error(`Adoptium API HTTP ${res.status}`)
    const assets = await res.json()
    const link = assets?.[0]?.binary?.package?.link
    if (link) candidates.push({ url: link, label: 'Adoptium' })
  } catch (err) {
    console.warn(`Adoptium API failed: ${err.message || err}`)
  }

  if (candidates.length === 0) return []

  const ordered = await pickFastestUrls(candidates, (msg) => console.log(`[jdk-download] ${msg}`))
  return ordered.map((candidate) => candidate.url)
}

export function findJdkRootInDir(dir) {
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

export function extractJdkArchive(archivePath, targetDir, tempParent) {
  const tempExtract = path.join(tempParent, '_jdk_extract')
  removeDirBestEffort(tempExtract)
  mkdirSync(tempExtract, { recursive: true })

  const isZip = archivePath.endsWith('.zip')
  if (isZip) {
    if (process.platform === 'win32') {
      const escaped = archivePath.replace(/'/g, "''")
      const dest = tempExtract.replace(/'/g, "''")
      execSync(
        `powershell -NoProfile -Command "& {Expand-Archive -Path '${escaped}' -DestinationPath '${dest}' -Force}"`,
        { stdio: 'inherit' }
      )
    } else {
      execSync(`unzip -q '${archivePath}' -d '${tempExtract}'`, { stdio: 'inherit' })
    }
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

export async function downloadAndExtractJdk(targetDir, workDir, onLog = console.log) {
  mkdirSync(workDir, { recursive: true })
  const archivePath = path.join(
    workDir,
    `_jdk-21-download${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
  )

  if (isValidJdkDir(targetDir)) return

  const urls = await resolveJdkDownloadUrls()

  const seen = new Set()
  const failures = []
  let downloaded = false
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    onLog(`正在下载 JDK 21…（源：${new URL(url).host}）`)
    if (existsSync(archivePath)) rmSync(archivePath)
    try {
      await downloadFile(url, archivePath, (received, total) => {
        if (total > 0) {
          const pct = Math.floor((received / total) * 100)
          onLog(`正在下载 JDK 21… ${pct}%`, pct)
        } else {
          onLog(`正在下载 JDK 21… 已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
        }
      })
      if (isValidArchive(archivePath, 40_000_000)) {
        downloaded = true
        break
      }
      failures.push(`${new URL(url).host}: 下载文件校验失败（大小异常）`)
    } catch (err) {
      const reason = `${new URL(url).host}: ${err.message || err}`
      failures.push(reason)
      onLog(`JDK 下载失败: ${reason}`)
    }
  }

  if (!downloaded) {
    throw new Error(
      `无法下载 JDK 21（便携版需联网）: ${failures.join('；') || '无可用下载源'}。请检查网络连接与系统代理设置后重试`
    )
  }

  extractJdkArchive(archivePath, targetDir, workDir)
  try {
    if (existsSync(archivePath)) rmSync(archivePath)
  } catch { /* ignore */ }
}

export function extractGradleArchive(zipPath, targetDir, tempParent) {
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

export async function downloadAndExtractGradle(targetDir, workDir, onLog = console.log) {
  mkdirSync(workDir, { recursive: true })
  const zipPath = path.join(workDir, `${GRADLE_DIST_NAME}.zip`)

  if (isCompleteGradleDist(targetDir)) return

  // 测速选优：不同网络下各源速度差异巨大（实测官方源 43KB/s vs 腾讯云 14MB/s）
  const ordered = await pickFastestUrls(
    GRADLE_MIRROR_URLS.map((url) => ({ url, label: new URL(url).host })),
    onLog
  )

  const failures = []
  let downloaded = false
  for (const { url, label } of ordered) {
    onLog(`正在下载 Gradle 9.5…（源：${label}）`)
    if (existsSync(zipPath)) rmSync(zipPath)
    try {
      await downloadFile(url, zipPath, (received, total) => {
        if (total > 0) {
          const pct = Math.floor((received / total) * 100)
          onLog(`正在下载 Gradle 9.5… ${pct}%`, pct)
        } else {
          onLog(`正在下载 Gradle 9.5… 已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
        }
      })
      if (isValidArchive(zipPath, 1_000_000)) {
        downloaded = true
        break
      }
      failures.push(`${new URL(url).host}: 下载文件校验失败（大小异常）`)
    } catch (err) {
      const reason = `${new URL(url).host}: ${err.message || err}`
      failures.push(reason)
      onLog(`Gradle 下载失败: ${reason}`)
    }
  }

  if (!downloaded) {
    throw new Error(
      `无法下载 Gradle（便携版需联网）: ${failures.join('；') || '无可用下载源'}。请检查网络连接与系统代理设置后重试`
    )
  }

  extractGradleArchive(zipPath, targetDir, workDir)
  try {
    if (existsSync(zipPath)) rmSync(zipPath)
  } catch { /* ignore */ }
}
