#!/usr/bin/env node
/** Copy existing prefetch runtime gradle-home into gradle-home-seed (when online prefetch was interrupted). */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { FABRIC_VERSIONS } from './fabric-versions.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const gradleHome = path.join(root, 'resources', '_prefetch_runtime', 'gradle-home')
const seedDir = path.join(root, 'resources', 'gradle-home-seed')
const seedMarker = path.join(seedDir, '.modcrafting-seed.json')

function countDirStats(dir) {
  let fileCount = 0
  let totalBytes = 0
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        fileCount++
        try { totalBytes += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { fileCount, totalBytes }
}

if (!existsSync(gradleHome)) {
  console.error('No prefetch gradle-home at', gradleHome)
  process.exit(1)
}

const { fileCount, totalBytes } = countDirStats(gradleHome)
if (fileCount < 100 || totalBytes < 50_000_000) {
  console.error('gradle-home too small to finalize', { fileCount, totalBytes })
  process.exit(1)
}

if (existsSync(seedDir)) rmSync(seedDir, { recursive: true, force: true })
mkdirSync(path.dirname(seedDir), { recursive: true })
cpSync(gradleHome, seedDir, { recursive: true })

const marker = { ...FABRIC_VERSIONS, fileCount, totalBytes, createdAt: new Date().toISOString() }
writeFileSync(seedMarker, JSON.stringify(marker, null, 2), 'utf-8')
console.log('Finalized seed:', seedDir)
console.log(`Files: ${fileCount}, Size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
