/**
 * Modrinth -> normalized registry model.
 *
 * Only shape translation belongs here. Facets, pagination and caching are the
 * client's job; scoring never sees a Modrinth field name.
 */

import type { DependencyKind, EnvironmentKind } from '../../pack-model.ts'
import { licenseFor } from '../license-policy.ts'
import { loaderFromTag, partitionTags, type RegistryDependency, type RegistryFile, type RegistryProject, type RegistryVersion } from '../registry-model.ts'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown): boolean {
  return value === true
}

const DEPENDENCY_KINDS = new Set<DependencyKind>(['required', 'optional', 'incompatible', 'embedded'])
const SHA1_RE = /^[a-f0-9]{40}$/
const SHA512_RE = /^[a-f0-9]{128}$/

/**
 * Modrinth expresses sides as two independent fields. `singleplayer_only` and
 * `dedicated_server_only` cannot be derived from them, so they are never invented.
 */
export function modrinthEnvironment(clientSide: unknown, serverSide: unknown): EnvironmentKind {
  const client = asString(clientSide, 'unknown')
  const server = asString(serverSide, 'unknown')
  if (client === 'required' && server === 'required') return 'client_and_server'
  if (client === 'required' && server === 'unsupported') return 'client_only'
  if (client === 'required' && server === 'optional') return 'client_only_server_optional'
  if (client === 'optional' && server === 'required') return 'server_only_client_optional'
  if (client === 'unsupported' && server === 'required') return 'server_only'
  if (client === 'optional' && server === 'optional') return 'client_or_server'
  return 'unknown'
}

function licenseIdOf(value: unknown): string {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  return asString(record.id) || asString(record.name)
}

function normalizeProject(raw: unknown): RegistryProject {
  const hit = asRecord(raw)
  const categories = asArray(hit.categories).map((value) => String(value))
  const tags = partitionTags(categories)
  const loaderTags = asArray(hit.loaders).flatMap((value) => {
    const loader = loaderFromTag(String(value))
    return loader ? [loader] : []
  })
  const gameVersionTags = asArray(hit.game_versions).map((value) => String(value))
  const versionTags = asArray(hit.versions).map((value) => String(value))
  const slug = asString(hit.slug) || asString(hit.project_id) || asString(hit.id)
  return {
    registry: 'modrinth',
    projectId: asString(hit.project_id) || asString(hit.id) || slug,
    slug,
    title: asString(hit.title) || asString(hit.name) || slug,
    description: asString(hit.description) || asString(hit.summary) || asString(hit.body),
    categories: tags.other,
    downloads: asNumber(hit.downloads),
    updatedAt: asString(hit.date_modified) || asString(hit.updated) || asString(hit.date_created) || '1970-01-01T00:00:00Z',
    license: licenseFor(licenseIdOf(hit.license)),
    environment: modrinthEnvironment(hit.client_side, hit.server_side),
    loaders: loaderTags.length > 0 ? loaderTags : tags.loaders,
    gameVersions: gameVersionTags.length > 0 ? gameVersionTags : versionTags.length > 0 ? versionTags : tags.gameVersions,
    url: `https://modrinth.com/mod/${slug}`
  }
}

export function modrinthSearchHit(raw: unknown): RegistryProject {
  return normalizeProject(raw)
}

export function modrinthProject(raw: unknown): RegistryProject {
  return normalizeProject(raw)
}

export function modrinthSearch(raw: unknown): RegistryProject[] {
  return asArray(asRecord(raw).hits).map(modrinthSearchHit)
}

function normalizeFile(raw: unknown): RegistryFile | undefined {
  const file = asRecord(raw)
  const fileName = asString(file.filename)
  if (!fileName) return undefined
  const hashes = asRecord(file.hashes)
  const sha1 = asString(hashes.sha1).toLowerCase()
  const sha512 = asString(hashes.sha512).toLowerCase()
  const url = asString(file.url)
  return {
    fileName,
    primary: asBoolean(file.primary),
    size: Math.max(0, Math.trunc(asNumber(file.size))),
    hashes: {
      ...(SHA1_RE.test(sha1) ? { sha1 } : {}),
      ...(SHA512_RE.test(sha512) ? { sha512 } : {})
    },
    url: url ? url : null
  }
}

function normalizeDependency(raw: unknown): RegistryDependency | undefined {
  const dependency = asRecord(raw)
  const projectId = asString(dependency.project_id)
  if (!projectId) return undefined
  const kind = asString(dependency.dependency_type) as DependencyKind
  if (!DEPENDENCY_KINDS.has(kind)) return undefined
  const versionId = asString(dependency.version_id)
  return { projectId, kind, ...(versionId ? { versionId } : {}) }
}

function channelOf(value: unknown): RegistryVersion['channel'] {
  const type = asString(value, 'release')
  if (type === 'beta') return 'beta'
  if (type === 'alpha') return 'alpha'
  return 'release'
}

export function modrinthVersion(raw: unknown, project: Pick<RegistryProject, 'projectId' | 'license'>): RegistryVersion {
  const version = asRecord(raw)
  const id = asString(version.id)
  const versionNumber = asString(version.version_number) || asString(version.name) || id
  return {
    registry: 'modrinth',
    projectId: project.projectId,
    versionId: id,
    name: asString(version.name) || versionNumber,
    versionNumber,
    gameVersions: asArray(version.game_versions).map((value) => String(value)),
    loaders: asArray(version.loaders).flatMap((value) => {
      const loader = loaderFromTag(String(value))
      return loader ? [loader] : []
    }),
    channel: channelOf(version.version_type),
    publishedAt: asString(version.date_published) || '1970-01-01T00:00:00Z',
    files: asArray(version.files).flatMap((file) => {
      const normalized = normalizeFile(file)
      return normalized ? [normalized] : []
    }),
    dependencies: asArray(version.dependencies).flatMap((dependency) => {
      const normalized = normalizeDependency(dependency)
      return normalized ? [normalized] : []
    }),
    license: project.license
  }
}

export function modrinthVersions(raw: unknown, project: Pick<RegistryProject, 'projectId' | 'license'>): RegistryVersion[] {
  return asArray(raw).map((version) => modrinthVersion(version, project))
}
