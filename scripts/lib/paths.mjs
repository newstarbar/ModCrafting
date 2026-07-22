import path from 'path'
import { fileURLToPath } from 'url'

/** Project root from any script under scripts/<subdir>/ */
export function projectRoot(fromMetaUrl) {
  return path.join(path.dirname(fileURLToPath(fromMetaUrl)), '..', '..')
}

export function packagingDir(fromMetaUrl) {
  return path.join(projectRoot(fromMetaUrl), 'packaging')
}
