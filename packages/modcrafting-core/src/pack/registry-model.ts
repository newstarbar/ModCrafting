/**
 * The one shape both registries are normalized into.
 *
 * Discovery, scoring and solving read only this module. That keeps the two APIs'
 * vocabulary (Modrinth facets vs CurseForge numeric loaders, SPDX vs an author
 * distribution flag) at the adapter boundary instead of leaking into the solver.
 *
 * Pure module: no Node imports, no network. HTTP lives in `registry-client.ts`.
 */

import { z } from 'zod'
import { dependencyKinds, environmentKinds } from '../pack-model.ts'
import { licenseSchema, registryIds, type RegistryId } from '../workspace-model.ts'
import { loaderIds, type LoaderId } from '../version/schema.ts'

export const registryProjectSchema = z.object({
  registry: z.enum(registryIds),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  categories: z.array(z.string()),
  downloads: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  license: licenseSchema,
  environment: z.enum(environmentKinds),
  loaders: z.array(z.enum(loaderIds)),
  gameVersions: z.array(z.string()),
  url: z.string().url()
}).strict()
export type RegistryProject = z.infer<typeof registryProjectSchema>

export const registryFileSchema = z.object({
  fileName: z.string().min(1),
  primary: z.boolean(),
  size: z.number().int().nonnegative(),
  hashes: z.object({
    sha1: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    sha512: z.string().regex(/^[a-f0-9]{128}$/).optional()
  }).strict(),
  /** `null` means the file can be installed locally but never exported by URL. */
  url: z.string().url().nullable()
}).strict()
export type RegistryFile = z.infer<typeof registryFileSchema>

export const registryDependencySchema = z.object({
  projectId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  kind: z.enum(dependencyKinds)
}).strict()
export type RegistryDependency = z.infer<typeof registryDependencySchema>

export const registryVersionSchema = z.object({
  registry: z.enum(registryIds),
  projectId: z.string().min(1),
  versionId: z.string().min(1),
  name: z.string().min(1),
  versionNumber: z.string().min(1),
  gameVersions: z.array(z.string()),
  loaders: z.array(z.enum(loaderIds)),
  channel: z.enum(['release', 'beta', 'alpha']),
  publishedAt: z.string().min(1),
  files: z.array(registryFileSchema),
  dependencies: z.array(registryDependencySchema),
  license: licenseSchema
}).strict()
export type RegistryVersion = z.infer<typeof registryVersionSchema>

const LOADER_NAMES: Readonly<Record<string, LoaderId>> = {
  fabric: 'fabric',
  neoforge: 'neoforge',
  forge: 'forge'
}

const GAME_VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/

export function loaderFromTag(value: string): LoaderId | undefined {
  return LOADER_NAMES[value.trim().toLowerCase()]
}

/**
 * Split a flat tag list (`["1.21.4", "Fabric"]`) into its three meanings.
 *
 * Registry payloads mix game versions, loader names and gameplay categories in
 * one array often enough that doing this at each call site invites drift.
 */
export function partitionTags(values: readonly string[]): { gameVersions: string[]; loaders: LoaderId[]; other: string[] } {
  const gameVersions: string[] = []
  const loaders: LoaderId[] = []
  const other: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const loader = loaderFromTag(trimmed)
    if (loader) { if (!loaders.includes(loader)) loaders.push(loader); continue }
    if (GAME_VERSION_RE.test(trimmed)) { if (!gameVersions.includes(trimmed)) gameVersions.push(trimmed); continue }
    if (!other.includes(trimmed)) other.push(trimmed)
  }
  return { gameVersions, loaders, other }
}

/** Registry id for a project key, so accepted lists cannot confuse the two catalogues. */
export function registryKey(registry: RegistryId, projectId: string): string {
  return `${registry}:${projectId}`
}
