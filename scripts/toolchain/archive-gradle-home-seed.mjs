#!/usr/bin/env node
/**
 * Pack gradle-home-seed into a tar.xz archive for distribution.
 *
 * Output: resources/gradle-home-seed.tar.xz
 *
 * xz compression saves 30-50% vs zip (1GB seed → ~500MB tar.xz).
 * The archive is consumed by:
 *   - NSIS installer: extracted on first launch (if bundled)
 *   - Gitee Releases: split into shards for download (see split-seed-shards.mjs)
 *   - Dev mode: extracted to runtime/gradle-home on demand
 *
 * Windows 10+ ships bsdtar which supports xz decompression natively.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateSeedIntegrity } from './gradle-seed-utils.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const archivePath = path.join(root, 'resources', 'gradle-home-seed.tar.xz')
const stampPath = path.join(root, 'resources', '.gradle-home-seed.tar.xz.stamp')
const force = process.argv.includes('--force')

function seedFingerprint() {
  const marker = path.join(seedDir, '.modcrafting-seed.json')
  if (!existsSync(marker)) return null
  const markerBody = readFileSync(marker)
  return createHash('sha256').update(markerBody).digest('hex')
}

function isUpToDate() {
  if (!existsSync(archivePath) || !existsSync(stampPath)) return false
  try {
    return readFileSync(stampPath, 'utf8').trim() === seedFingerprint()
  } catch {
    return false
  }
}

function main() {
  if (!existsSync(seedDir)) {
    throw new Error('Missing resources/gradle-home-seed — run: npm run prefetch:deps')
  }

  const integrity = validateSeedIntegrity(seedDir)
  if (!integrity.ok) {
    throw new Error(`gradle-home-seed invalid: ${integrity.errors.join('; ')}`)
  }

  const fingerprint = seedFingerprint()
  if (!force && isUpToDate()) {
    console.log('[seed-archive] up to date:', archivePath)
    return
  }

  console.log('[seed-archive] packing gradle-home-seed.tar.xz (this may take a few minutes)…')
  const result = spawnSync(
    'tar',
    ['-acf', archivePath, '-C', path.join(root, 'resources'), 'gradle-home-seed'],
    { stdio: 'inherit', shell: false }
  )
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status ?? 'unknown'}`)
  }

  const sizeMb = (statSync(archivePath).size / 1024 / 1024).toFixed(0)
  writeFileSync(stampPath, fingerprint, 'utf8')
  console.log(`[seed-archive] wrote ${archivePath} (${sizeMb} MB)`)
}

main()
