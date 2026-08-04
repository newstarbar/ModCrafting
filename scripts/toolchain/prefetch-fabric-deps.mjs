#!/usr/bin/env node
/**
 * Online prefetch of Fabric/Minecraft dependencies into resources/gradle-home-seed.
 * Run once before packaging: npm run prefetch:deps
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { FABRIC_VERSIONS } from './fabric-versions.mjs'
import { setupPrefetchProject } from './fabric-template.mjs'
import {
  sanitizeGradleHomeForSeed,
  validateSeedContent,
  validateSeedIntegrity,
  writeSeedMarker,
  runOfflineBuildVerification,
  copyGradleHomeToSeedDir
} from './gradle-seed-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const resourcesDir = path.join(root, 'resources')
const seedDir = path.join(resourcesDir, 'gradle-home-seed')
const seedMarker = path.join(seedDir, '.modcrafting-seed.json')
const prefetchRuntime = path.join(resourcesDir, '_prefetch_runtime')
const prefetchProject = path.join(resourcesDir, '_prefetch_project')
const jdkSrc = path.join(resourcesDir, 'jdk-21')
const gradleSrc = path.join(resourcesDir, 'gradle-9.5')
const GRADLE_RUNTIME_DIR = 'gradle-9.5'
const GRADLE_DIST_NAME = `gradle-${FABRIC_VERSIONS.gradle_version}-bin`
const GRADLE_HOME_DIR = `gradle-${FABRIC_VERSIONS.gradle_version}`
const force = process.argv.includes('--force')
const skipVerify = process.argv.includes('--skip-verify')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function killProcessTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* ignore */
  }
}

function seedFingerprintValid() {
  if (!existsSync(seedMarker)) return false
  try {
    const marker = JSON.parse(readFileSync(seedMarker, 'utf-8'))
    for (const [k, v] of Object.entries(FABRIC_VERSIONS)) {
      if (marker[k] !== v) return false
    }
    if (!marker.verifiedOffline) return false
    const integrity = validateSeedIntegrity(seedDir)
    return integrity.ok && marker.fileCount > 100 && marker.totalBytes > 50_000_000
  } catch {
    return false
  }
}

function setupRuntime() {
  mkdirSync(prefetchRuntime, { recursive: true })
  const jdkDest = path.join(prefetchRuntime, 'jdk-21')
  const gradleDest = path.join(prefetchRuntime, GRADLE_RUNTIME_DIR)
  const gradleHome = path.join(prefetchRuntime, 'gradle-home')

  if (!existsSync(jdkSrc)) {
    throw new Error('缺少 resources/jdk-21，请先运行: npm run setup:toolchain')
  }
  if (!existsSync(gradleSrc)) {
    throw new Error('缺少 resources/gradle-9.5，请运行 npm run setup:toolchain')
  }

  if (existsSync(jdkDest)) rmSync(jdkDest, { recursive: true, force: true })
  if (existsSync(gradleDest)) rmSync(gradleDest, { recursive: true, force: true })
  if (force && existsSync(gradleHome)) rmSync(gradleHome, { recursive: true, force: true })
  if (force && existsSync(seedDir)) rmSync(seedDir, { recursive: true, force: true })

  cpSync(jdkSrc, jdkDest, { recursive: true })
  cpSync(gradleSrc, gradleDest, { recursive: true })
  mkdirSync(gradleHome, { recursive: true })

  // Pre-seed Gradle wrapper dist (offline)
  const wrapperDists = path.join(gradleHome, 'wrapper', 'dists', GRADLE_DIST_NAME, 'modcrafting-offline')
  const targetGradle = path.join(wrapperDists, GRADLE_HOME_DIR)
  mkdirSync(targetGradle, { recursive: true })
  cpSync(gradleDest, targetGradle, { recursive: true })
  writeFileSync(path.join(wrapperDists, `${GRADLE_DIST_NAME}.zip.ok`), '', 'utf-8')

  return gradleHome
}

function runGradle(cwd, gradleHome, args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd', ['/c', '.\\gradlew.bat', ...args], {
      cwd,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: prefetchRuntime,
        JAVA_HOME: path.join(prefetchRuntime, 'jdk-21'),
        GRADLE_USER_HOME: gradleHome,
        PATH: `${path.join(prefetchRuntime, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      }
    })
    let timer
    let timedOut = false
    // 收集输出用于失败时判断是否为瞬态网络错误
    let outputBuf = ''
    const appendOutput = (d) => {
      const s = d.toString()
      outputBuf += s
      process.stdout.write(d)
    }
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', (d) => {
      outputBuf += d.toString()
      process.stderr.write(d)
    })
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        reject(new Error(`Gradle timed out after ${timeoutMs}ms: ${args.join(' ')}`))
      }, timeoutMs)
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (timedOut) return
      if (code === 0) resolve(code)
      else {
        const err = new Error(`Gradle exited ${code}: ${args.join(' ')}`)
        err.output = outputBuf
        reject(err)
      }
    })
  })
}

/**
 * 带重试的 Gradle 构建。Maven Central 偶发 429 Too Many Requests 时自动重试。
 * 重试时不再使用 --refresh-dependencies（避免再次触发全量下载），并增加 Gradle
 * 的 HTTP 超时与重试参数。
 */
async function runGradleWithRetry(cwd, gradleHome, args, timeoutMs = 0, maxAttempts = 3) {
  const isBuildTask = args.includes('build')
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryArgs = [...args]
    // 重试时移除 --refresh-dependencies，复用已下载的依赖
    if (attempt > 1) {
      const idx = retryArgs.indexOf('--refresh-dependencies')
      if (idx >= 0) retryArgs.splice(idx, 1)
    }
    // 增加 Gradle HTTP 超时与重试（通过系统属性）
    retryArgs.unshift(
      '-Dorg.gradle.internal.http.connectionTimeout=120000',
      '-Dorg.gradle.internal.http.socketTimeout=120000'
    )
    console.log(`\n>>> gradlew ${retryArgs.join(' ')} (attempt ${attempt}/${maxAttempts})`)
    try {
      const code = await runGradle(cwd, gradleHome, retryArgs, timeoutMs)
      return code
    } catch (err) {
      lastErr = err
      // 从 Gradle 输出中判断是否为瞬态网络错误（429 / 连接失败等）
      const output = String(err.output || err.message || err)
      const isTransient = isBuildTask && /429|Too Many Requests|Could not GET|Could not HEAD|Could not get resource|Connection timed out|Could not parse POM/i.test(output)
      if (!isTransient || attempt === maxAttempts) throw err
      const waitSec = 30 * attempt
      console.warn(`\n[retry] Gradle 构建失败（可能为 Maven Central 限流），${waitSec}s 后重试…`)
      console.warn(`[retry] 错误摘要: ${output.split('\n').find((l) => /429|Too Many|Could not/i.test(l)) || output.split('\n')[0]}`)
      await sleep(waitSec * 1000)
    }
  }
  throw lastErr
}

async function stopGradleDaemons(gradleHome) {
  console.log('Stopping Gradle daemons before copying cache...')
  try {
    await runGradle(prefetchProject, gradleHome, ['--stop'], 60_000)
  } catch {
    // --stop may return non-zero when no daemons were running
  }
  await sleep(3000)
}

async function copyGradleHomeToSeed(src, dest) {
  await copyGradleHomeToSeedDir(src, dest)
}

async function main() {
  if (!force && seedFingerprintValid()) {
    console.log('gradle-home-seed already valid, skipping (use --force to rebuild)')
    return
  }

  console.log('Setting up prefetch runtime...')
  const gradleHome = setupRuntime()

  console.log('Creating prefetch Fabric project...')
  await setupPrefetchProject(prefetchProject, prefetchRuntime, gradleSrc)

  const tasks = [
    ['build', '--refresh-dependencies', '--no-daemon'],
    ['downloadAssets', '--no-daemon']
  ]

  for (const args of tasks) {
    // build 任务使用带重试的执行器（应对 Maven Central 偶发 429 限流）
    if (args.includes('build')) {
      await runGradleWithRetry(prefetchProject, gradleHome, args, 30 * 60 * 1000, 3)
    } else {
      console.log(`\n>>> gradlew ${args.join(' ')}`)
      await runGradle(prefetchProject, gradleHome, args, 30 * 60 * 1000)
    }
  }

  // Brief runClient to pull launch natives/classpath into loom cache
  console.log('\n>>> gradlew runClient (brief, for launch cache)...')
  try {
    await runGradle(prefetchProject, gradleHome, ['runClient', '--no-daemon'], 3 * 60 * 1000)
  } catch {
    console.warn('runClient prefetch timed out or failed (transform caches will be stripped before seed copy)')
  }

  await stopGradleDaemons(gradleHome)

  console.log('\nSanitizing gradle-home before seed copy...')
  sanitizeGradleHomeForSeed(gradleHome)

  console.log('\nCopying gradle-home to seed directory...')
  await copyGradleHomeToSeed(gradleHome, seedDir)

  sanitizeGradleHomeForSeed(seedDir)

  const integrity = validateSeedContent(seedDir)
  if (!integrity.ok) {
    rmSync(seedDir, { recursive: true, force: true })
    throw new Error(`Seed content check failed after copy:\n- ${integrity.errors.join('\n- ')}`)
  }

  if (!skipVerify) {
    console.log('\nVerifying offline build against seed...')
    const verify = await runOfflineBuildVerification({ root, seedDir })
    if (!verify.ok) {
      rmSync(seedDir, { recursive: true, force: true })
      throw new Error(
        `Offline build verification failed (exit ${verify.exitCode}). Seed was not finalized.\n` +
        'Re-run with: npm run prefetch:deps -- --force'
      )
    }
    console.log('Offline build verification passed.')
  } else {
    console.warn('Skipping offline verification (--skip-verify)')
  }

  const marker = writeSeedMarker(seedDir)
  const { fileCount, totalBytes } = marker

  console.log(`\nDone. Seed: ${seedDir}`)
  console.log(`Files: ${fileCount}, Size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log('Marker:', seedMarker)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
