import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export function needsWindowsAsciiLaunchAlias(platform: NodeJS.Platform, projectPath: string): boolean {
  return platform === 'win32' && /[^\x20-\x7E]/.test(projectPath)
}

export function windowsAsciiLaunchAliasName(projectPath: string): string {
  return createHash('sha256').update(path.resolve(projectPath).toLowerCase()).digest('hex').slice(0, 16)
}

/**
 * Loom's dev-launch config is still consumed through Java properties on
 * Windows. A non-ASCII project path can be decoded with the active OEM code
 * page, corrupting fabric.classPathGroups and loading Mixin twice (app + Knot).
 * Launch through a stable ASCII junction while keeping all files in place.
 */
export function resolveLaunchProjectPath(projectPath: string): string {
  if (!needsWindowsAsciiLaunchAlias(process.platform, projectPath)) return projectPath

  const systemDrive = /^[A-Za-z]:$/.test(process.env.SystemDrive || '') ? process.env.SystemDrive! : 'C:'
  const aliasRoot = path.join(systemDrive, 'ModCraftingRuntime', 'projects')
  const aliasPath = path.join(aliasRoot, windowsAsciiLaunchAliasName(projectPath))
  fs.mkdirSync(aliasRoot, { recursive: true })

  try {
    const existingTarget = fs.readlinkSync(aliasPath)
    if (path.resolve(existingTarget).toLowerCase() === path.resolve(projectPath).toLowerCase()) return aliasPath
    throw new Error(`ASCII launch alias already points elsewhere: ${aliasPath}`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'EINVAL' && code !== 'UNKNOWN') throw error
    if (fs.existsSync(aliasPath)) {
      throw new Error(`Cannot create ASCII launch alias because a non-link path exists: ${aliasPath}`)
    }
  }

  fs.symlinkSync(path.resolve(projectPath), aliasPath, 'junction')
  return aliasPath
}
