#!/usr/bin/env node
/**
 * Render build/update-manifest.json for a release version.
 * Usage: node scripts/render-update-manifest.mjs 1.0.1 "Release notes"
 */
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const manifestPath = path.join(root, 'build', 'update-manifest.json')

const version = process.argv[2]
const notes = process.argv[3] || `ModCrafting ${version}`

if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('Usage: node scripts/render-update-manifest.mjs <version> [notes]')
  process.exit(1)
}

const tag = version.startsWith('v') ? version : `v${version}`
const ver = version.replace(/^v/, '')

const manifest = {
  version: ver,
  releaseDate: new Date().toISOString().slice(0, 10),
  notes,
  feeds: {
    gitee: {
      manifest: `https://gitee.com/newstarbar/ModCrafting/releases/download/${tag}/latest.yml`,
      setup: `https://gitee.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting%20Setup%20${ver}.exe`,
      portable: `https://gitee.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting%20${ver}%20Portable.exe`,
      releasesPage: 'https://gitee.com/newstarbar/ModCrafting/releases'
    },
    github: {
      manifest: `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/latest.yml`,
      setup: `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting%20Setup%20${ver}.exe`,
      portable: `https://github.com/newstarbar/ModCrafting/releases/download/${tag}/ModCrafting%20${ver}%20Portable.exe`,
      releasesPage: 'https://github.com/newstarbar/ModCrafting/releases'
    }
  },
  channels: { latest: ver }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
console.log(`Wrote ${manifestPath} for v${ver}`)
