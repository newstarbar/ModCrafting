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

process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const args = process.argv.slice(2)

if (!existsSync(electronDist)) {
  console.error('[build] node_modules/electron/dist not found. Run: npm install')
  process.exit(1)
}

if (!args.includes('--dir') && existsSync(unpackedDir)) {
  try {
    console.log('[build] cleaning release/win-unpacked')
    rmSync(unpackedDir, { recursive: true, force: true })
  } catch {
    console.warn('[build] release/win-unpacked is locked — close ModCrafting.exe and delete release/ manually, then retry')
  }
}

const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
console.log('[build] using local Electron from node_modules/electron/dist')

const result = spawnSync(bin, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env })
process.exit(result.status ?? 1)
