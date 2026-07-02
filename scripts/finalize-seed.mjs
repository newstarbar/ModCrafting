#!/usr/bin/env node
/** Copy existing prefetch runtime gradle-home into gradle-home-seed (when online prefetch was interrupted). */
import { cpSync, existsSync, mkdirSync, rmSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  countDirStats,
  sanitizeGradleHomeForSeed,
  validateSeedContent,
  writeSeedMarker,
  runOfflineBuildVerification
} from './gradle-seed-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const gradleHome = path.join(root, 'resources', '_prefetch_runtime', 'gradle-home')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const skipVerify = process.argv.includes('--skip-verify')

if (!existsSync(gradleHome)) {
  console.error('No prefetch gradle-home at', gradleHome)
  process.exit(1)
}

const { fileCount, totalBytes } = countDirStats(gradleHome)
if (fileCount < 100 || totalBytes < 50_000_000) {
  console.error('gradle-home too small to finalize', { fileCount, totalBytes })
  process.exit(1)
}

console.log('Sanitizing prefetch gradle-home...')
sanitizeGradleHomeForSeed(gradleHome)

if (existsSync(seedDir)) rmSync(seedDir, { recursive: true, force: true })
mkdirSync(path.dirname(seedDir), { recursive: true })
cpSync(gradleHome, seedDir, { recursive: true })
sanitizeGradleHomeForSeed(seedDir)

const integrity = validateSeedContent(seedDir)
if (!integrity.ok) {
  rmSync(seedDir, { recursive: true, force: true })
  console.error('Seed content check failed:\n-', integrity.errors.join('\n- '))
  process.exit(1)
}

if (!skipVerify) {
  console.log('Verifying offline build against finalized seed...')
  const verify = await runOfflineBuildVerification({ root, seedDir })
  if (!verify.ok) {
    rmSync(seedDir, { recursive: true, force: true })
    console.error(`Offline build verification failed (exit ${verify.exitCode})`)
    process.exit(1)
  }
}

const marker = writeSeedMarker(seedDir)
console.log('Finalized seed:', seedDir)
console.log(`Files: ${marker.fileCount}, Size: ${(marker.totalBytes / 1024 / 1024).toFixed(1)} MB`)
