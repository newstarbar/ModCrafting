#!/usr/bin/env node
/**
 * Generate NSIS-compatible .ico files from build PNG sources:
 *   appIcon.png       → appIcon.ico       (exe / window)
 *   installerIcon.png → installerIcon.ico (NSIS installer UI)
 *
 * Skips when .ico is newer than .png (use --force to regenerate).
 */
import { writeFileSync, existsSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const force = process.argv.includes('--force')

const targets = [
  { png: 'appIcon.png', ico: 'appIcon.ico' },
  { png: 'installerIcon.png', ico: 'installerIcon.ico' }
]

const sizes = [16, 32, 48, 64, 128, 256]

function isIcoUpToDate(pngName, icoName) {
  const pngPath = path.join(buildDir, pngName)
  const icoPath = path.join(buildDir, icoName)
  if (!existsSync(pngPath) || !existsSync(icoPath)) return false
  return statSync(icoPath).mtimeMs >= statSync(pngPath).mtimeMs
}

async function loadGenerators() {
  const sharp = (await import('sharp')).default
  const pngToIco = (await import('png-to-ico')).default
  return { sharp, pngToIco }
}

async function pngToIcoFile({ sharp, pngToIco }, pngName, icoName) {
  const pngPath = path.join(buildDir, pngName)
  const icoPath = path.join(buildDir, icoName)

  if (!existsSync(pngPath)) {
    throw new Error(`Missing ${pngPath}`)
  }

  const pngBuffers = await Promise.all(
    sizes.map((size) =>
      sharp(pngPath)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  )

  const ico = await pngToIco(pngBuffers)
  writeFileSync(icoPath, ico)
  console.log(`Wrote ${icoPath} (${ico.length} bytes) from ${pngName}`)
}

const pending = force ? targets : targets.filter(({ png, ico }) => !isIcoUpToDate(png, ico))

for (const { png, ico } of targets) {
  if (!force && isIcoUpToDate(png, ico)) {
    console.log(`Skip ${ico} (up to date)`)
  }
}

if (pending.length === 0) {
  process.exit(0)
}

let generators
try {
  generators = await loadGenerators()
} catch (err) {
  const missing = pending.map(({ ico }) => path.join(buildDir, ico))
  const allExist = missing.every((p) => existsSync(p))
  if (allExist) {
    console.warn('[icon] sharp/png-to-ico unavailable — using existing .ico files')
    console.warn('[icon] Run `npm install` then `npm run generate:icon -- --force` after changing PNGs')
    process.exit(0)
  }
  throw new Error(
    `Cannot generate icons (${err.message}). Run npm install, or commit build/*.ico files.`
  )
}

for (const { png, ico } of pending) {
  await pngToIcoFile(generators, png, ico)
}
