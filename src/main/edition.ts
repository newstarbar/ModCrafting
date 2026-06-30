import { app } from 'electron'

export type AppEdition = 'dev' | 'full' | 'portable'

/** electron-builder portable sets PORTABLE_EXECUTABLE_DIR at runtime */
export function isPortableEdition(): boolean {
  return app.isPackaged && Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
}

export function isFullEdition(): boolean {
  return app.isPackaged && !isPortableEdition()
}

export function getAppEdition(): AppEdition {
  if (!app.isPackaged) return 'dev'
  return isPortableEdition() ? 'portable' : 'full'
}
