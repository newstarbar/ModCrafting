#!/usr/bin/env node
/**
 * Pack gradle-home-seed into a single zip for NSIS installer.
 * NSIS 7z extraction can drop nested jar files when unpacking thousands of Gradle cache paths.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateSeedIntegrity } from './gradle-seed-utils.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const archivePath = path.join(root, 'resources', 'gradle-home-seed.zip')
const stampPath = path.join(root, 'resources', '.gradle-home-seed.zip.stamp')
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

  console.log('[seed-archive] packing gradle-home-seed.zip (this may take a few minutes)…')
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
