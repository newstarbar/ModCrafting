#!/usr/bin/env node
/**
 * Strip non-essential files from a Gradle distribution directory.
 *
 * Gradle ships docs/, samples/, src/, media/ and other files that are not
 * required at runtime. Removing them saves 30-50MB in the bundled package.
 *
 * Usage:
 *   node scripts/toolchain/strip-gradle-dist.mjs [path/to/gradle-9.5]
 *
 * Default target: resources/gradle-9.5
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gradleDir = process.argv[2] || path.join(root, 'resources', 'gradle-9.5')

// Directories and files safe to remove (Gradle runs with only bin/ + lib/ + init.d/)
const STRIPPABLE_ENTRIES = [
  'docs',
  'samples',
  'src',
  'media',
  'getting-started.html',
  'LICENSE',
  'NOTICE'
]

function entrySize(p) {
  try {
    const stat = statSync(p)
    if (stat.isFile()) return stat.size
    if (stat.isDirectory()) return dirSize(p)
  } catch { /* ignore */ }
  return 0
}

function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else {
        try { total += statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  if (existsSync(p)) walk(p)
  return total
}

function main() {
  if (!existsSync(gradleDir)) {
    console.warn(`[strip-gradle] Gradle dir not found: ${gradleDir}`)
    console.warn('[strip-gradle] Run `npm run toolchain:setup` first.')
    process.exit(0)
  }

  // Sanity check: ensure this is actually a Gradle directory
  const launcherJar = path.join(gradleDir, 'lib')
  if (!existsSync(launcherJar)) {
    console.error(`[strip-gradle] Not a Gradle distribution: ${gradleDir} (missing lib/). Aborting.`)
    process.exit(1)
  }

  const beforeMb = (dirSize(gradleDir) / 1024 / 1024).toFixed(1)
  console.log(`[strip-gradle] Target: ${gradleDir} (${beforeMb} MB)`)

  let savedBytes = 0
  for (const name of STRIPPABLE_ENTRIES) {
    const target = path.join(gradleDir, name)
    if (!existsSync(target)) continue
    try {
      const stat = statSync(target)
      const size = stat.isFile() ? stat.size : dirSize(target)
      const isDir = stat.isDirectory()
      rmSync(target, { recursive: isDir, force: true, maxRetries: 3, retryDelay: 200 })
      savedBytes += size
      console.log(`[strip-gradle]   removed ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    } catch (err) {
      console.warn(`[strip-gradle]   failed to remove ${name}: ${err.message || err}`)
    }
  }

  const afterMb = ((dirSize(gradleDir)) / 1024 / 1024).toFixed(1)
  const savedMb = (savedBytes / 1024 / 1024).toFixed(1)
  console.log(`[strip-gradle] Done. Saved ${savedMb} MB. Final size: ${afterMb} MB`)
}

main()
