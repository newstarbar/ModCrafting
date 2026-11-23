/**
 * CurseForge -> normalized registry model.
 *
 * Two differences from Modrinth are load-bearing rather than cosmetic:
 *  - there is no explicit client/server declaration, so environment is always
 *    `unknown` and the baseline treats it as "needs review";
 *  - there is no SPDX licence, only the author's third-party distribution flag,
 *    which is the closest honest signal for whether bytes may be exported.
 */

import type { DependencyKind } from '../../pack-model.ts'
import { curseforgeLicense } from '../license-policy.ts'
import { partitionTags, type RegistryDependency, type RegistryFile, type RegistryProject, type RegistryVersion } from '../registry-model.ts'
import type { LoaderId } from '../../version/schema.ts'

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

const MOD_LOADERS: Readonly<Record<number, LoaderId>> = { 1: 'forge', 4: 'fabric', 6: 'neoforge' }

/** CurseForge relation types; 4 is a tool and is deliberately not a pack dependency. */
const RELATIONS: Readonly<Record<number, DependencyKind | 'tool'>> = {
  1: 'embedded',
  2: 'optional',
  3: 'required',
  4: 'tool',
  5: 'incompatible',
  6: 'embedded'
}

const SHA1_RE = /^[a-f0-9]{40}$/

function fileIndexes(raw: unknown): { gameVersions: string[]; loaders: LoaderId[] } {
  const gameVersions: string[] = []
  const loaders: LoaderId[] = []
  for (const entry of asArray(raw)) {
    const index = asRecord(entry)
    const version = asString(index.gameVersion)
    if (version && !gameVersions.includes(version)) gameVersions.push(version)
    const loader = MOD_LOADERS[asNumber(index.modLoader)]
    if (loader && !loaders.includes(loader)) loaders.push(loader)
  }
  return { gameVersions, loaders }
}

function normalizeProject(raw: unknown): RegistryProject {
  const mod = asRecord(raw)
  const slug = asString(mod.slug) || String(asNumber(mod.id))
  const links = asRecord(mod.links)
  const indexes = fileIndexes(mod.latestFilesIndexes)
  return {
    registry: 'curseforge',
    projectId: String(asNumber(mod.id) || slug),
    slug,
    title: asString(mod.name) || slug,
    description: asString(mod.summary),
    categories: asArray(mod.categories).flatMap((value) => {
      const name = asString(asRecord(value).name)
      return name ? [name] : []
    }),
    downloads: asNumber(mod.downloadCount),
    updatedAt: asString(mod.dateModified) || asString(mod.dateCreated) || '1970-01-01T00:00:00Z',
    license: curseforgeLicense(mod.allowModDistribution),
    environment: 'unknown',
    loaders: indexes.loaders,
    gameVersions: indexes.gameVersions,
    url: asString(links.websiteUrl) || asString(mod.externalUrl) || `https://www.curseforge.com/minecraft/mc-mods/${slug}`
  }
}

export function curseforgeSearchHit(raw: unknown): RegistryProject {
  return normalizeProject(raw)
}

export function curseforgeMod(raw: unknown): RegistryProject {
  return normalizeProject(raw)
}

export function curseforgeSearch(raw: unknown): RegistryProject[] {
  return asArray(asRecord(raw).data).map(curseforgeSearchHit)
}

function normalizeFile(raw: unknown): RegistryFile | undefined {
  const file = asRecord(raw)
  const fileName = asString(file.fileName)
  if (!fileName) return undefined
  const sha1 = asArray(file.hashes)
    .map((entry) => asRecord(entry))
    .find((entry) => asNumber(entry.algo) === 1)?.value
  const digest = asString(sha1).toLowerCase()
  const url = asString(file.downloadUrl)
  return {
    fileName,
    primary: true,
    size: Math.max(0, Math.trunc(asNumber(file.fileLength))),
    hashes: SHA1_RE.test(digest) ? { sha1: digest } : {},
    url: url ? url : null
  }
}

function normalizeDependencies(raw: unknown): RegistryDependency[] {
  return asArray(raw).flatMap((entry) => {
    const dependency = asRecord(entry)
    const modId = asNumber(dependency.modId)
    const relation = RELATIONS[asNumber(dependency.relationType)]
    if (!modId || !relation || relation === 'tool') return []
    return [{ projectId: String(modId), kind: relation }]
  })
}

function channelOf(releaseType: unknown): RegistryVersion['channel'] {
  const type = asNumber(releaseType, 1)
  if (type === 2) return 'beta'
  if (type === 3) return 'alpha'
  return 'release'
}

export function curseforgeFile(raw: unknown, project: Pick<RegistryProject, 'projectId' | 'license'>): RegistryVersion {
  const file = asRecord(raw)
  const displayName = asString(file.displayName) || asString(file.fileName) || String(asNumber(file.id))
  const tags = partitionTags(asArray(file.gameVersions).map((value) => String(value)))
  const normalized = normalizeFile(file)
  return {
    registry: 'curseforge',
    projectId: project.projectId,
    versionId: String(asNumber(file.id) || displayName),
    name: displayName,
    versionNumber: displayName,
    gameVersions: tags.gameVersions,
    loaders: tags.loaders,
    channel: channelOf(file.releaseType),
    publishedAt: asString(file.fileDate) || '1970-01-01T00:00:00Z',
    files: normalized ? [normalized] : [],
    dependencies: normalizeDependencies(file.dependencies),
    license: project.license
  }
}

export function curseforgeFiles(raw: unknown, project: Pick<RegistryProject, 'projectId' | 'license'>): RegistryVersion[] {
  return asArray(asRecord(raw).data).map((file) => curseforgeFile(file, project))
}
