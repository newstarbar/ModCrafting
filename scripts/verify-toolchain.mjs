/**
 * Quick verification of toolchain module and bundled JDK.
 * Run: node scripts/verify-toolchain.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(scriptDir, '..')
const jdkJava = path.join(root, 'resources', 'jdk-21', 'bin', 'java.exe')
const gradleLauncher = path.join(root, 'resources', 'gradle-9.5', 'lib', 'gradle-launcher-9.5.0.jar')
const wrapperJar = path.join(root, 'resources', 'gradle-wrapper.jar')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const seedMarker = path.join(seedDir, '.modcrafting-seed.json')
const fabricVersions = path.join(root, 'resources', 'fabric-versions.json')

let ok = true

function check(label, pass, hint) {
  console.log(`${pass ? 'OK' : 'FAIL'}  ${label}${hint ? ` — ${hint}` : ''}`)
  if (!pass) ok = false
}

function findLoomCacheHint() {
  const loomCache = path.join(seedDir, 'caches', 'fabric-loom')
  if (!existsSync(loomCache)) return 'missing caches/fabric-loom'
  try {
    const entries = readdirSync(loomCache, { recursive: true })
    const hasMc = entries.some((e) => String(e).includes('minecraft') || String(e).includes('1.21.4'))
    return hasMc ? '' : 'no minecraft artifacts in fabric-loom cache'
  } catch {
    return 'cannot read fabric-loom cache'
  }
}

check('JDK 21 bundled', existsSync(jdkJava), 'run: npm run setup:toolchain')
check('gradle-wrapper.jar', existsSync(wrapperJar), wrapperJar)
check('Gradle lib/ complete', existsSync(gradleLauncher), 'run: npm run setup:toolchain')
check('fabric-versions.json', existsSync(fabricVersions), fabricVersions)

let seedOk = false
let seedHint = 'run: npm run prefetch:deps'
if (existsSync(seedMarker)) {
  try {
    const marker = JSON.parse(readFileSync(seedMarker, 'utf-8'))
    const versions = JSON.parse(readFileSync(fabricVersions, 'utf-8'))
    const versionMatch = Object.keys(versions).every((k) => marker[k] === versions[k])
    seedOk = versionMatch && marker.fileCount > 100 && marker.totalBytes > 50_000_000
    seedHint = seedOk ? `${marker.fileCount} files, ${(marker.totalBytes / 1024 / 1024).toFixed(0)} MB` : 'invalid seed marker'
    if (seedOk) {
      const loomHint = findLoomCacheHint()
      if (loomHint) {
        seedOk = false
        seedHint = loomHint
      }
    }
  } catch (err) {
    seedHint = String(err)
  }
}
check('gradle-home-seed (offline deps)', seedOk, seedHint)

process.exit(ok ? 0 : 1)
