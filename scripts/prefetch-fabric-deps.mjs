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
  runOfflineBuildVerification
} from './gradle-seed-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
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
      spawn('taskkill', ['/PID', String(child.pid), '/F', '/T'], { shell: true, stdio: 'ignore' })
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
    const child = spawn('cmd', ['/c', 'gradlew.bat', ...args], {
      cwd,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: prefetchRuntime,
        JAVA_HOME: path.join(prefetchRuntime, 'jdk-21'),
        GRADLE_USER_HOME: gradleHome,
        PATH: `${path.join(prefetchRuntime, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      },
      shell: true
    })
    let timer
    let timedOut = false
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child)
        reject(new Error(`Gradle timed out after ${timeoutMs}ms: ${args.join(' ')}`))
      }, timeoutMs)
    }
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (timedOut) return
      if (code === 0) resolve(code)
      else reject(new Error(`Gradle exited ${code}: ${args.join(' ')}`))
    })
  })
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
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      cpSync(src, dest, { recursive: true })
      return
    } catch (err) {
      const retryable = ['EBUSY', 'EPERM', 'EDOM', 'EACCES'].includes(err?.code)
      if (!retryable || attempt === maxAttempts) throw err
      console.warn(`[prefetch] copy locked (${err.code}), retry ${attempt}/${maxAttempts} in 5s...`)
      await sleep(5000)
    }
  }
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
    console.log(`\n>>> gradlew ${args.join(' ')}`)
    await runGradle(prefetchProject, gradleHome, args, 30 * 60 * 1000)
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
