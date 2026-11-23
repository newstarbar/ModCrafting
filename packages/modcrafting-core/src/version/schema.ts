/**
 * Version catalog contracts.
 *
 * One rule governs this file: Minecraft version ids are opaque strings.
 * Since 2026 Mojang ships year-based ids (26.1, 26.2, 26.3) alongside the
 * legacy 1.20.x / 1.21.x line, so nothing here may parse an id with
 * Number.parseInt or compare ids lexicographically. Ordering always comes
 * from the catalog `order` array (Mojang manifest sequence) via registry.ts.
 */
import { z } from 'zod'

export const loaderIds = ['fabric', 'neoforge', 'forge'] as const
export type LoaderId = (typeof loaderIds)[number]
export const loaderLabels: Record<LoaderId, string> = { fabric: 'Fabric', neoforge: 'NeoForge', forge: 'Forge' }

/** Release ids only; snapshots are intentionally absent from the catalog. */
export const mcVersionSchema = z.string().regex(/^\d+\.\d+(?:\.\d+)?$/)

export const mappingKinds = ['yarn', 'mojmap', 'official', 'none'] as const
export type MappingKind = (typeof mappingKinds)[number]

export const mappingsSchema = z.object({
  kind: z.enum(mappingKinds),
  version: z.string().min(1),
  channel: z.string().min(1).optional()
}).strict()
export type Mappings = z.infer<typeof mappingsSchema>

export const buildPluginSchema = z.object({
  /** Gradle version the adapter requires; the wrapper is injected per version. */
  gradle: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/),
  pluginId: z.string().min(1),
  pluginVersion: z.string().min(1),
  /**
   * Proof attached to the tuple that was actually built. A "probed" flag without
   * the tuple would be worthless, so the evidence lives next to it.
   */
  evidence: z.enum(['declared', 'probed']).optional(),
  probedAt: z.string().min(1).optional(),
  javaMajor: z.number().int().optional()
}).strict()
export type BuildPlugin = z.infer<typeof buildPluginSchema>

/** `latest` means upstream published it but never promoted it; treat as lower evidence. */
export const releaseChannels = ['stable', 'latest', 'beta'] as const
export type ReleaseChannel = (typeof releaseChannels)[number]

export const evidenceSources = ['probed', 'declared', 'unverified'] as const
export type EvidenceSource = (typeof evidenceSources)[number]

export const loaderReleaseSchema = z.object({
  loader: z.enum(loaderIds),
  minecraft: mcVersionSchema,
  loaderVersion: z.string().min(1),
  channel: z.enum(releaseChannels),
  mappings: mappingsSchema,
  /** Fabric API coordinate suffix; null for NeoForge/Forge which bundle their API. */
  apiVersion: z.string().min(1).nullable(),
  /**
   * Null means "the build toolchain for this cell is not known yet".
   * A hypothesis must carry evidence !== 'probed' so nothing masquerades as verified.
   */
  build: buildPluginSchema.nullable(),
  note: z.string().min(1).optional(),
  javaTarget: z.number().int(),
  recommended: z.boolean(),
  sources: z.array(z.string().min(1)).min(1),
  fetchedAt: z.string().min(1),
  evidence: z.enum(evidenceSources)
}).strict()
export type LoaderRelease = z.infer<typeof loaderReleaseSchema>

/**
 * Build capability only. Runtime capability is a separate axis (`runtimeObserver`)
 * so that "builds but cannot be game-tested" never has to masquerade as unsupported.
 * The order mirrors the evidence ladder: declared -> build-only -> supported.
 */
export const cellStatuses = ['supported', 'build-only', 'declared', 'unavailable', 'unknown'] as const
export type CellStatus = (typeof cellStatuses)[number]

export const matrixCellSchema = z.object({
  key: z.string().regex(/^(fabric|neoforge|forge)@\d+\.\d+(?:\.\d+)?$/),
  loader: z.enum(loaderIds),
  minecraft: mcVersionSchema,
  status: z.enum(cellStatuses),
  release: loaderReleaseSchema.nullable(),
  /** Required when status is not 'supported'. */
  reason: z.string().min(1).optional(),
  remediation: z.string().min(1).optional(),
  runtimeObserver: z.boolean(),
  probedAt: z.string().min(1).optional()
}).strict()
export type MatrixCell = z.infer<typeof matrixCellSchema>

export const versionReleaseSchema = z.object({
  id: mcVersionSchema,
  releaseTime: z.string().min(1),
  javaTarget: z.number().int(),
  type: z.enum(['release', 'snapshot', 'old_beta', 'old_alpha'])
}).strict()
export type VersionRelease = z.infer<typeof versionReleaseSchema>

export const toolsSchema = z.object({
  gradle: z.array(z.string().min(1)).min(1),
  loom: z.string().min(1).optional(),
  mdg: z.string().min(1).optional(),
  fg: z.string().min(1).optional(),
  fabricLoader: z.string().min(1).optional()
}).strict()

export const syncStateSchema = z.object({
  stale: z.boolean(),
  failures: z.array(z.object({ endpoint: z.string().min(1), reason: z.string().min(1) }).strict())
}).strict()
export type SyncState = z.infer<typeof syncStateSchema>

export const versionCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().min(1),
  /** Minecraft release ids, newest first. The single source of total ordering. */
  order: z.array(mcVersionSchema).min(1),
  releases: z.array(versionReleaseSchema).min(1),
  /**
   * The shipped matrix is a filter over `cells`, never a hard-coded list.
   * Adding 1.21.9 is a data edit here, not a code change.
   */
  milestones: z.array(mcVersionSchema).min(1),
  cells: z.array(matrixCellSchema).min(1),
  tools: toolsSchema,
  sync: syncStateSchema
}).strict()
export type VersionCatalog = z.infer<typeof versionCatalogSchema>

export function cellKey(loader: LoaderId, minecraft: string): string {
  return `${loader}@${minecraft}`
}

export function parseCatalog(value: unknown): VersionCatalog {
  const parsed = versionCatalogSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw Object.assign(new Error(`version catalog 不合法：${parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || 'catalog'}: ${issue.message}`).join('; ')}`), { code: 'CATALOG_INVALID' })
}
