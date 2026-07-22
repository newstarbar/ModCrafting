/**
 * Quick verification of toolchain module and bundled JDK.
 * Run: node scripts/verify-toolchain.mjs
 */
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { validateSeedIntegrity } from './gradle-seed-utils.mjs'
import { gunzipSync } from 'zlib'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(scriptDir, '..')
const jdkJava = path.join(root, 'resources', 'jdk-21', 'bin', 'java.exe')
const gradleLauncher = path.join(root, 'resources', 'gradle-9.5', 'lib', 'gradle-launcher-9.5.0.jar')
const wrapperJar = path.join(root, 'resources', 'gradle-wrapper.jar')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const seedMarker = path.join(seedDir, '.modcrafting-seed.json')
const fabricVersions = path.join(root, 'resources', 'fabric-versions.json')
const fabricSymbolIndex = path.join(root, 'resources', 'fabric-symbol-index-1.21.4.json.gz')

let ok = true

function check(label, pass, hint) {
  console.log(`${pass ? 'OK' : 'FAIL'}  ${label}${hint ? ` — ${hint}` : ''}`)
  if (!pass) ok = false
}

check('JDK 21 bundled', existsSync(jdkJava), 'run: npm run setup:toolchain')
check('gradle-wrapper.jar', existsSync(wrapperJar), wrapperJar)
check('Gradle lib/ complete', existsSync(gradleLauncher), 'run: npm run setup:toolchain')
check('fabric-versions.json', existsSync(fabricVersions), fabricVersions)
let symbolIndexOk = false
let symbolIndexHint = 'run: npm run generate:fabric-index'
try {
  const index = JSON.parse(gunzipSync(readFileSync(fabricSymbolIndex)).toString('utf8'))
  const versions = JSON.parse(readFileSync(fabricVersions, 'utf8'))
  symbolIndexOk = index.minecraftVersion === versions.minecraft_version &&
    index.yarnMappings === versions.yarn_mappings && Array.isArray(index.classes) && index.classes.length > 1000
  symbolIndexHint = symbolIndexOk ? `${index.classes.length} Yarn classes` : 'version/content mismatch'
} catch { /* reported below */ }
check('Fabric 1.21.4 symbol index', symbolIndexOk, symbolIndexHint)

let seedOk = false
let seedHint = 'run: npm run prefetch:deps'
if (existsSync(seedMarker)) {
  try {
    const marker = JSON.parse(readFileSync(seedMarker, 'utf-8'))
    const versions = JSON.parse(readFileSync(fabricVersions, 'utf-8'))
    const versionMatch = Object.keys(versions).every((k) => marker[k] === versions[k])
    const integrity = validateSeedIntegrity(seedDir, versions)
    seedOk = versionMatch && marker.verifiedOffline === true && integrity.ok
    if (seedOk) {
      seedHint = `${marker.fileCount} files, ${(marker.totalBytes / 1024 / 1024).toFixed(0)} MB, offline verified`
    } else if (!versionMatch) {
      seedHint = 'invalid seed marker versions'
    } else if (!marker.verifiedOffline) {
      seedHint = 'seed not offline-verified; run: npm run prefetch:deps -- --force'
    } else {
      seedHint = integrity.errors[0] || 'invalid seed'
    }
  } catch (err) {
    seedHint = String(err)
  }
}
check('gradle-home-seed (offline deps)', seedOk, seedHint)

process.exit(ok ? 0 : 1)
