import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getAppEdition, type AppEdition } from './edition'

export interface RuntimeLayout {
  edition: AppEdition
  runtimeRoot: string
  cacheRoot: string
  logRoot: string
  legacyRuntimeRoot?: string
  migrated: boolean
}

function setupRuntimeRoot(): string {
  // NSIS updates and uninstalls own the installation directory. Runtime data must
  // live outside it so that an update never removes an already downloaded JDK.
  const localAppData = process.env.LOCALAPPDATA || path.dirname(app.getPath('userData'))
  return path.join(localAppData, 'ModCrafting', 'runtime')
}

export function getRuntimeLayout(): RuntimeLayout {
  const edition = getAppEdition()
  const legacyRuntimeRoot = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'runtime') : undefined
  const runtimeRoot = edition === 'portable'
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'runtime')
    : edition === 'full'
      ? setupRuntimeRoot()
      : path.resolve(__dirname, '..', '..', 'runtime')
  return {
    edition,
    runtimeRoot,
    cacheRoot: path.join(runtimeRoot, 'gradle-home'),
    logRoot: path.join(runtimeRoot, 'logs'),
    legacyRuntimeRoot,
    migrated: false
  }
}

/** Copy only a complete previous runtime into the new safe Setup location. */
export function migrateLegacyRuntime(isValid: (root: string) => boolean): RuntimeLayout {
  const layout = getRuntimeLayout()
  if (layout.edition !== 'full' || !layout.legacyRuntimeRoot || layout.runtimeRoot === layout.legacyRuntimeRoot) return layout
  if (isValid(layout.runtimeRoot) || !isValid(layout.legacyRuntimeRoot)) return layout
  try {
    const staging = `${layout.runtimeRoot}.migration-${Date.now()}`
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(layout.runtimeRoot), { recursive: true })
    fs.cpSync(layout.legacyRuntimeRoot, staging, { recursive: true, force: false })
    if (!isValid(staging)) {
      fs.rmSync(staging, { recursive: true, force: true })
      return layout
    }
    fs.rmSync(layout.runtimeRoot, { recursive: true, force: true })
    fs.renameSync(staging, layout.runtimeRoot)
    return { ...layout, migrated: true }
  } catch {
    return layout
  }
}
