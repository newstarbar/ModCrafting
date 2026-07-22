#!/usr/bin/env node
/**
 * Prepare NSISBI for electron-builder when the app package exceeds NSIS 2 GB mmap limit.
 * Downloads once (via ghfast mirror), verifies sha512, and extracts to packaging/nsisbi/.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const root = process.cwd()
const archivePath = join(root, 'packaging', 'nsisbi-electronbuilder-3.10.3.7z')
const extractDir = join(root, 'packaging', 'nsisbi')
const makensisPath = join(extractDir, 'Bin', 'makensis.exe')
const CHECKSUM =
  'WRmZUsACjIc2s7bvsFGFRofK31hfS7riPlcfI1V9uFB2Q8s7tidgI/9U16+X0I9X2ZhNxi8N7Z3gKvm6ojvLvg=='
const URL =
  'https://ghfast.top/https://github.com/SoundSafari/NSISBI-ElectronBuilder/releases/download/1.0.0/nsisbi-electronbuilder-3.10.3.7z'

function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

async function download(url, dest) {
  mkdirSync(join(root, 'packaging'), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`NSISBI download failed: ${res.status} ${res.statusText}`)
  }
  await pipeline(res.body, createWriteStream(dest))
}

function extract(archive, dest) {
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dest, { recursive: true })
  const result = spawnSync('tar', ['-xf', archive, '-C', dest], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error('Failed to extract NSISBI archive (tar -xf)')
  }
}

async function main() {
  if (existsSync(makensisPath)) {
    console.log('[nsisbi] already ready:', extractDir)
    return
  }

  if (!existsSync(archivePath)) {
    console.log('[nsisbi] downloading NSISBI…')
    await download(URL, archivePath)
  } else {
    console.log('[nsisbi] archive up to date')
  }

  const digest = sha512Base64(archivePath)
  if (digest !== CHECKSUM) {
    rmSync(archivePath, { force: true })
    throw new Error('NSISBI archive checksum mismatch — deleted corrupt file, retry')
  }

  console.log('[nsisbi] extracting to packaging/nsisbi…')
  extract(archivePath, extractDir)

  if (!existsSync(makensisPath)) {
    throw new Error('NSISBI extract incomplete: Bin/makensis.exe missing')
  }
  console.log('[nsisbi] ready')
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
