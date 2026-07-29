#!/usr/bin/env node
/**
 * Pack resources/jre-21-minimal into a tar.xz archive for Gitee Releases.
 *
 * Output: resources/jre-21-minimal.tar.xz
 *
 * xz compression typically shrinks the ~185MB jlink JRE to ~60-70MB.
 * The archive is consumed by:
 *   - split-jre-shards.mjs: split into ~90MB shards for Gitee Release upload
 *   - seed-downloader.ts: downloaded on first launch (NSIS 瘦包), extracted
 *     via `tar -xJf --strip-components=1` into runtime/jdk-21
 *
 * Windows 10+ ships bsdtar which supports xz decompression natively.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const jreDir = path.join(root, 'resources', 'jre-21-minimal')
const archivePath = path.join(root, 'resources', 'jre-21-minimal.tar.xz')
const stampPath = path.join(root, 'resources', '.jre-21-minimal.tar.xz.stamp')
const force = process.argv.includes('--force')

/**
 * 用 java 二进制 + release 文件作为 JRE 指纹,检测是否需要重新打包。
 * 比读取整个目录快得多,且足以识别 JRE 重建。
 */
function jreFingerprint() {
  const javaBin = path.join(jreDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  const releaseFile = path.join(jreDir, 'release')
  const h = createHash('sha256')
  if (existsSync(javaBin)) h.update(readFileSync(javaBin))
  if (existsSync(releaseFile)) h.update(readFileSync(releaseFile))
  return h.digest('hex')
}

function isUpToDate() {
  if (!existsSync(archivePath) || !existsSync(stampPath)) return false
  try {
    return readFileSync(stampPath, 'utf8').trim() === jreFingerprint()
  } catch {
    return false
  }
}

function main() {
  if (!existsSync(jreDir)) {
    throw new Error('Missing resources/jre-21-minimal — run: npm run toolchain:jlink (or build-jlink-jre.mjs)')
  }
  const javaBin = path.join(jreDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  if (!existsSync(javaBin)) {
    throw new Error(`resources/jre-21-minimal is incomplete: missing bin/java.exe. Re-run build-jlink-jre.mjs`)
  }

  if (!force && isUpToDate()) {
    const sizeMb = (statSync(archivePath).size / 1024 / 1024).toFixed(0)
    console.log(`[jre-archive] up to date: ${archivePath} (${sizeMb} MB)`)
    return
  }

  console.log('[jre-archive] packing jre-21-minimal.tar.xz (xz compression, this may take a minute)…')
  // 打包时保留顶层目录名 jre-21-minimal,解压时用 --strip-components=1 去掉
  const result = spawnSync(
    'tar',
    ['-acf', archivePath, '-C', path.join(root, 'resources'), 'jre-21-minimal'],
    { stdio: 'inherit', shell: false }
  )
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status ?? 'unknown'}`)
  }

  const sizeMb = (statSync(archivePath).size / 1024 / 1024).toFixed(0)
  writeFileSync(stampPath, jreFingerprint(), 'utf8')
  console.log(`[jre-archive] wrote ${archivePath} (${sizeMb} MB)`)
}

try {
  main()
} catch (err) {
  console.error(`[jre-archive][fatal] ${err.message || err}`)
  process.exit(1)
}
