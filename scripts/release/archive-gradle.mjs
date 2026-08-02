#!/usr/bin/env node
/**
 * 打包 Gradle 发行版为 tar.xz 并按需分片，供 Gitee Releases 部署。
 *
 * Gitee 免费版单个 release 资产上限 100MB。Gradle 9.5 bin zip 约 120MB，
 * 超限，因此：
 *   1. 对 resources/gradle-9.5 执行 strip 精简（移除 docs/samples/src/media 等）
 *   2. 压缩为 gradle-9.5.tar.xz（通常精简后 <100MB，无需分片）
 *   3. 仍按 90MB 分片机制产出（单分片也走同一 manifest 管线，与 jre/seed 一致）
 *
 * Output:
 *   resources/gradle-shards/gradle.part.001
 *   resources/gradle-shards/gradle.part.002 (if needed)
 *   resources/gradle-shards/gradle-manifest.json
 *
 * Usage:
 *   npm run release:split-gradle
 *
 * 切分完成后，把 resources/gradle-shards/ 中的所有文件作为独立资产上传到
 * mod-crafting-env 仓库的 Release（与 jre/seed 分片同 tag）。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gradleDir = path.join(root, 'resources', 'gradle-9.5')
const archivePath = path.join(root, 'resources', 'gradle-9.5.tar.xz')
const shardsDir = path.join(root, 'resources', 'gradle-shards')
const manifestPath = path.join(shardsDir, 'gradle-manifest.json')
const SHARD_SIZE = 90 * 1024 * 1024 // 90MB (Gitee 上限 100MB,留余量)

const GRADLE_LAUNCHER_JAR = 'gradle-launcher-9.5.0.jar'

function isCompleteGradleDist(dir) {
  const launcher = path.join(dir, 'lib', GRADLE_LAUNCHER_JAR)
  const bin = path.join(dir, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
  return existsSync(bin) && existsSync(launcher)
}

function sha256(filePath) {
  const h = createHash('sha256')
  h.update(readFileSync(filePath))
  return h.digest('hex')
}

/** 用 Node.js 原生方式分割文件（跨平台，不依赖 Unix split 命令） */
function splitFileWithNode(srcPath, outDir, shardSize) {
  const totalSize = statSync(srcPath).size
  const shards = []

  const fd = openSync(srcPath, 'r')
  const buffer = Buffer.alloc(shardSize)

  try {
    let shardIndex = 1
    let bytesReadTotal = 0
    while (bytesReadTotal < totalSize) {
      const bytesToRead = Math.min(shardSize, totalSize - bytesReadTotal)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, bytesReadTotal)
      if (bytesRead === 0) break

      const shardName = `gradle.part.${String(shardIndex).padStart(3, '0')}`
      const shardPath = path.join(outDir, shardName)

      const outFd = openSync(shardPath, 'w')
      try {
        writeSync(outFd, buffer, 0, bytesRead)
      } finally {
        closeSync(outFd)
      }

      const size = statSync(shardPath).size
      const hash = sha256(shardPath)
      shards.push({ index: shardIndex, filename: shardName, sha256: hash, size })
      console.log(`[split-gradle]   ${shardName} (${(size / 1024 / 1024).toFixed(1)} MB)`)

      bytesReadTotal += bytesRead
      shardIndex++
    }
  } finally {
    closeSync(fd)
  }

  return shards
}

function main() {
  if (!existsSync(gradleDir) || !isCompleteGradleDist(gradleDir)) {
    throw new Error(
      `Missing Gradle dist: ${gradleDir}（缺少 ${GRADLE_LAUNCHER_JAR} / bin/gradle）。请先运行 npm run toolchain:setup。`
    )
  }

  console.log(`[split-gradle] Strip ${gradleDir}…`)
  execSync(`node ${path.join(root, 'scripts', 'toolchain', 'strip-gradle-dist.mjs')} "${gradleDir}"`, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  // 压缩为 tar.xz（与 jre/seed 解压管线一致，seed-downloader 用 tar -xJf）
  if (existsSync(archivePath)) rmSync(archivePath, { force: true })
  console.log('[split-gradle] Compressing gradle-9.5.tar.xz（可能耗时 1-2 分钟）…')
  execSync(`tar -cJf "${archivePath}" -C "${path.join(root, 'resources')}" gradle-9.5`, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  const totalSize = statSync(archivePath).size
  const totalSizeMb = (totalSize / 1024 / 1024).toFixed(1)
  const expectedShards = Math.ceil(totalSize / SHARD_SIZE)
  console.log(`[split-gradle] Archive: ${archivePath} (${totalSizeMb} MB), expected ${expectedShards} shard(s)`)

  if (existsSync(shardsDir)) {
    rmSync(shardsDir, { recursive: true, force: true })
  }
  mkdirSync(shardsDir, { recursive: true })

  const shards = splitFileWithNode(archivePath, shardsDir, SHARD_SIZE)
  if (shards.length === 0) {
    throw new Error('No shards generated — split failed')
  }

  const summedSize = shards.reduce((s, sh) => s + sh.size, 0)
  if (summedSize !== totalSize) {
    throw new Error(`Shard size mismatch: ${summedSize} != archive ${totalSize}`)
  }

  console.log('[split-gradle] Computing archive SHA256…')
  const totalSha256 = sha256(archivePath)

  const manifest = {
    version: 1,
    archiveName: 'gradle-9.5.tar.xz',
    shardCount: shards.length,
    shardSize: SHARD_SIZE,
    totalSize,
    totalSha256,
    shards,
    createdAt: new Date().toISOString()
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\n[split-gradle] Done. ${shards.length} shard(s) + gradle-manifest.json written to ${shardsDir}`)
  console.log(`[split-gradle] Upload all files in resources/gradle-shards/ to mod-crafting-env Release as separate assets.`)
}

try {
  main()
} catch (err) {
  console.error(`[split-gradle][fatal] ${err.message || err}`)
  process.exit(1)
}
