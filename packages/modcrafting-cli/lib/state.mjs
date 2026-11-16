/** Installer state: what we wrote, so uninstall can be surgical. */
import path from 'node:path'
import { atomicWrite, exists, ensureDir, readJson } from './fsx.mjs'
import { stateFile } from './paths.mjs'

const EMPTY = { stateVersion: 1, installs: {} }

export function readState() {
  const file = stateFile()
  if (!exists(file)) return structuredClone(EMPTY)
  try {
    const { data } = readJson(file)
    return { stateVersion: 1, installs: data.installs && typeof data.installs === 'object' ? data.installs : {} }
  } catch {
    return structuredClone(EMPTY)
  }
}

export function writeState(state, { dryRun = false } = {}) {
  if (dryRun) return stateFile()
  const file = stateFile()
  ensureDir(path.dirname(file))
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`)
  return file
}

export function recordHost(state, hostId, payload) {
  state.installs[hostId] = {
    bundleVersion: payload.bundleVersion,
    configFile: payload.configFile,
    entry: payload.entry,
    skills: payload.skills ?? [],
    installedAt: new Date().toISOString()
  }
}

export function forgetHost(state, hostId) {
  delete state.installs[hostId]
}

export function installedHosts(state) {
  return Object.keys(state.installs)
}
