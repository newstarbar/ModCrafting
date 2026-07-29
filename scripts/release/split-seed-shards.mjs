#!/usr/bin/env node
/**
 * Split gradle-home-seed.tar.xz into ~90MB shards for Gitee Releases.
 *
 * Gitee free tier limits single release assets to 100MB. This script splits
 * the archive into shards and emits a manifest the app uses to download &
 * reassemble them.
 *
 * Output:
 *   resources/seed-shards/seed.part.001
 *   resources/seed-shards/seed.part.002
 *   ...
 *   resources/seed-shards/manifest.json
 *
 * Usage:
 *   node scripts/release/split-seed-shards.mjs
 *
 * After splitting, upload all files in resources/seed-shards/ to a Gitee
 * Release as separate assets.
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const archivePath = path.join(root, 'resources', 'gradle-home-seed.tar.xz')
const shardsDir = path.join(root, 'resources', 'seed-shards')
const manifestPath = path.join(shardsDir, 'manifest.json')
const SHARD_SIZE = 90 * 1024 * 1024  // 90MB (Gitee limit is 100MB, leave headroom)

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
 * 用 Node.js 原生方式分割文件（跨平台，不依赖 Unix split 命令）
 * 生成 seed.part.001, seed.part.002, ... 格式的分片
 */
function splitFileWithNode(srcPath, shardsDir, shardSize) {
  const totalSize = statSync(srcPath).size
  const expectedShards = Math.ceil(totalSize / shardSize)
  const shards = []

  // 使用流式读取避免大文件内存问题
  const fd = openSync(srcPath, 'r')
  const buffer = Buffer.alloc(shardSize)

  try {
    let shardIndex = 1
    let bytesReadTotal = 0
    while (bytesReadTotal < totalSize) {
      const bytesToRead = Math.min(shardSize, totalSize - bytesReadTotal)
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, bytesReadTotal)
      if (bytesRead === 0) break

      const shardName = `seed.part.${String(shardIndex).padStart(3, '0')}`
      const shardPath = path.join(shardsDir, shardName)

      // 写入分片文件
      const outFd = openSync(shardPath, 'w')
      try {
        writeSync(outFd, buffer, 0, bytesRead)
      } finally {
        closeSync(outFd)
      }

      const size = statSync(shardPath).size
      const hash = sha256(shardPath)
      shards.push({ index: shardIndex, filename: shardName, sha256: hash, size })
      console.log(`[split-seed]   ${shardName} (${(size / 1024 / 1024).toFixed(1)} MB)`)

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
    throw new Error(`Missing archive: ${archivePath}. Run: npm run toolchain:archive-seed (or archive-gradle-home-seed.mjs)`)
  }

  const totalSize = statSync(archivePath).size
  const totalSizeMb = (totalSize / 1024 / 1024).toFixed(1)
  const expectedShards = Math.ceil(totalSize / SHARD_SIZE)
  console.log(`[split-seed] Source: ${archivePath} (${totalSizeMb} MB)`)
  console.log(`[split-seed] Shard size: ${SHARD_SIZE / 1024 / 1024} MB, expected ${expectedShards} shards`)

  // Reset shards dir
  if (existsSync(shardsDir)) {
    rmSync(shardsDir, { recursive: true, force: true })
  }
  mkdirSync(shardsDir, { recursive: true })

  // 使用 Node.js 原生方式分割（跨平台，不依赖 Unix split 命令）
  console.log(`[split-seed] Splitting with Node.js native fs...`)
  const shards = splitFileWithNode(archivePath, shardsDir, SHARD_SIZE)

  if (shards.length === 0) {
    throw new Error('No shards generated — split failed')
  }

  // Verify total size matches
  const summedSize = shards.reduce((s, sh) => s + sh.size, 0)
  if (summedSize !== totalSize) {
    throw new Error(`Shard size mismatch: ${summedSize} != archive ${totalSize}`)
  }

  // Compute archive SHA256
  console.log('[split-seed] Computing archive SHA256…')
  const totalSha256 = sha256(archivePath)

  const manifest = {
    version: 1,
    archiveName: 'gradle-home-seed.tar.xz',
    shardCount: shards.length,
    shardSize: SHARD_SIZE,
    totalSize,
    totalSha256,
    shards,
    fabricVersions: loadFabricVersions(),
    createdAt: new Date().toISOString()
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\n[split-seed] Done. ${shards.length} shards + manifest.json written to ${shardsDir}`)
  console.log(`[split-seed] Upload all files in resources/seed-shards/ to a Gitee Release as separate assets.`)
}

try {
  main()
} catch (err) {
  console.error(`[split-seed][fatal] ${err.message || err}`)
  process.exit(1)
}
