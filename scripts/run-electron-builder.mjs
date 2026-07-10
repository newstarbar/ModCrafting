#!/usr/bin/env node
/**
 * Run electron-builder using local Electron (node_modules) to avoid GitHub CDN timeouts.
 * Falls back to npmmirror for any binary downloads (NSIS, etc.).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const electronDist = join(root, 'node_modules', 'electron', 'dist')
const unpackedDir = join(root, 'release', 'win-unpacked')
const nsisbiDir = join(root, 'build', 'nsisbi')
const NSISBI_CHECKSUM =
  'WRmZUsACjIc2s7bvsFGFRofK31hfS7riPlcfI1V9uFB2Q8s7tidgI/9U16+X0I9X2ZhNxi8N7Z3gKvm6ojvLvg=='
const NSISBI_MIRROR =
  'https://ghfast.top/https://github.com/SoundSafari/NSISBI-ElectronBuilder/releases/download/1.0.0/nsisbi-electronbuilder-3.10.3.7z'

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const args = process.argv.slice(2)

if (!existsSync(electronDist)) {
  console.error('[build] node_modules/electron/dist not found. Run: npm install')
  process.exit(1)
}

if (!args.includes('--dir') && !args.includes('--prepackaged') && existsSync(unpackedDir)) {
  try {
    console.log('[build] cleaning release/win-unpacked')
    rmSync(unpackedDir, { recursive: true, force: true })
  } catch {
    console.warn('[build] release/win-unpacked is locked — close ModCrafting.exe and delete release/ manually, then retry')
  }
}

const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')

const isNsisBuild = args.some((arg) => arg === 'nsis' || arg.includes('nsis'))
if (isNsisBuild) {
  if (existsSync(join(nsisbiDir, 'Bin', 'makensis.exe'))) {
    process.env.ELECTRON_BUILDER_NSIS_DIR = nsisbiDir
    console.log('[build] NSISBI: build/nsisbi (ELECTRON_BUILDER_NSIS_DIR)')
  } else {
    args.push(`--config.nsis.customNsisBinary.url=${NSISBI_MIRROR}`)
    args.push(`--config.nsis.customNsisBinary.checksum=${NSISBI_CHECKSUM}`)
    console.log('[build] NSISBI: ghfast mirror download (run: node scripts/setup-nsisbi.mjs)')
  }
}

console.log('[build] using local Electron from node_modules/electron/dist')

const result = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env })
process.exit(result.status ?? 1)
