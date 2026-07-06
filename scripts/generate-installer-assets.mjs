#!/usr/bin/env node
/**
 * Generate NSIS MUI bitmaps for ModCrafting installer (sidebar + header).
 */
import { existsSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'build')
const force = process.argv.includes('--force')

const targets = [
  { name: 'installerSidebar.bmp', width: 164, height: 314, kind: 'sidebar' },
  { name: 'installerHeader.bmp', width: 150, height: 57, kind: 'header' },
  { name: 'uninstallerSidebar.bmp', width: 164, height: 314, kind: 'sidebar' }
]

function isUpToDate(outName, sourcePath) {
  const outPath = path.join(buildDir, outName)
  if (!existsSync(outPath) || !existsSync(sourcePath)) return false
  return statSync(outPath).mtimeMs >= statSync(sourcePath).mtimeMs
}

function encodeBmp24(width, height, rgba) {
  const rowStride = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowStride * height
  const fileSize = 54 + pixelBytes
  const out = Buffer.alloc(fileSize)

  out.write('BM')
  out.writeUInt32LE(fileSize, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(pixelBytes, 34)

  let offset = 54
  for (let y = height - 1; y >= 0; y--) {
    let col = 0
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      out[offset++] = rgba[i]
      out[offset++] = rgba[i + 1]
      out[offset++] = rgba[i + 2]
      col += 3
    }
    while (col % 4 !== 0) {
      out[offset++] = 0
      col++
    }
  }

  return out
}

async function renderAsset(sharp, sourcePng, spec) {
  const outPath = path.join(buildDir, spec.name)
  const bg = { r: 0x1a, g: 0x1d, b: 0x21 }
  const accent = { r: 0x4c, g: 0xaf, b: 0x50 }

  const logoSize = spec.kind === 'header' ? 36 : 96
  const logo = await sharp(sourcePng)
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  const titleSvg = spec.kind === 'sidebar'
    ? Buffer.from(`<svg width="${spec.width}" height="40" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="28" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="600" fill="#F5F5F7">ModCrafting</text>
      </svg>`)
    : null

  const composites = [
    {
      input: await sharp({
        create: { width: spec.width, height: 4, channels: 3, background: accent }
      }).png().toBuffer(),
      top: 0,
      left: 0
    },
    {
      input: logo,
      top: spec.kind === 'header' ? Math.floor((spec.height - logoSize) / 2) : 72,
      left: Math.floor((spec.width - logoSize) / 2)
    }
  ]

  if (titleSvg) {
    composites.push({
      input: titleSvg,
      top: spec.height - 120,
      left: 0
    })
  }

  const { data, info } = await sharp({
    create: {
      width: spec.width,
      height: spec.height,
      channels: 4,
      background: { ...bg, alpha: 1 }
    }
  })
    .composite(composites)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  writeFileSync(outPath, encodeBmp24(info.width, info.height, data))
  console.log(`[installer-assets] wrote ${spec.name}`)
}

async function main() {
  const sourcePng = path.join(buildDir, 'appIcon.png')
  if (!existsSync(sourcePng)) {
    throw new Error(`Missing ${sourcePng} — run generate-icon first`)
  }

  const needsWork = force || targets.some((t) => !isUpToDate(t.name, sourcePng))
  if (!needsWork) {
    console.log('[installer-assets] up to date')
    return
  }

  const sharp = (await import('sharp')).default
  for (const spec of targets) {
    await renderAsset(sharp, sourcePng, spec)
  }
}

main().catch((err) => {
  console.error('[installer-assets] failed:', err.message)
  process.exit(1)
})
