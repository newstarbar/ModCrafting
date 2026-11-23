/**
 * Modpack declarations: the human-readable manifest, the machine lockfile, the
 * baseline profile, and the shapes a discovery result has to carry.
 *
 * Two documents, on purpose:
 *  - `pack.json` is what a human edits and reviews. It records *what* the pack
 *    wants, never *how* a version was resolved.
 *  - `pack.lock.json` is what a machine reproduces. It pins version ids, hashes
 *    and the solver version, so rebuilding a pack six months later produces the
 *    same bytes or fails loudly.
 *
 * Merging them would make the reviewable file churn on every catalogue change,
 * and would let a hand edit silently break reproducibility.
 *
 * Pure module: no Node imports, no network. Everything that talks to Modrinth
 * lives in `pack-resolver.ts`.
 */

import { z } from 'zod'
import { loaderIds } from './version/schema.ts'
import { licenseSchema, packEntrySchema, targetIdSchema, type PackEntry } from './workspace-model.ts'

export const PACK_MANIFEST_FILE = 'pack.json'
export const PACK_LOCK_FILE = 'pack.lock.json'
export const PACK_SOLVER_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Modrinth environment vocabulary
// ---------------------------------------------------------------------------

/**
 * Mirrors Modrinth's `environment` field. Kept explicit instead of a free string
 * because the baseline rules below switch on it.
 */
export const environmentKinds = [
  'client_and_server',
  'client_only',
  'client_only_server_optional',
  'singleplayer_only',
  'server_only',
  'server_only_client_optional',
  'dedicated_server_only',
  'client_or_server',
  'client_or_server_prefers_both',
  'unknown'
] as const
export type EnvironmentKind = (typeof environmentKinds)[number]

export const dependencyKinds = ['required', 'optional', 'incompatible', 'embedded'] as const
export type DependencyKind = (typeof dependencyKinds)[number]

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const packManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, '版本号形如 1.0.0'),
  targetId: targetIdSchema,
  /** The baseline is part of the manifest: which conveniences ship is a product decision. */
  baselineGroups: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).max(8),
  entries: z.array(packEntrySchema).max(1024),
  notes: z.string().max(4000).optional()
}).strict()
  .refine((value) => new Set(value.entries.map((entry) => entry.entryId)).size === value.entries.length, {
    message: 'entryId 不能重复', path: ['entries']
  })
  .refine((value) => new Set(value.entries.map((entry) => entry.fileName.toLowerCase())).size === value.entries.length, {
    message: '同一个包内不能有两个同名 jar（Windows 大小写不敏感）', path: ['entries']
  })
export type PackManifest = z.infer<typeof packManifestSchema>

export function emptyPackManifest(input: { name: string; version?: string; targetId: string; baselineGroups?: string[] }): PackManifest {
  return {
    schemaVersion: 1,
    name: input.name.trim() || '未命名整合包',
    version: input.version ?? '0.1.0',
    targetId: input.targetId,
    baselineGroups: input.baselineGroups ?? ['performance', 'qol'],
    entries: []
  }
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

export const lockedDependencySchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(dependencyKinds),
  /** The version actually selected, when the dependency constrained one. */
  versionId: z.string().min(1).optional()
}).strict()
export type LockedDependency = z.infer<typeof lockedDependencySchema>

export const lockedEntrySchema = z.object({
  entryId: z.string().min(1),
  fileName: z.string().min(1),
  /** Where the bytes come from. `null` means "present locally only", which cannot be reproduced. */
  downloadUrl: z.string().url().nullable(),
  hashes: z.object({
    sha1: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    sha512: z.string().regex(/^[a-f0-9]{128}$/).optional()
  }).strict(),
  size: z.number().int().nonnegative().optional(),
  side: z.enum(['client', 'server', 'both']).optional(),
  license: licenseSchema,
  dependencies: z.array(lockedDependencySchema),
  /** Free-text note surfaced by `resolve` when a choice was not obvious. */
  reason: z.string().max(500).optional()
}).strict()
export type LockedEntry = z.infer<typeof lockedEntrySchema>

export const packLockSchema = z.object({
  schemaVersion: z.literal(1),
  solverVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  targetId: targetIdSchema,
  entries: z.array(lockedEntrySchema),
  /** Non-fatal issues: a mod without a published hash, an optional dependency skipped. */
  warnings: z.array(z.string().max(500)).max(200)
}).strict()
export type PackLock = z.infer<typeof packLockSchema>

export function emptyPackLock(targetId: string, generatedAt: string): PackLock {
  return { schemaVersion: 1, solverVersion: PACK_SOLVER_VERSION, generatedAt, targetId, entries: [], warnings: [] }
}

/**
 * Why a resolve attempt produced what it produced.
 *
 * `GAP` is not an error: it is the signal that the pack needs something that
 * does not exist yet, which is exactly what the transform pipeline consumes.
 */
export const resolveVerdicts = ['satisfied', 'gap', 'conflict', 'unsatisfiable'] as const
export type ResolveVerdict = (typeof resolveVerdicts)[number]

export interface ResolveFinding {
  readonly code: string
  readonly verdict: ResolveVerdict
  /** One sentence a non-specialist can act on. */
  readonly message: string
  readonly projectId?: string
  readonly entryId?: string
  readonly details?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export const packIntentSchema = z.object({
  /** What the pack is for, in the user's own words. */
  goal: z.string().trim().min(1).max(2000),
  /** Concrete capabilities the pack must provide. Each becomes a coverage unit. */
  features: z.array(z.string().trim().min(1).max(120)).max(40),
  domain: z.string().trim().max(60).optional(),
  mustHave: z.array(z.string().trim().min(1).max(120)).max(20),
  niceToHave: z.array(z.string().trim().min(1).max(120)).max(30),
  /** Search hints that are not literal feature names (e.g. 中文关键词). */
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional()
}).strict()
export type PackIntent = z.infer<typeof packIntentSchema>

export const scoreEvidenceSchema = z.object({
  kind: z.enum(['keyword', 'category', 'description', 'popularity', 'freshness', 'compatibility']),
  detail: z.string().max(300),
  weight: z.number().min(0).max(1)
}).strict()
export type ScoreEvidence = z.infer<typeof scoreEvidenceSchema>

export const candidateSchema = z.object({
  projectId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  categories: z.array(z.string()),
  downloads: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  license: licenseSchema,
  environment: z.enum(environmentKinds),
  /** 0..1, deterministic from the weights in `pack-discover.ts`. */
  score: z.number().min(0).max(1),
  /** Which features this candidate is judged to cover, and which it misses. */
  covered: z.array(z.string()),
  missing: z.array(z.string()),
  coverage: z.number().min(0).max(1),
  evidence: z.array(scoreEvidenceSchema)
}).strict()
export type Candidate = z.infer<typeof candidateSchema>

export const gapReportSchema = z.object({
  /** Share of `features`+`mustHave` that the accepted candidates cover. */
  coverage: z.number().min(0).max(1),
  missing: z.array(z.string()),
  /**
   * Candidates that cover most of a gap. These are the transform inputs:
   * "closest existing mod is X, it lacks Y" is a concrete work item.
   */
  nearMiss: z.array(z.object({
    projectId: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    coverage: z.number().min(0).max(1),
    missing: z.array(z.string())
  }).strict()).max(40),
  /** True when nothing plausible exists, so the answer is "author a mod", not "adapt one". */
  authorFromScratch: z.boolean()
}).strict()
export type GapReport = z.infer<typeof gapReportSchema>

/** Below this the pack is reported as having a gap rather than being accepted. */
export const GAP_COVERAGE_THRESHOLD = 0.6

// ---------------------------------------------------------------------------
// Baseline profile
// ---------------------------------------------------------------------------

/**
 * Categories a baseline entry may claim. The baseline exists to make the game
 * feel better without changing what the game *is*, so gameplay genres are out.
 */
export const BASELINE_ALLOWED_CATEGORIES = ['optimization', 'decoration', 'library', 'utility', 'management'] as const
export const BASELINE_FORBIDDEN_CATEGORIES = ['adventure', 'technology', 'magic', 'worldgen', 'mobs', 'equipment', 'food', 'storage'] as const

/** Environments a client-side convenience mod may ship in. */
export const BASELINE_ALLOWED_ENVIRONMENTS: readonly EnvironmentKind[] = [
  'client_and_server',
  'client_only',
  'client_only_server_optional',
  'singleplayer_only',
  'client_or_server',
  'client_or_server_prefers_both'
]

/**
 * Pairs that cannot coexist. The reason is surfaced verbatim so the user does not
 * have to know that OptiFine replaces the render pipeline Sodium also replaces.
 */
export const BASELINE_MUTEX: ReadonlyArray<{ a: string; b: string; reason: string }> = [
  { a: 'sodium', b: 'optifine', reason: '两者都替换渲染管线，只能保留一个' },
  { a: 'iris', b: 'optifine', reason: 'OptiFine 内置光影，与 Iris 冲突' },
  { a: 'embeddium', b: 'sodium', reason: 'Embeddium 是 Sodium 的 NeoForge 移植，不要同时安装' }
]

/** Hard requirements that are not mutexes: `b` needs `a`. */
export const BASELINE_REQUIRES: ReadonlyArray<{ slug: string; requires: string; reason: string }> = [
  { slug: 'iris', requires: 'sodium', reason: 'Iris 依赖 Sodium 的渲染管线' },
  { slug: 'indium', requires: 'sodium', reason: 'Indium 为 Sodium 补上 Fabric 渲染 API' }
]

export const baselineEntrySchema = z.object({
  /** Modrinth slug; the version is resolved at build time, never hard-coded. */
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  required: z.boolean(),
  reason: z.string().trim().max(200)
}).strict()
export type BaselineEntry = z.infer<typeof baselineEntrySchema>

export const baselineGroupSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().trim().min(1).max(40),
  description: z.string().trim().max(300),
  entries: z.array(baselineEntrySchema).max(64)
}).strict()
export type BaselineGroup = z.infer<typeof baselineGroupSchema>

export const baselineProfileSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(baselineGroupSchema).max(8)
}).strict()
  .refine((value) => new Set(value.groups.map((group) => group.id)).size === value.groups.length, {
    message: 'baseline 组 id 不能重复', path: ['groups']
  })
export type BaselineProfile = z.infer<typeof baselineProfileSchema>

/**
 * Shipped defaults. Slugs are Modrinth identifiers; whether a given Minecraft
 * version has a build is decided by the resolver, never assumed here, so this
 * list does not need a version bump when a mod skips a release.
 */
export const BUILTIN_BASELINE: BaselineProfile = {
  schemaVersion: 1,
  groups: [
    {
      id: 'performance',
      label: '性能',
      description: '降低帧时间与内存占用，不改变游戏内容',
      entries: [
        { slug: 'sodium', required: true, reason: '现代渲染优化，是多数画面模组的前提' },
        { slug: 'lithium', required: true, reason: '服务端与单人的游戏逻辑优化' },
        { slug: 'ferrite-core', required: true, reason: '压缩模型与纹理的内存占用' },
        { slug: 'krypton', required: false, reason: '网络栈优化，多人时收益明显' },
        { slug: 'immediatelyfast', required: false, reason: '即时渲染批处理' },
        { slug: 'modernfix', required: false, reason: '缩短启动时间、降低常驻内存' },
        { slug: 'entityculling', required: false, reason: '剔除视野外实体渲染' }
      ]
    },
    {
      id: 'visual',
      label: '画面',
      description: '光影、连接纹理与光照表现',
      entries: [
        { slug: 'iris', required: false, reason: '光影加载器，依赖 Sodium' },
        { slug: 'continuity', required: false, reason: '连接纹理' },
        { slug: 'indium', required: false, reason: '为 Sodium 补 Fabric 渲染 API' },
        { slug: 'entitytexturefeatures', required: false, reason: '实体纹理变体与表情' },
        { slug: 'lambdynamiclights', required: false, reason: '动态光源' }
      ]
    },
    {
      id: 'qol',
      label: '操作与界面',
      description: '配置入口、配方查询与背包操作',
      entries: [
        { slug: 'modmenu', required: true, reason: '模组配置的统一入口' },
        { slug: 'cloth-config', required: true, reason: '多数模组的配置界面依赖' },
        { slug: 'yacl', required: false, reason: 'Yet Another Config Lib，部分模组依赖' },
        { slug: 'mouse-tweaks', required: false, reason: '背包拖拽与快捷移动' },
        { slug: 'inventory-profiles-next', required: false, reason: '背包排序与整理' },
        { slug: 'emi', required: false, reason: '配方与物品查询' }
      ]
    }
  ]
}

export const baselineVerdictCodes = ['BASELINE_OFF_GENRE', 'BASELINE_CONFLICT', 'BASELINE_SIDE_UNSUPPORTED', 'BASELINE_NEEDS_REVIEW'] as const
export type BaselineVerdictCode = (typeof baselineVerdictCodes)[number]

export type BaselineVerdict =
  | { ok: true; warning?: string }
  | { ok: false; code: BaselineVerdictCode; message: string }

/**
 * "Does this mod belong in a baseline, i.e. does installing it change what the
 * game is rather than how it feels?"
 *
 * Deliberately conservative: an unknown environment or an unlisted category is
 * reported for review instead of being silently accepted, because a baseline that
 * quietly adds gameplay is the one failure mode users cannot diagnose.
 */
export function checkBaselineEntry(input: {
  slug: string
  categories: readonly string[]
  environment: EnvironmentKind
  /** Slugs already accepted in the same profile, for mutex/requires checks. */
  present?: readonly string[]
}): BaselineVerdict {
  const slug = input.slug.toLowerCase()
  const categories = input.categories.map((category) => category.toLowerCase())

  const forbidden = categories.filter((category) => (BASELINE_FORBIDDEN_CATEGORIES as readonly string[]).includes(category))
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'BASELINE_OFF_GENRE',
      message: `${slug} 属于玩法分类（${forbidden.join(', ')}），会改变原版玩法，不能放进通用底座。请把它作为正式成员加入整合包。`
    }
  }

  // `unknown` is not a side: it means the project did not say. Treat it as a
  // client mod with a warning below, rather than pretending it is server-only.
  if (input.environment !== 'unknown' && !(BASELINE_ALLOWED_ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    return {
      ok: false,
      code: 'BASELINE_SIDE_UNSUPPORTED',
      message: `${slug} 的运行环境是 ${input.environment}，纯服务端模组不会改善客户端体验，放在底座里没有意义。`
    }
  }

  const present = (input.present ?? []).map((value) => value.toLowerCase())
  for (const pair of BASELINE_MUTEX) {
    const other = pair.a === slug ? pair.b : pair.b === slug ? pair.a : undefined
    if (other && present.includes(other)) {
      return { ok: false, code: 'BASELINE_CONFLICT', message: `${slug} 与 ${other} 不能共存：${pair.reason}` }
    }
  }
  for (const rule of BASELINE_REQUIRES) {
    if (rule.slug === slug && !present.includes(rule.requires)) {
      return { ok: false, code: 'BASELINE_CONFLICT', message: `${slug} 需要同时安装 ${rule.requires}：${rule.reason}` }
    }
  }

  if (input.environment === 'unknown') {
    return { ok: true, warning: `${slug} 没有声明客户端/服务端环境，已按客户端模组处理；如果它其实是服务端专用，请移出底座。` }
  }
  if (!categories.some((category) => (BASELINE_ALLOWED_CATEGORIES as readonly string[]).includes(category))) {
    return { ok: true, warning: `${slug} 的分类（${categories.join(', ') || '未声明'}）不在底座的推荐范围内，请确认它不改变玩法。` }
  }
  return { ok: true }
}

/** Convenience: the manifests' declared groups resolved against the shipped profile. */
export function baselineGroupsOf(profile: BaselineProfile, ids: readonly string[]): BaselineGroup[] {
  return ids.flatMap((id) => {
    const group = profile.groups.find((candidate) => candidate.id === id)
    return group ? [group] : []
  })
}

/** Flatten a profile selection into one ordered, de-duplicated slug list. */
export function baselineSlugs(groups: readonly BaselineGroup[]): Array<{ slug: string; required: boolean; group: string }> {
  const seen = new Set<string>()
  const output: Array<{ slug: string; required: boolean; group: string }> = []
  for (const group of groups) {
    for (const entry of group.entries) {
      const slug = entry.slug.toLowerCase()
      if (seen.has(slug)) continue
      seen.add(slug)
      output.push({ slug, required: entry.required, group: group.id })
    }
  }
  return output
}

export const loaderIdSchema = z.enum(loaderIds)

/** Entries a manifest declares but a lockfile does not have (or vice versa). */
export function lockDrift(manifest: PackManifest, lock: PackLock): { missingInLock: string[]; extraInLock: string[] } {
  const declared = new Set(manifest.entries.map((entry: PackEntry) => entry.entryId))
  const locked = new Set(lock.entries.map((entry) => entry.entryId))
  return {
    missingInLock: [...declared].filter((id) => !locked.has(id)).sort(),
    extraInLock: [...locked].filter((id) => !declared.has(id)).sort()
  }
}
