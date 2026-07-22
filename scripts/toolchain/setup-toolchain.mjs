#!/usr/bin/env node
/**
 * Prepare bundled toolchain under resources/ (Setup edition build only).
 */
import { existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  GRADLE_DIST_NAME,
  GRADLE_LAUNCHER_JAR,
  GRADLE_RUNTIME_FOLDER,
  downloadAndExtractGradle,
  downloadAndExtractJdk,
  isCompleteGradleDist,
  isValidJdkDir
} from './toolchain-download.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const resourcesDir = path.join(__dirname, '..', '..', 'resources')
const jdkTargetDir = path.join(resourcesDir, 'jdk-21')
const gradleTargetDir = path.join(resourcesDir, GRADLE_RUNTIME_FOLDER)
const gradleLauncherJar = path.join(gradleTargetDir, 'lib', GRADLE_LAUNCHER_JAR)

async function setupJdk() {
  if (isValidJdkDir(jdkTargetDir)) {
    console.log('JDK 21 already complete at resources/jdk-21')
    return
  }
  await downloadAndExtractJdk(jdkTargetDir, resourcesDir, (msg) => console.log(msg))
  console.log(`JDK 21 ready at ${jdkTargetDir}`)
}

async function setupGradle() {
  if (isCompleteGradleDist(gradleTargetDir)) {
    console.log('Gradle distribution already complete at resources/gradle-9.5')
    return
  }
  await downloadAndExtractGradle(gradleTargetDir, resourcesDir, (msg) => console.log(msg))
  console.log(`Gradle ready at ${gradleTargetDir}`)
}

async function main() {
  mkdirSync(resourcesDir, { recursive: true })
  console.log('=== ModCrafting toolchain setup (full edition) ===\n')
  console.log('[1/2] JDK 21')
  await setupJdk()
  console.log('\n[2/2] Gradle 9.5')
  await setupGradle()
  console.log('\nDone. resources/jdk-21 and resources/gradle-9.5 are ready for Setup bundling.')
  console.log('Next: npm run prefetch:deps  (requires network, ~1 GB Fabric cache)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
