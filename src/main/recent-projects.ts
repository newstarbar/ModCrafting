import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

const MAX_RECENT = 10

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

type SettingsFile = {
  lastProjectPath?: string
  recentProjects?: RecentProject[]
}

function readSettings(): SettingsFile {
  const file = settingsPath()
  if (!fs.existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as SettingsFile
  } catch {
    return {}
  }
}

function writeSettings(settings: SettingsFile): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

function migrateLegacy(settings: SettingsFile): RecentProject[] {
  if (settings.recentProjects?.length) return settings.recentProjects
  if (settings.lastProjectPath) {
    const p = settings.lastProjectPath
    return [{
      path: p,
      name: path.basename(p),
      openedAt: new Date().toISOString()
    }]
  }
  return []
}

export function listRecentProjects(): RecentProject[] {
  const settings = readSettings()
  const all = migrateLegacy(settings)
    .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
    .slice(0, MAX_RECENT)

  const valid = all.filter((p) => fs.existsSync(p.path))
  if (valid.length !== all.length) {
    writeSettings({
      ...settings,
      recentProjects: valid,
      lastProjectPath: valid[0]?.path
    })
  }
  return valid
}

export function addRecentProject(projectPath: string): RecentProject[] {
  const settings = readSettings()
  const existing = migrateLegacy(settings).filter((p) => p.path !== projectPath)
  const entry: RecentProject = {
    path: projectPath,
    name: path.basename(projectPath),
    openedAt: new Date().toISOString()
  }
  const recentProjects = [entry, ...existing].slice(0, MAX_RECENT)
  writeSettings({ ...settings, recentProjects, lastProjectPath: projectPath })
  return recentProjects
}

export function removeRecentProject(projectPath: string): RecentProject[] {
  const settings = readSettings()
  const recentProjects = migrateLegacy(settings).filter((p) => p.path !== projectPath)
  writeSettings({
    ...settings,
    recentProjects,
    lastProjectPath: recentProjects[0]?.path
  })
  return recentProjects
}

export function clearRecentProjects(): void {
  const settings = readSettings()
  writeSettings({ ...settings, recentProjects: [], lastProjectPath: undefined })
}

export function getLastRecentProject(): string | null {
  const list = listRecentProjects()
  return list[0]?.path ?? null
}
