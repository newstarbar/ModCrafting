/**
 * Quick verification of toolchain module and bundled JDK.
 * Run: node scripts/verify-toolchain.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { validateSeedIntegrity } from './gradle-seed-utils.mjs'
import { gunzipSync } from 'zlib'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(scriptDir, '..', '..')
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

// ── Minecraft 知识库资源检查（可选增强，缺失时 agent 会返回服务不可用提示）──
let mcVersion = '1.21.4'
try {
  const versions = JSON.parse(readFileSync(fabricVersions, 'utf-8'))
  if (versions.minecraft_version) mcVersion = versions.minecraft_version
} catch { /* use default */ }

const mcDataIndex = path.join(root, 'resources', 'minecraft-data', mcVersion, 'index.json')
let mcDataOk = false
let mcDataHint = 'run: npm run knowledge:build-data-index'
try {
  if (existsSync(mcDataIndex)) {
    const idx = JSON.parse(readFileSync(mcDataIndex, 'utf-8'))
    mcDataOk = idx.version === mcVersion &&
      typeof idx.counts === 'object' && idx.counts !== null &&
      (idx.counts.blocks || 0) > 0
    mcDataHint = mcDataOk
      ? `blocks=${idx.counts.blocks}, items=${idx.counts.items}, entities=${idx.counts.entities}`
      : 'index.json version/counts mismatch'
  }
} catch (err) {
  mcDataHint = String(err)
}
check(`minecraft-data index (${mcVersion})`, mcDataOk, mcDataHint)

const wikiManifest = path.join(root, 'resources', 'mc-wiki-zh-index', 'manifest.json')
let wikiOk = false
let wikiHint = 'run: npm run knowledge:build-wiki-embeddings'
try {
  if (existsSync(wikiManifest)) {
    const manifest = JSON.parse(readFileSync(wikiManifest, 'utf-8'))
    wikiOk = manifest.chunkCount > 0 && manifest.dimension === 384
    wikiHint = wikiOk
      ? `${manifest.chunkCount} chunks × ${manifest.dimension}d (model: ${manifest.model})`
      : 'manifest invalid'
  }
} catch (err) {
  wikiHint = String(err)
}
check('mc-wiki-zh vector index', wikiOk, wikiHint)

const wikiModelDir = path.join(root, 'resources', 'mc-wiki-model')
let modelOk = false
let modelHint = 'run: npm run knowledge:cache-model'
try {
  if (existsSync(wikiModelDir)) {
    // 模型目录应包含 onnx 权重文件
    const entries = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) walk(full)
        else if (name.endsWith('.onnx') || name.endsWith('.json')) entries.push(name)
      }
    }
    walk(wikiModelDir)
    modelOk = entries.some((n) => n.endsWith('.onnx'))
    modelHint = modelOk ? `${entries.length} files` : 'missing .onnx file'
  }
} catch (err) {
  modelHint = String(err)
}
check('mc-wiki transformers model', modelOk, modelHint)

process.exit(ok ? 0 : 1)
