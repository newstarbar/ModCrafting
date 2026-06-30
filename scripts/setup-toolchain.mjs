#!/usr/bin/env node
/**
 * Prepare bundled toolchain under resources/:
 *   - JDK 21 (Eclipse Temurin, with Windows fallbacks)
 *   - Gradle 9.5 distribution
 *
 * Run before packaging: npm run setup:toolchain
 */
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, cpSync, readdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const resourcesDir = path.join(root, 'resources')

// ── Gradle ──
const gradleVersion = '9.5.0'
const gradleDistName = `gradle-${gradleVersion}-bin`
const gradleZipPath = path.join(resourcesDir, `${gradleDistName}.zip`)
const gradleTargetDir = path.join(resourcesDir, 'gradle-9.5')
const gradleLauncherJar = path.join(gradleTargetDir, 'lib', `gradle-launcher-${gradleVersion}.jar`)

const GRADLE_MIRROR_URLS = [
  `https://services.gradle.org/distributions/${gradleDistName}.zip`,
  `https://mirrors.cloud.tencent.com/gradle/${gradleDistName}.zip`
]

// ── JDK ──
const jdkTargetDir = path.join(resourcesDir, 'jdk-21')
const jdkArchivePath = path.join(resourcesDir, `_jdk-21-download${process.platform === 'win32' ? '.zip' : '.tar.gz'}`)
const jdkJavaBin = path.join(jdkTargetDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')

function hasCompleteGradle() {
  return existsSync(gradleLauncherJar)
}

function hasCompleteJdk() {
  if (!existsSync(jdkJavaBin)) return false
  try {
    return statSync(jdkJavaBin).size > 10_000
  } catch {
    return false
  }
}

function removeDirBestEffort(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 })
  } catch (err) {
    console.warn(`Warning: could not remove ${dir}: ${err.message || err}`)
  }
}

function isValidArchive(filePath, minBytes = 50_000_000) {
  try {
    return existsSync(filePath) && statSync(filePath).size > minBytes
  } catch {
    return false
  }
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

function adoptiumArch() {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

async function downloadWithPowerShell(url, dest) {
  const escapedUrl = url.replace(/'/g, "''")
  const escapedDest = dest.replace(/'/g, "''")
  execSync(
    `powershell -NoProfile -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${escapedUrl}' -OutFile '${escapedDest}' -UseBasicParsing}"`,
    { stdio: 'inherit' }
  )
}

async function downloadWithFetch(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function downloadFile(url, dest) {
  if (process.platform === 'win32') {
    await downloadWithPowerShell(url, dest)
  } else {
    await downloadWithFetch(url, dest)
  }
}

async function resolveJdkDownloadUrl() {
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
    const name = assets?.[0]?.binary?.package?.name || ''
    if (link) {
      console.log(`Adoptium: ${name || link}`)
      return link
    }
  } catch (err) {
    console.warn(`Adoptium API failed: ${err.message || err}`)
  }

  if (process.platform === 'win32' && arch === 'x64') {
    return 'https://aka.ms/download-jdk/microsoft-jdk-21.0.6-windows-x64.zip'
  }

  return null
}

async function downloadJdkArchive() {
  const urls = []
  const adoptium = await resolveJdkDownloadUrl()
  if (adoptium) urls.push(adoptium)

  if (process.platform === 'win32' && adoptiumArch() === 'x64') {
    urls.push('https://aka.ms/download-jdk/microsoft-jdk-21.0.6-windows-x64.zip')
  }

  const seen = new Set()
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)

    console.log(`Trying JDK download: ${url}`)
    if (existsSync(jdkArchivePath)) rmSync(jdkArchivePath)

    try {
      await downloadFile(url, jdkArchivePath)
      if (isValidArchive(jdkArchivePath, 40_000_000)) {
        console.log(`JDK archive saved to ${jdkArchivePath}`)
        return
      }
      console.warn('Downloaded JDK archive too small, trying next mirror...')
    } catch (err) {
      console.warn(`Failed: ${err.message || err}`)
    }
  }

  throw new Error(
    '无法下载 JDK 21。请检查网络后重试: npm run setup:toolchain\n' +
    '或手动将 Temurin JDK 21 解压到 resources/jdk-21（需包含 bin/java）'
  )
}

function findJdkRootInDir(dir) {
  const javaName = process.platform === 'win32' ? 'java.exe' : 'java'
  const directJava = path.join(dir, 'bin', javaName)
  if (existsSync(directJava)) return dir

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(dir, entry.name)
    if (existsSync(path.join(candidate, 'bin', javaName))) return candidate
  }
  return null
}

function extractJdkArchive() {
  const tempExtract = path.join(resourcesDir, '_jdk_extract')
  removeDirBestEffort(tempExtract)
  mkdirSync(tempExtract, { recursive: true })

  console.log('Extracting JDK 21...')
  const isZip = jdkArchivePath.endsWith('.zip')

  if (isZip) {
    if (process.platform === 'win32') {
      const escaped = jdkArchivePath.replace(/'/g, "''")
      const dest = tempExtract.replace(/'/g, "''")
      execSync(
        `powershell -NoProfile -Command "& {Expand-Archive -Path '${escaped}' -DestinationPath '${dest}' -Force}"`,
        { stdio: 'inherit' }
      )
    } else {
      execSync(`unzip -q '${jdkArchivePath}' -d '${tempExtract}'`, { stdio: 'inherit' })
    }
  } else {
    execSync(`tar -xzf '${jdkArchivePath}' -C '${tempExtract}'`, { stdio: 'inherit' })
  }

  const jdkRoot = findJdkRootInDir(tempExtract)
  if (!jdkRoot) {
    removeDirBestEffort(tempExtract)
    throw new Error('JDK 解压后未找到 bin/java，请检查下载包是否完整')
  }

  if (existsSync(jdkTargetDir)) rmSync(jdkTargetDir, { recursive: true })
  cpSync(jdkRoot, jdkTargetDir, { recursive: true })
  removeDirBestEffort(tempExtract)

  try {
    if (existsSync(jdkArchivePath)) rmSync(jdkArchivePath)
  } catch {
    console.warn(`Warning: could not remove ${jdkArchivePath}`)
  }

  if (!hasCompleteJdk()) {
    throw new Error('JDK setup failed: java binary missing after extract')
  }

  console.log(`JDK 21 ready at ${jdkTargetDir}`)
}

async function setupJdk() {
  if (hasCompleteJdk()) {
    console.log('JDK 21 already complete at resources/jdk-21')
    return
  }

  if (!isValidArchive(jdkArchivePath, 40_000_000)) {
    await downloadJdkArchive()
  }

  extractJdkArchive()
}

async function downloadGradleZip() {
  for (const url of GRADLE_MIRROR_URLS) {
    console.log(`Trying Gradle: ${url}`)
    if (existsSync(gradleZipPath)) rmSync(gradleZipPath)
    try {
      await downloadFile(url, gradleZipPath)
      if (isValidArchive(gradleZipPath, 1_000_000)) {
        console.log(`Gradle archive saved to ${gradleZipPath}`)
        return
      }
    } catch (err) {
      console.warn(`Failed: ${err.message || err}`)
    }
  }
  throw new Error('无法下载 Gradle 发行版。请检查网络后重试: npm run setup:toolchain')
}

function extractGradleArchive() {
  const tempExtract = path.join(resourcesDir, '_gradle_extract')
  removeDirBestEffort(tempExtract)
  mkdirSync(tempExtract, { recursive: true })

  console.log('Extracting Gradle...')
  if (process.platform === 'win32') {
    const escaped = gradleZipPath.replace(/'/g, "''")
    const dest = tempExtract.replace(/'/g, "''")
    execSync(
      `powershell -NoProfile -Command "& {Expand-Archive -Path '${escaped}' -DestinationPath '${dest}' -Force}"`,
      { stdio: 'inherit' }
    )
  } else {
    execSync(`unzip -q '${gradleZipPath}' -d '${tempExtract}'`, { stdio: 'inherit' })
  }

  const extracted = path.join(tempExtract, `gradle-${gradleVersion}`)
  const alt = path.join(tempExtract, gradleDistName)
  const src = existsSync(extracted) ? extracted : existsSync(alt) ? alt : null

  if (!src) {
    removeDirBestEffort(tempExtract)
    throw new Error(`Expected gradle-${gradleVersion} in ${tempExtract} after extract`)
  }

  if (existsSync(gradleTargetDir)) rmSync(gradleTargetDir, { recursive: true })
  cpSync(src, gradleTargetDir, { recursive: true })
  removeDirBestEffort(tempExtract)

  if (!hasCompleteGradle()) {
    throw new Error('Gradle setup failed: gradle-launcher jar missing')
  }

  console.log(`Gradle ready at ${gradleTargetDir}`)
}

async function setupGradle() {
  if (hasCompleteGradle()) {
    console.log('Gradle distribution already complete at resources/gradle-9.5')
    return
  }

  if (!isValidArchive(gradleZipPath, 1_000_000)) {
    await downloadGradleZip()
  }

  extractGradleArchive()
}

async function main() {
  mkdirSync(resourcesDir, { recursive: true })

  console.log('=== ModCrafting toolchain setup ===\n')

  console.log('[1/2] JDK 21')
  await setupJdk()

  console.log('\n[2/2] Gradle 9.5')
  await setupGradle()

  console.log('\nDone. resources/jdk-21 and resources/gradle-9.5 are ready for bundling.')
  console.log('Next: npm run prefetch:deps  (requires network, ~1 GB Fabric cache)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
