#!/usr/bin/env node
/**
 * Ensure packages with blocked install scripts are usable.
 * Runs after npm install when Electron binary or esbuild binary is missing.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()

function runNodeScript(relPath) {
  const abs = join(root, relPath)
  if (!existsSync(abs)) return false
  const result = spawnSync(process.execPath, [abs], { stdio: 'inherit', cwd: root })
  return result.status === 0
}

const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electronExe)) {
  console.log('[postinstall] Electron binary missing — running install.js')
  if (!runNodeScript('node_modules/electron/install.js')) {
    console.warn('[postinstall] Electron install failed. Close running Electron apps and run: node node_modules/electron/install.js')
  }
}

const esbuildExe = join(root, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
if (!existsSync(esbuildExe)) {
  const esbuildInstall = join(root, 'node_modules', 'esbuild', 'install.js')
  if (existsSync(esbuildInstall)) {
    console.log('[postinstall] esbuild binary missing — running install.js')
    runNodeScript('node_modules/esbuild/install.js')
  }
}
