#!/usr/bin/env node
/**
 * Generate NSIS-compatible .ico files from build PNG sources:
 *   appIcon.png       → appIcon.ico       (exe / window)
 *   installerIcon.png → installerIcon.ico (NSIS installer UI)
 */
import { writeFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')

const targets = [
  { png: 'appIcon.png', ico: 'appIcon.ico' },
  { png: 'installerIcon.png', ico: 'installerIcon.ico' }
]

const sizes = [16, 32, 48, 64, 128, 256]

async function pngToIcoFile(pngName, icoName) {
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

for (const { png, ico } of targets) {
  await pngToIcoFile(png, ico)
}
