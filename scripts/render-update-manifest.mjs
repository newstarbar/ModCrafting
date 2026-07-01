#!/usr/bin/env node
/**
 * Render build/update-manifest.json for a release version.
 * Usage: node scripts/render-update-manifest.mjs 1.0.1 "Release notes"
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { giteeUrls, resolveGiteeRepo } from './gitee-config.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const manifestPath = path.join(root, 'build', 'update-manifest.json')

const rawVersion = process.argv[2]
const notesArg = process.argv[3]

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
const { owner, repo } = resolveGiteeRepo()
const gitee = giteeUrls(owner, repo, tag, ver)

const releaseBodyPath = path.join(root, 'build', 'release-body.md')
let notes = notesArg
if (!notes && existsSync(releaseBodyPath)) {
  const firstLine = readFileSync(releaseBodyPath, 'utf-8').split(/\r?\n/).find((l) => l.trim())
  notes = firstLine?.replace(/^#\s*/, '') || `ModCrafting ${tag}`
} else if (!notes) {
  notes = `ModCrafting ${tag}`
}

const manifest = {
  version: ver,
  releaseDate: new Date().toISOString().slice(0, 10),
  notes,
  feeds: {
    gitee: {
      manifest: gitee.manifest,
      setup: gitee.setup,
      portable: gitee.portable,
      releasesPage: gitee.releasesPage
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
