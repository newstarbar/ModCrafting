#!/usr/bin/env node
/**
 * Split jre-21-minimal.tar.xz into ~90MB shards for Gitee Releases.
 *
 * Gitee 免费版单个 release 资产上限 100MB。JRE 压缩包约 60-70MB,
 * 通常只有 1 个分片;但保留分片机制以便未来 JRE 体积变化时无需改动下载逻辑。
 *
 * Output:
 *   resources/jre-shards/jre.part.001
 *   resources/jre-shards/jre.part.002 (if needed)
 *   resources/jre-shards/jre-manifest.json
 *
 * Usage:
 *   node scripts/release/split-jre-shards.mjs
 *
 * 切分完成后,把 resources/jre-shards/ 中的所有文件作为独立资产上传到
 * 与 seed 分片相同的 Gitee Release(或单独 Release)。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const archivePath = path.join(root, 'resources', 'jre-21-minimal.tar.xz')
const shardsDir = path.join(root, 'resources', 'jre-shards')
const manifestPath = path.join(shardsDir, 'jre-manifest.json')
const SHARD_SIZE = 90 * 1024 * 1024  // 90MB (Gitee 上限 100MB,留余量)

function sha256(filePath) {
  const h = createHash('sha256')
  h.update(readFileSync(filePath))
  return h.digest('hex')
}

function loadFabricVersions() {
  const versionsPath = path.join(root, 'resources', 'fabric-versions.json')
  if (!existsSync(versionsPath)) return {}
  return JSON.parse(readFileSync(versionsPath, 'utf-8'))
}

/**
 * 用 Node.js 原生方式分割文件(跨平台,不依赖 Unix split 命令)
 * 生成 jre.part.001, jre.part.002, ... 格式的分片
 */
function splitFileWithNode(srcPath, shardsDir, shardSize) {
  const totalSize = statSync(srcPath).size
  const expectedShards = Math.ceil(totalSize / shardSize)
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

      const shardName = `jre.part.${String(shardIndex).padStart(3, '0')}`
      const shardPath = path.join(shardsDir, shardName)

      const outFd = openSync(shardPath, 'w')
      try {
        writeSync(outFd, buffer, 0, bytesRead)
      } finally {
        closeSync(outFd)
      }

      const size = statSync(shardPath).size
      const hash = sha256(shardPath)
      shards.push({ index: shardIndex, filename: shardName, sha256: hash, size })
      console.log(`[split-jre]   ${shardName} (${(size / 1024 / 1024).toFixed(1)} MB)`)

      bytesReadTotal += bytesRead
      shardIndex++
    }
  } finally {
    closeSync(fd)
  }

  return shards
}

function main() {
  if (!existsSync(archivePath)) {
    throw new Error(`Missing archive: ${archivePath}. Run: npm run toolchain:archive-jre (or archive-jre-minimal.mjs)`)
  }

  const totalSize = statSync(archivePath).size
  const totalSizeMb = (totalSize / 1024 / 1024).toFixed(1)
  const expectedShards = Math.ceil(totalSize / SHARD_SIZE)
  console.log(`[split-jre] Source: ${archivePath} (${totalSizeMb} MB)`)
  console.log(`[split-jre] Shard size: ${SHARD_SIZE / 1024 / 1024} MB, expected ${expectedShards} shard(s)`)

  if (existsSync(shardsDir)) {
    rmSync(shardsDir, { recursive: true, force: true })
  }
  mkdirSync(shardsDir, { recursive: true })

  console.log(`[split-jre] Splitting with Node.js native fs...`)
  const shards = splitFileWithNode(archivePath, shardsDir, SHARD_SIZE)

  if (shards.length === 0) {
    throw new Error('No shards generated — split failed')
  }

  const summedSize = shards.reduce((s, sh) => s + sh.size, 0)
  if (summedSize !== totalSize) {
    throw new Error(`Shard size mismatch: ${summedSize} != archive ${totalSize}`)
  }

  console.log('[split-jre] Computing archive SHA256…')
  const totalSha256 = sha256(archivePath)

  const manifest = {
    version: 1,
    archiveName: 'jre-21-minimal.tar.xz',
    shardCount: shards.length,
    shardSize: SHARD_SIZE,
    totalSize,
    totalSha256,
    shards,
    fabricVersions: loadFabricVersions(),
    createdAt: new Date().toISOString()
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\n[split-jre] Done. ${shards.length} shard(s) + jre-manifest.json written to ${shardsDir}`)
  console.log(`[split-jre] Upload all files in resources/jre-shards/ to a Gitee Release as separate assets.`)
}

try {
  main()
} catch (err) {
  console.error(`[split-jre][fatal] ${err.message || err}`)
  process.exit(1)
}
