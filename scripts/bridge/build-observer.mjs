#!/usr/bin/env node
/**
 * Build ModCrafting Observer Fabric mod and copy jar into resources/_base_mods/.
 * Uses the same Gradle launcher pattern as ModCrafting offline verify projects.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const bridgeDir = path.join(root, 'bridge-mod')
const outJar = path.join(root, 'resources', '_base_mods', 'modcrafting-observer.jar')

function firstExisting(...candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return null
}

function resolveJavaHome() {
  const home = firstExisting(
    path.join(root, 'runtime', 'jdk-21'),
    path.join(root, 'resources', 'jdk-21')
  )
  if (!home) {
    throw new Error('JDK 21 未找到（runtime/jdk-21 或 resources/jdk-21），请先准备工具链')
  }
  return home
}

function resolveGradleLauncher() {
  return firstExisting(
    path.join(root, 'runtime', 'gradle-9.5', 'lib', 'gradle-launcher-9.5.0.jar'),
    path.join(root, 'resources', 'gradle-9.5', 'lib', 'gradle-launcher-9.5.0.jar'),
    path.join(root, 'resources', '_offline_verify_project', '.modcrafting', 'gradle-9.5', 'lib', 'gradle-launcher-9.5.0.jar')
  )
}

function resolveGradleUserHome() {
  const preferred = path.join(root, 'runtime', 'gradle-home')
  if (fs.existsSync(path.dirname(preferred))) {
    fs.mkdirSync(preferred, { recursive: true })
    return preferred
  }
  const fallback = path.join(bridgeDir, '.gradle-home')
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

function main() {
  const javaHome = resolveJavaHome()
  const launcher = resolveGradleLauncher()
  if (!launcher) {
    throw new Error('gradle-launcher-9.5.0.jar 未找到，请先 npm run toolchain:setup')
  }
  const gradleUserHome = resolveGradleUserHome()
  const javaBin = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')

  console.log('[bridge:build] JAVA_HOME =', javaHome)
  console.log('[bridge:build] GRADLE_USER_HOME =', gradleUserHome)
  console.log('[bridge:build] launcher =', launcher)
  console.log('[bridge:build] building bridge-mod …')

  const result = spawnSync(
    javaBin,
    [
      `-Dorg.gradle.appname=gradle`,
      `-Dorg.gradle.java.home=${javaHome}`,
      '-classpath',
      launcher,
      'org.gradle.launcher.GradleMain',
      'build',
      '--no-daemon'
    ],
    {
      cwd: bridgeDir,
      env: {
        ...process.env,
        JAVA_HOME: javaHome,
        GRADLE_USER_HOME: gradleUserHome,
        GRADLE_OPTS: `-Dorg.gradle.java.home=${javaHome}`
      },
      stdio: 'inherit'
    }
  )
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  const libsDir = path.join(bridgeDir, 'build', 'libs')
  if (!fs.existsSync(libsDir)) {
    throw new Error('build/libs 不存在')
  }
  const jars = fs
    .readdirSync(libsDir)
    .filter((f) => f.endsWith('.jar') && !f.includes('-sources') && !f.includes('-dev'))
    .sort()
  if (jars.length === 0) {
    throw new Error('未找到 remap 后的 jar')
  }
  const preferred =
    jars.find((f) => /^modcrafting-observer-\d/.test(f) && !f.includes('-sources')) || jars[0]
  const src = path.join(libsDir, preferred)
  fs.mkdirSync(path.dirname(outJar), { recursive: true })
  fs.copyFileSync(src, outJar)
  console.log('[bridge:build] copied', preferred, '→', outJar)
}

try {
  main()
} catch (err) {
  console.error('[bridge:build]', err instanceof Error ? err.message : err)
  process.exit(1)
}
