/**
 * Shared helpers for gradle-home-seed generation, validation, and offline verification.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { FABRIC_VERSIONS } from './fabric-versions.mjs'
import { setupPrefetchProject, generateGradleWrapperProperties } from './fabric-template.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.join(scriptDir, '..')
export const GRADLE_RUNTIME_DIR = 'gradle-9.5'
export const GRADLE_LAUNCHER = `gradle-launcher-${FABRIC_VERSIONS.gradle_version}.jar`

/** Fabric API modules required for the default template offline build. */
export const REQUIRED_FABRIC_API_MODULES = [
  'fabric-api',
  'fabric-api-lookup-api-v1',
  'fabric-blockrenderlayer-v1',
  'fabric-client-tags-api-v1',
  'fabric-content-registries-v0',
  'fabric-data-generation-api-v1',
  'fabric-convention-tags-v1',
  'fabric-convention-tags-v2',
  'fabric-data-attachment-api-v1',
  'fabric-events-interaction-v0',
  'fabric-lifecycle-events-v1',
  'fabric-model-loading-api-v1',
  'fabric-screen-handler-api-v1',
  'fabric-networking-api-v1',
  'fabric-object-builder-api-v1',
  'fabric-rendering-fluids-v1',
  'fabric-rendering-data-attachment-v1',
  'fabric-block-view-api-v2',
  'fabric-client-gametest-api-v1',
  'fabric-crash-report-info-v1',
  'fabric-key-binding-api-v1',
  'fabric-resource-conditions-api-v1',
  'fabric-resource-loader-v0',
  'fabric-transitive-access-wideners-v1'
]

const EPHEMERAL_TOP_LEVEL = new Set([
  'daemon',
  'notifications',
  'native',
  'workers',
  'jdks',
  'android',
  'kotlin-profile',
  'mc-instances'
])

const EPHEMERAL_CACHE_CHILDREN = new Set([
  'transforms',
  'executionHistory',
  'fileContent',
  'generated-gradle-jars',
  'jars-9',
  'journal-1'
])

export function countDirStats(dir) {
  let fileCount = 0
  let totalBytes = 0
  function walk(d) {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        fileCount++
        try { totalBytes += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  walk(dir)
  return { fileCount, totalBytes }
}

function removeDirSafe(target) {
  if (!existsSync(target)) return
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (err) {
    console.warn(`[seed] failed to remove ${target}: ${err?.message || err}`)
  }
}

/**
 * Strip machine-local / rebuildable Gradle state before distributing gradle-home as seed.
 */
export function sanitizeGradleHomeForSeed(gradleHome, { log = console.log } = {}) {
  if (!existsSync(gradleHome)) return { removed: 0 }

  let removed = 0
  for (const name of EPHEMERAL_TOP_LEVEL) {
    const target = path.join(gradleHome, name)
    if (existsSync(target)) {
      log(`[seed] removing ${name}/`)
      removeDirSafe(target)
      removed++
    }
  }

  const cachesRoot = path.join(gradleHome, 'caches')
  if (existsSync(cachesRoot)) {
    for (const versionDir of readdirSync(cachesRoot, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue
      const cacheVersionPath = path.join(cachesRoot, versionDir.name)
      for (const child of readdirSync(cacheVersionPath, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        if (!EPHEMERAL_CACHE_CHILDREN.has(child.name)) continue
        const target = path.join(cacheVersionPath, child.name)
        log(`[seed] removing caches/${versionDir.name}/${child.name}/`)
        removeDirSafe(target)
        removed++
      }
    }
  }

  return { removed }
}

function fabricApiModuleDir(gradleHome, moduleName) {
  return path.join(
    gradleHome,
    'caches',
    'modules-2',
    'files-2.1',
    'net.fabricmc.fabric-api',
    moduleName
  )
}

function moduleHasJar(moduleDir) {
  if (!existsSync(moduleDir)) return false
  try {
    return readdirSync(moduleDir, { recursive: true }).some((entry) => String(entry).endsWith('.jar'))
  } catch {
    return false
  }
}

/** Validate seed cache contents (no marker required — used before marker is written). */
export function validateSeedContent(gradleHome, versions = FABRIC_VERSIONS) {
  const errors = []

  const fabricApiRoot = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1', 'net.fabricmc.fabric-api')
  if (!existsSync(fabricApiRoot)) {
    errors.push('missing net.fabricmc.fabric-api cache')
  } else {
    const missingModules = REQUIRED_FABRIC_API_MODULES.filter(
      (name) => !moduleHasJar(fabricApiModuleDir(gradleHome, name))
    )
    if (missingModules.length > 0) {
      errors.push(`missing Fabric API modules: ${missingModules.slice(0, 5).join(', ')}${missingModules.length > 5 ? ` (+${missingModules.length - 5} more)` : ''}`)
    }
  }

  const loomCache = path.join(gradleHome, 'caches', 'fabric-loom')
  if (!existsSync(loomCache)) {
    errors.push('missing caches/fabric-loom')
  } else {
    try {
      const entries = readdirSync(loomCache, { recursive: true })
      const hasMc = entries.some((e) => String(e).includes('minecraft') || String(e).includes(versions.minecraft_version))
      if (!hasMc) errors.push('fabric-loom cache missing minecraft artifacts')
    } catch {
      errors.push('cannot read fabric-loom cache')
    }
  }

  const wrapperDists = path.join(gradleHome, 'wrapper', 'dists')
  if (!existsSync(wrapperDists)) {
    errors.push('missing wrapper/dists')
  }

  const cachesRoot = path.join(gradleHome, 'caches')
  if (existsSync(cachesRoot)) {
    for (const versionDir of readdirSync(cachesRoot, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue
      const transforms = path.join(cachesRoot, versionDir.name, 'transforms')
      if (existsSync(transforms)) {
        errors.push(`seed must not contain caches/${versionDir.name}/transforms`)
      }
    }
  }

  if (existsSync(path.join(gradleHome, 'mc-instances'))) {
    errors.push('seed must not contain mc-instances')
  }

  return { ok: errors.length === 0, errors }
}

export function validateSeedMarker(gradleHome, versions = FABRIC_VERSIONS) {
  const errors = []
  const markerPath = path.join(gradleHome, '.modcrafting-seed.json')

  if (!existsSync(markerPath)) {
    errors.push('missing .modcrafting-seed.json')
    return { ok: false, errors }
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'))
    for (const [k, v] of Object.entries(versions)) {
      if (marker[k] !== v) errors.push(`marker version mismatch: ${k}`)
    }
    if ((marker.fileCount ?? 0) <= 100) errors.push('marker fileCount too small')
    if ((marker.totalBytes ?? 0) <= 50_000_000) errors.push('marker totalBytes too small')
    if (marker.verifiedOffline !== true) errors.push('marker not offline-verified')
  } catch {
    errors.push('invalid .modcrafting-seed.json')
  }

  return { ok: errors.length === 0, errors }
}

export function validateSeedIntegrity(gradleHome, versions = FABRIC_VERSIONS) {
  const content = validateSeedContent(gradleHome, versions)
  const marker = validateSeedMarker(gradleHome, versions)
  const errors = [...content.errors, ...marker.errors]
  return { ok: errors.length === 0, errors }
}

export function writeSeedMarker(seedDir, versions = FABRIC_VERSIONS) {
  const { fileCount, totalBytes } = countDirStats(seedDir)
  const marker = {
    ...versions,
    fileCount,
    totalBytes,
    createdAt: new Date().toISOString(),
    verifiedOffline: true
  }
  writeFileSync(path.join(seedDir, '.modcrafting-seed.json'), JSON.stringify(marker, null, 2), 'utf-8')
  return marker
}

function buildVerifyGradlewBat(runtimeRoot, projectPath) {
  return `@echo off
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set "MODCRAFTING_RUNTIME=${runtimeRoot.replace(/\\/g, '\\\\')}"
set "JAVA_HOME=%MODCRAFTING_RUNTIME%\\jdk-21"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${GRADLE_RUNTIME_DIR}"
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`
}

/**
 * Run an offline build against a seed copy in a fresh runtime/gradle-home.
 */
export async function runOfflineBuildVerification({
  root = PROJECT_ROOT,
  seedDir = path.join(PROJECT_ROOT, 'resources', 'gradle-home-seed'),
  runtimeRoot = path.join(root, 'runtime'),
  projectPath = path.join(root, 'resources', '_offline_verify_project'),
  log = console.log
} = {}) {
  const jdkSrc = path.join(root, 'resources', 'jdk-21')
  const gradleSrc = path.join(root, 'resources', GRADLE_RUNTIME_DIR)
  if (!existsSync(seedDir)) {
    return { ok: false, exitCode: 1, output: 'gradle-home-seed directory missing; run npm run prefetch:deps' }
  }

  const integrity = validateSeedContent(seedDir)
  if (!integrity.ok) {
    return {
      ok: false,
      exitCode: 1,
      output: `Seed content check failed:\n- ${integrity.errors.join('\n- ')}`
    }
  }

  mkdirSync(runtimeRoot, { recursive: true })
  const jdkDest = path.join(runtimeRoot, 'jdk-21')
  const gradleDest = path.join(runtimeRoot, GRADLE_RUNTIME_DIR)
  const gradleHome = path.join(runtimeRoot, 'gradle-home')

  if (!existsSync(jdkDest) && existsSync(jdkSrc)) cpSync(jdkSrc, jdkDest, { recursive: true })
  if (!existsSync(gradleDest) && existsSync(gradleSrc)) cpSync(gradleSrc, gradleDest, { recursive: true })
  if (existsSync(gradleHome)) rmSync(gradleHome, { recursive: true, force: true })
  cpSync(seedDir, gradleHome, { recursive: true })

  await setupPrefetchProject(projectPath, runtimeRoot, gradleSrc)

  writeFileSync(
    path.join(projectPath, 'gradle.properties'),
    readFileSync(path.join(projectPath, 'gradle.properties'), 'utf-8') + '\norg.gradle.offline=true\n',
    'utf-8'
  )
  writeFileSync(
    path.join(projectPath, 'gradle', 'wrapper', 'gradle-wrapper.properties'),
    generateGradleWrapperProperties(),
    'utf-8'
  )
  writeFileSync(path.join(projectPath, 'gradlew.bat'), buildVerifyGradlewBat(runtimeRoot, projectPath), 'utf-8')

  log('Running offline build verification...')

  const result = await new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'gradlew.bat', '--offline', 'build', '--no-daemon'], {
      cwd: projectPath,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: gradleHome,
        ORG_GRADLE_PROJECT_org_gradle_offline: 'true',
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      },
      shell: true
    })
    let out = ''
    const onData = (d) => {
      const text = d.toString()
      out += text
      process.stdout.write(d)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })

  const offlineIssue = /Could not resolve|No cached version|offline mode|immutable workspace/i.test(result.out)
  return {
    ok: result.code === 0 && !offlineIssue,
    exitCode: result.code,
    output: result.out,
    offlineIssue
  }
}
