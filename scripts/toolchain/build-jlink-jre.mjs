#!/usr/bin/env node
/**
 * Build a minimal JRE via jlink for NSIS packaging.
 *
 * Source: resources/jdk-21 (full JDK)
 * Output: resources/jre-21-minimal (custom JRE, ~60MB)
 *
 * The module list is tuned for Fabric 1.21.4 + Loom 1.17 + Gradle 9.5 builds.
 * If a build fails with `java.lang.module.FindException: Module ... not found`,
 * add the missing module to REQUIRED_MODULES and re-run.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const jdkSource = process.env.JDK_HOME || path.join(root, 'resources', 'jdk-21')
const outputDir = path.join(root, 'resources', 'jre-21-minimal')
const force = process.argv.includes('--force')

// Fabric build required JDK modules (validated against Gradle 9.5 + Loom 1.17 + Java 21)
const REQUIRED_MODULES = [
  'java.base',
  'java.compiler',
  'java.datatransfer',
  'java.desktop',
  'java.instrument',
  'java.logging',
  'java.management',
  'java.naming',
  'java.net.http',
  'java.prefs',
  'java.scripting',
  'java.se',
  'java.security.jgss',
  'java.security.sasl',
  'java.sql',
  'java.sql.rowset',
  'java.transaction.xa',
  'java.xml',
  'java.xml.crypto',
  'jdk.crypto.cryptoki',
  'jdk.crypto.ec',
  'jdk.jfr',
  'jdk.jshell',
  'jdk.management',
  'jdk.net',
  'jdk.nio.mapmode',
  'jdk.unsupported',
  'jdk.zipfs'
]

function dirSizeMb(p) {
  let total = 0
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  if (existsSync(p)) walk(p)
  return (total / 1024 / 1024).toFixed(0)
}

function main() {
  if (!existsSync(jdkSource)) {
    throw new Error(`Missing JDK source: ${jdkSource}. Run: npm run toolchain:setup`)
  }
  const jlinkBin = process.platform === 'win32' ? 'jlink.exe' : 'jlink'
  const jlink = path.join(jdkSource, 'bin', jlinkBin)
  if (!existsSync(jlink)) {
    throw new Error(`jlink not found in JDK: ${jlink}. Need a full JDK, not a JRE.`)
  }

  const jmodsDir = path.join(jdkSource, 'jmods')
  if (!existsSync(jmodsDir)) {
    throw new Error(`jmods directory not found: ${jmodsDir}. Need a full JDK, not a JRE.`)
  }

  // Skip if up-to-date (unless --force)
  if (!force && existsSync(outputDir) && existsSync(path.join(outputDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    console.log(`[jlink] JRE already exists: ${outputDir} (${dirSizeMb(outputDir)} MB). Use --force to rebuild.`)
    return
  }

  if (existsSync(outputDir)) {
    console.log(`[jlink] Removing existing output: ${outputDir}`)
    rmSync(outputDir, { recursive: true, force: true })
  }

  console.log(`[jlink] Building minimal JRE from ${jdkSource}`)
  console.log(`[jlink] Modules (${REQUIRED_MODULES.length}): ${REQUIRED_MODULES.join(', ')}`)

  const args = [
    '--module-path', jmodsDir,
    '--add-modules', REQUIRED_MODULES.join(','),
    '--output', outputDir,
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=2'
  ]

  const result = spawnSync(jlink, args, { stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    throw new Error(`jlink failed with exit code ${result.status ?? 'unknown'}`)
  }

  // Verify java.exe works
  const javaBin = path.join(outputDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  if (!existsSync(javaBin)) {
    throw new Error(`jlink output missing java binary: ${javaBin}`)
  }

  const verify = spawnSync(javaBin, ['-version'], { stdio: 'pipe', shell: false })
  if (verify.status !== 0) {
    throw new Error(`jlink JRE verification failed: java -version exited ${verify.status}`)
  }

  console.log(`\n[jlink] JRE built successfully: ${outputDir}`)
  console.log(`[jlink] Size: ${dirSizeMb(outputDir)} MB`)
  console.log(`[jlink] Verify: ${(verify.stderr.toString() || verify.stdout.toString()).trim()}`)
}

try {
  main()
} catch (err) {
  console.error(`[jlink][fatal] ${err.message || err}`)
  process.exit(1)
}
