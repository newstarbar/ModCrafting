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
const nsisbiDir = join(root, 'packaging', 'nsisbi')

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
  const makensisPath = join(nsisbiDir, 'Bin', 'makensis.exe')
  if (!existsSync(makensisPath)) {
    console.log('[build] NSISBI missing; preparing local toolset')
    const setupScript = join(root, 'scripts', 'packaging', 'setup-nsisbi.mjs')
    const setup = spawnSync(process.execPath, [setupScript], { stdio: 'inherit', env: process.env })
    if (setup.status !== 0 || !existsSync(makensisPath)) {
      console.error('[build] NSISBI setup failed')
      process.exit(setup.status ?? 1)
    }
  }
  process.env.ELECTRON_BUILDER_NSIS_DIR = nsisbiDir
  console.log('[build] NSISBI: packaging/nsisbi (ELECTRON_BUILDER_NSIS_DIR)')
}

console.log('[build] using local Electron from node_modules/electron/dist')

const result = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env })
process.exit(result.status ?? 1)
