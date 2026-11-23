/**
 * Turning resolved registry data into the one entry shape `pack.json` stores.
 *
 * Baseline picks, solver results and discovered candidates all end up here, so
 * a file name, hash set or side mapping cannot drift between them.
 */

import type { EnvironmentKind } from '../pack-model.ts'
import type { EntrySide, PackEntry, PackLicense, PackEntrySource } from '../workspace-model.ts'
import type { RegistryFile, RegistryVersion } from './registry-model.ts'

export function sideForEnvironment(environment: EnvironmentKind | undefined): EntrySide {
  if (environment === 'client_only' || environment === 'client_only_server_optional' || environment === 'singleplayer_only') return 'client'
  if (environment === 'server_only' || environment === 'dedicated_server_only') return 'server'
  return 'both'
}

export function entryFromVersion(input: {
  entryId: string
  projectId: string
  source: PackEntrySource
  version: RegistryVersion
  file: RegistryFile
  license: PackLicense
  environment?: EnvironmentKind
}): PackEntry {
  return {
    entryId: input.entryId,
    fileName: input.file.fileName,
    source: input.source,
    projectId: input.projectId,
    versionId: input.version.versionId,
    hashes: { ...input.file.hashes },
    license: input.license,
    enabled: true,
    side: sideForEnvironment(input.environment)
  }
}

/** A file name that is a single path segment and safe on Windows. */
export function safeEntryFileName(value: string): boolean {
  return /\.jar$/i.test(value) &&
    !/[<>:"/\\|?*\u0000-\u001F]/.test(value) &&
    value !== '.' && value !== '..' && !value.startsWith('.')
}
