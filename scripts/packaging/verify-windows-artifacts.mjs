#!/usr/bin/env node
/** Release gate: reject incomplete Electron layouts or incorrectly named output. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const release = path.join(root, 'release')
const requested = new Set(process.argv.slice(2))
const requiredCore = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'dxcompiler.dll', 'libEGL.dll', 'libGLESv2.dll', 'ModCrafting.exe']
const unpacked = path.join(release, 'win-unpacked')

function fail(message) {
  console.error(`[package-verify] ${message}`)
  process.exitCode = 1
}

for (const name of requiredCore) {
  if (!existsSync(path.join(unpacked, name))) fail(`Electron core file missing: win-unpacked/${name}`)
}

// electron-updater loads js-yaml from the main process. Check the ASAR
// manifest instead of discovering a missing transitive production dependency
// only after the installer has reached users.
const asarPath = path.join(unpacked, 'resources', 'app.asar')
if (existsSync(asarPath)) {
  try {
    const listed = execFileSync(process.execPath, [path.join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'list', asarPath], { encoding: 'utf8' })
    for (const dependency of ['node_modules/electron-updater/', 'node_modules/js-yaml/']) {
      if (!listed.includes(dependency)) fail(`Required main-process dependency missing from app.asar: ${dependency}`)
    }
  } catch (error) {
    fail(`Unable to inspect app.asar dependencies: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const setupName = `ModCrafting-Setup-${version}.exe`
const portableName = `ModCrafting-${version}-Portable.exe`
const setupPath = path.join(release, setupName)
const portablePath = path.join(release, portableName)
if (!requested.has('--portable') && !existsSync(setupPath)) fail(`Setup artifact missing: ${setupName}`)
if (!requested.has('--setup') && !existsSync(portablePath)) fail(`Portable artifact missing: ${portableName}`)

if (existsSync(setupPath) && statSync(setupPath).size >= 100_000_000) {
  fail(`Setup is ${statSync(setupPath).size} bytes, exceeding the 100,000,000 byte release limit`)
}

const latestPath = path.join(release, 'latest.yml')
if (existsSync(latestPath)) {
  const latest = readFileSync(latestPath, 'utf8')
  if (!latest.includes(`path: ${setupName}`)) fail('latest.yml does not reference the canonical Setup filename')
  if (!/^sha512:\s*\S+/m.test(latest)) fail('latest.yml is missing sha512')
}

if (!process.exitCode) console.log(`[package-verify] Windows x64 artifacts passed (${version})`)
