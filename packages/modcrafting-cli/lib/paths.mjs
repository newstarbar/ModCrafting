/**
 * Single source of truth for every filesystem location the installer touches.
 *
 * Tests redirect the whole tree by setting MODCRAFTING_HOME plus the platform
 * variables below, so no function here may cache a resolved path at module load.
 */
import os from 'node:os'
import path from 'node:path'

export function env(name) {
  return process.env[name]
}

export function platform() {
  return process.platform
}

export function userHome() {
  if (process.platform === 'win32' && process.env.USERPROFILE) return process.env.USERPROFILE
  if (process.env.HOME) return process.env.HOME
  return os.homedir()
}

/** Root of everything ModCrafting installs outside a host: versions, data, state. */
export function rootDir() {
  if (process.env.MODCRAFTING_HOME) return path.resolve(process.env.MODCRAFTING_HOME)
  return path.join(userHome(), '.modcrafting')
}

export function versionsDir() {
  return path.join(rootDir(), 'versions')
}

export function dataDir(hostId) {
  return path.join(rootDir(), 'data', hostId)
}

export function stateFile() {
  return path.join(rootDir(), 'state.json')
}

export function backupsDir() {
  return path.join(rootDir(), 'backups')
}

export function stagingDir(label = 'stage') {
  return path.join(rootDir(), 'staging', `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
}

/** Roaming profile root used by GUI hosts on Windows. */
export function appData() {
  if (process.env.APPDATA) return process.env.APPDATA
  if (process.platform === 'win32') return path.join(userHome(), 'AppData', 'Roaming')
  return configHome()
}

/** XDG config root (macOS and Linux GUI hosts). */
export function configHome() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME
  if (process.platform === 'darwin') return path.join(userHome(), 'Library', 'Application Support')
  return path.join(userHome(), '.config')
}

export function localDataHome() {
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(userHome(), 'AppData', 'Local')
  return path.join(userHome(), '.local', 'share')
}

/** Expand a leading `~` and normalise separators without touching the disk. */
export function expand(value, ctx = {}) {
  if (typeof value !== 'string' || !value) throw new Error('Expected a non-empty path string')
  const home = ctx.home ?? userHome()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return path.resolve(value)
}

/** Absolute path required by mcp-server.ts for MODCRAFTING_DATA. */
export function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path: ${value}`)
  return path.resolve(value)
}

/** True when `child` is inside `parent` (or equal to it). */
export function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
