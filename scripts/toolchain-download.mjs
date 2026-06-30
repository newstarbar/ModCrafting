/**
 * Shared JDK / Gradle download helpers (setup-toolchain + portable runtime).
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, cpSync, readdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { execSync } from 'child_process'
import path from 'path'

export const GRADLE_VERSION = '9.5.0'
export const GRADLE_DIST_NAME = `gradle-${GRADLE_VERSION}-bin`
export const GRADLE_RUNTIME_FOLDER = 'gradle-9.5'
export const GRADLE_LAUNCHER_JAR = `gradle-launcher-${GRADLE_VERSION}.jar`

export const GRADLE_MIRROR_URLS = [
  `https://services.gradle.org/distributions/${GRADLE_DIST_NAME}.zip`,
  `https://mirrors.cloud.tencent.com/gradle/${GRADLE_DIST_NAME}.zip`
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

export async function downloadWithPowerShell(url, dest) {
  const escapedUrl = url.replace(/'/g, "''")
  const escapedDest = dest.replace(/'/g, "''")
  execSync(
    `powershell -NoProfile -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedDest}' -UseBasicParsing}"`,
    { stdio: 'inherit' }
  )
}

export async function downloadWithFetch(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
}

export async function downloadFile(url, dest) {
  if (process.platform === 'win32') {
    await downloadWithPowerShell(url, dest)
  } else {
    await downloadWithFetch(url, dest)
  }
}

export async function resolveJdkDownloadUrl() {
  const os = adoptiumOs()
  const arch = adoptiumArch()
  const api =
    `https://api.adoptium.net/v3/assets/latest/21/hotspot` +
    `?os=${os}&architecture=${arch}&image_type=jdk&release_type=ga`

  try {
    const res = await fetch(api, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`Adoptium API HTTP ${res.status}`)
    const assets = await res.json()
    const link = assets?.[0]?.binary?.package?.link
    if (link) return link
  } catch (err) {
    console.warn(`Adoptium API failed: ${err.message || err}`)
  }

  if (process.platform === 'win32' && arch === 'x64') {
    return 'https://aka.ms/download-jdk/microsoft-jdk-21.0.6-windows-x64.zip'
  }
  return null
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

  const urls = []
  const adoptium = await resolveJdkDownloadUrl()
  if (adoptium) urls.push(adoptium)
  if (process.platform === 'win32' && adoptiumArch() === 'x64') {
    urls.push('https://aka.ms/download-jdk/microsoft-jdk-21.0.6-windows-x64.zip')
  }

  const seen = new Set()
  let downloaded = false
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    onLog(`Trying JDK: ${url}`)
    if (existsSync(archivePath)) rmSync(archivePath)
    try {
      await downloadFile(url, archivePath)
      if (isValidArchive(archivePath, 40_000_000)) {
        downloaded = true
        break
      }
    } catch (err) {
      onLog(`JDK download failed: ${err.message || err}`)
    }
  }

  if (!downloaded) {
    throw new Error('无法下载 JDK 21，请检查网络后重试')
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

  let downloaded = false
  for (const url of GRADLE_MIRROR_URLS) {
    onLog(`Trying Gradle: ${url}`)
    if (existsSync(zipPath)) rmSync(zipPath)
    try {
      await downloadFile(url, zipPath)
      if (isValidArchive(zipPath, 1_000_000)) {
        downloaded = true
        break
      }
    } catch (err) {
      onLog(`Gradle download failed: ${err.message || err}`)
    }
  }

  if (!downloaded) {
    throw new Error('无法下载 Gradle，请检查网络后重试')
  }

  extractGradleArchive(zipPath, targetDir, workDir)
  try {
    if (existsSync(zipPath)) rmSync(zipPath)
  } catch { /* ignore */ }
}
