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

const rawVersion = process.argv[2]
const notes = process.argv[3] || `ModCrafting ${rawVersion}`

if (!rawVersion) {
  console.error('Usage: node scripts/render-update-manifest.mjs <version> [notes]')
  process.exit(1)
}

const ver = rawVersion.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+/.test(ver)) {
  console.error('Usage: node scripts/render-update-manifest.mjs <version> [notes]')
  console.error(`Invalid version: ${rawVersion}`)
  process.exit(1)
}

const tag = rawVersion.startsWith('v') ? rawVersion : `v${ver}`

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
