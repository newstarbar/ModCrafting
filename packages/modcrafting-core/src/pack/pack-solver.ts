/**
 * Declared pack entries -> a complete, reproducible lockfile.
 *
 * The solver's job is not to be clever. It closes required dependencies, selects
 * a version that matches the pack's target, and refuses to guess when the data
 * does not support a choice. A pack that cannot be resolved is a normal outcome:
 * `gap` says "something is missing, go find or build it", `conflict` says "two
 * installed mods cannot coexist", and `unsatisfiable` says "the declaration
 * itself cannot be built for this target".
 *
 * Pure module: every registry answer arrives through the `versions` map, so the
 * same input always produces the same lock. `solvePackWithRegistry` only exists
 * to fill that map and re-run the pure solver until no new dependency appears.
 */

import {
  PACK_SOLVER_VERSION,
  type EnvironmentKind,
  type PackLock,
  type PackManifest,
  type ResolveFinding,
  type ResolveVerdict
} from '../pack-model.ts'
import type { EntrySide, PackEntry, PackLicense, RegistryId } from '../workspace-model.ts'
import type { DiscoverTarget } from './pack-discover.ts'
import { sideForEnvironment } from './pack-entry.ts'
import type { RegistryReader } from './registry-client.ts'
import type { RegistryDependency, RegistryFile, RegistryProject, RegistryVersion } from './registry-model.ts'

export interface SolveInput {
  manifest: PackManifest
  target: DiscoverTarget
  /** Normalized versions, keyed by project id. An empty/absent list means "not available here". */
  versions: ReadonlyMap<string, readonly RegistryVersion[]>
  /** Optional project metadata; when present it wins over the version's license/environment. */
  projects?: ReadonlyMap<string, RegistryProject>
  generatedAt: string
}

export interface SolveResult {
  verdict: ResolveVerdict
  findings: ResolveFinding[]
  lock: PackLock
  /** Projects with no registry data at all. The async solver retries exactly these. */
  missing: string[]
}

const VERDICT_RANK: Readonly<Record<ResolveVerdict, number>> = { satisfied: 0, gap: 1, conflict: 2, unsatisfiable: 3 }
const CHANNEL_RANK: Readonly<Record<RegistryVersion['channel'], number>> = { release: 0, beta: 1, alpha: 2 }
const MAX_WARNINGS = 200
const MAX_WARNING_LENGTH = 500

interface Selection {
  version?: RegistryVersion
  problem?: 'pin-missing' | 'pin-incompatible' | 'none-compatible'
}

function compatibleWith(version: RegistryVersion, target: DiscoverTarget): boolean {
  return version.files.length > 0 &&
    version.gameVersions.includes(target.minecraft) &&
    version.loaders.includes(target.loader)
}

/** Code-unit order keeps lockfiles identical across machines and locales. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Highest channel first, then newest, then a stable id tie-break. */
function byPreference(left: RegistryVersion, right: RegistryVersion): number {
  return CHANNEL_RANK[left.channel] - CHANNEL_RANK[right.channel] ||
    compareCodeUnits(right.publishedAt, left.publishedAt) ||
    compareCodeUnits(right.versionId, left.versionId)
}

/**
 * A pinned version is a promise to the user, so it is never silently upgraded.
 * A pin that exists but does not match the target is a different problem from a
 * pin that vanished, and both get their own code.
 */
function selectVersion(rows: readonly RegistryVersion[], target: DiscoverTarget, pinned?: string): Selection {
  if (pinned) {
    const exact = rows.find((row) => row.versionId === pinned)
    if (!exact) return { problem: 'pin-missing' }
    if (!compatibleWith(exact, target)) return { version: exact, problem: 'pin-incompatible' }
    return { version: exact }
  }
  const compatible = rows.filter((version) => compatibleWith(version, target)).sort(byPreference)
  if (compatible.length === 0) return { problem: 'none-compatible' }
  return { version: compatible[0] }
}

function primaryFile(version: RegistryVersion): RegistryFile {
  return version.files.find((file) => file.primary) ?? version.files[0]
}

/**
 * The public "which build would I install?" question. Unlike `selectVersion`,
 * an incompatible pin yields `undefined` here: callers adding a new entry must
 * not be handed a version the target cannot run.
 */
export function pickVersion(rows: readonly RegistryVersion[], target: DiscoverTarget, pinned?: string): RegistryVersion | undefined {
  const selection = selectVersion(rows, target, pinned)
  return selection.problem ? undefined : selection.version
}

/** A single safe path-segment id derived from a registry project id. */
function entryIdFor(projectId: string, used: Set<string>): string {
  const base = projectId.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 56) || 'entry'
  let candidate = base
  let counter = 2
  while (used.has(candidate)) candidate = `${base}-${counter++}`
  return candidate
}

function truncateWarning(value: string): string {
  return value.length <= MAX_WARNING_LENGTH ? value : `${value.slice(0, MAX_WARNING_LENGTH - 1)}…`
}

interface ResolvedNode {
  entryId: string
  projectId: string
  version: RegistryVersion
  file: RegistryFile
  license: PackLicense
  side: EntrySide
  reason?: string
}

interface LocalNode {
  entry: PackEntry
}

export function solvePack(input: SolveInput): SolveResult {
  const findings: ResolveFinding[] = []
  const warnings: string[] = []
  const missing = new Set<string>()
  const resolved = new Map<string, ResolvedNode>()
  const queue: ResolvedNode[] = []
  const local: LocalNode[] = []
  const usedEntryIds = new Set<string>()
  const incompatibleEdges: Array<{ from: ResolvedNode; dependency: RegistryDependency }> = []
  const reportedIncompatible = new Set<string>()

  const warn = (message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(truncateWarning(message))
  }
  const report = (finding: ResolveFinding) => findings.push(finding)

  if (input.manifest.targetId !== `${input.target.loader}@${input.target.minecraft}`) {
    warn(`清单目标 ${input.manifest.targetId} 与求解目标 ${input.target.loader}@${input.target.minecraft} 不一致，已按后者求解。`)
  }

  const addResolved = (entryId: string, projectId: string, version: RegistryVersion, reason?: string): ResolvedNode => {
    const file = primaryFile(version)
    const project = input.projects?.get(projectId)
    const node: ResolvedNode = {
      entryId,
      projectId,
      version,
      file,
      license: project?.license ?? version.license,
      side: project ? sideForEnvironment(project.environment as EnvironmentKind) : 'both',
      reason
    }
    if (!file.url) warn(`${projectId} 没有公开下载地址，锁文件只能记录本地安装引用，导出后无法自动复现。`)
    resolved.set(projectId, node)
    usedEntryIds.add(entryId)
    queue.push(node)
    return node
  }

  // Pass 1: declared roots, in manifest order.
  for (const entry of input.manifest.entries) {
    if (!entry.enabled) continue

    if (entry.source === 'local' || entry.source === 'transform') {
      local.push({ entry })
      usedEntryIds.add(entry.entryId)
      continue
    }
    if (!entry.projectId) {
      report({
        code: 'ENTRY_PROJECT_MISSING',
        verdict: 'unsatisfiable',
        message: `条目 ${entry.entryId} 来自 ${entry.source} 但没有 projectId，无法解析版本。请补上项目 id 或改为本地条目。`,
        entryId: entry.entryId
      })
      continue
    }

    const existing = resolved.get(entry.projectId)
    if (existing) {
      if (existing.version.versionId === entry.versionId) {
        warn(`条目 ${entry.entryId} 与 ${existing.entryId} 指向同一个项目版本，已合并。`)
      } else {
        report({
          code: 'DUPLICATE_PROJECT',
          verdict: 'conflict',
          message: `同一个模组 ${entry.projectId} 被声明了两次且版本不同（${existing.entryId} / ${entry.entryId}）。一个整合包只能装一个版本。`,
          projectId: entry.projectId,
          entryId: entry.entryId
        })
      }
      continue
    }

    const rows = input.versions.get(entry.projectId)
    if (!rows || rows.length === 0) {
      missing.add(entry.projectId)
      report({
        code: 'PROJECT_UNAVAILABLE',
        verdict: 'unsatisfiable',
        message: `找不到 ${entry.projectId} 的版本数据；请检查项目 id、网络连接或数据源密钥。`,
        projectId: entry.projectId,
        entryId: entry.entryId
      })
      continue
    }

    const selection = selectVersion(rows, input.target, entry.versionId)
    if (selection.problem === 'pin-missing') {
      report({
        code: 'PINNED_VERSION_UNAVAILABLE',
        verdict: 'unsatisfiable',
        message: `${entry.projectId} 锁定的版本 ${entry.versionId} 已经不在数据源里。请解除版本锁定或选择现有版本。`,
        projectId: entry.projectId,
        entryId: entry.entryId,
        details: { pinned: entry.versionId }
      })
      continue
    }
    if (selection.problem === 'pin-incompatible') {
      report({
        code: 'PINNED_VERSION_INCOMPATIBLE',
        verdict: 'unsatisfiable',
        message: `${entry.projectId} 锁定的版本 ${entry.versionId} 不支持 ${input.target.loader} ${input.target.minecraft}。请更换版本或调整整合包目标。`,
        projectId: entry.projectId,
        entryId: entry.entryId,
        details: { pinned: entry.versionId }
      })
      continue
    }
    if (!selection.version) {
      report({
        code: 'NO_COMPATIBLE_VERSION',
        verdict: 'unsatisfiable',
        message: `${entry.projectId} 没有支持 ${input.target.loader} ${input.target.minecraft} 的版本。`,
        projectId: entry.projectId,
        entryId: entry.entryId
      })
      continue
    }

    const node = addResolved(entry.entryId, entry.projectId, selection.version, entry.source === 'baseline' ? '通用底座' : undefined)
    if (entry.side) node.side = entry.side
  }

  // Pass 2: dependency closure. The queue grows while we walk it, which is BFS
  // over required edges; each project enters at most once, so cycles terminate.
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    for (const dependency of node.version.dependencies) {
      if (dependency.kind === 'optional') {
        warn(`${node.projectId} 把 ${dependency.projectId} 列为可选依赖，未自动安装。需要时请手动加入清单。`)
        continue
      }
      if (dependency.kind === 'embedded') continue
      if (dependency.kind === 'incompatible') {
        incompatibleEdges.push({ from: node, dependency })
        continue
      }

      const existing = resolved.get(dependency.projectId)
      if (existing) {
        if (dependency.versionId && existing.version.versionId !== dependency.versionId) {
          report({
            code: 'VERSION_CONFLICT',
            verdict: 'conflict',
            message: `${node.projectId} 需要 ${dependency.projectId}@${dependency.versionId}，但已经解析为 ${existing.version.versionId}。请统一版本或移除其中一个模组。`,
            projectId: dependency.projectId,
            entryId: existing.entryId,
            details: { requiredBy: node.projectId, requiredVersion: dependency.versionId, resolvedVersion: existing.version.versionId }
          })
        }
        continue
      }

      const rows = input.versions.get(dependency.projectId)
      if (!rows || rows.length === 0) {
        missing.add(dependency.projectId)
        report({
          code: 'MISSING_DEPENDENCY',
          verdict: 'gap',
          message: `缺少依赖 ${dependency.projectId}（被 ${node.projectId} 需要），当前数据源里没有可用版本。可以搜索替代模组，或为它编写桥接/兼容模组。`,
          projectId: dependency.projectId,
          entryId: node.entryId,
          details: { requiredBy: node.projectId, registry: node.version.registry }
        })
        continue
      }

      const selection = selectVersion(rows, input.target, dependency.versionId)
      if (!selection.version || selection.problem === 'pin-incompatible') {
        report({
          code: 'DEPENDENCY_VERSION_UNAVAILABLE',
          verdict: 'unsatisfiable',
          message: `${node.projectId} 需要的 ${dependency.projectId}${dependency.versionId ? `@${dependency.versionId}` : ''} 不支持 ${input.target.loader} ${input.target.minecraft}。`,
          projectId: dependency.projectId,
          entryId: node.entryId,
          details: { requiredBy: node.projectId, pinned: dependency.versionId ?? null }
        })
        continue
      }

      const depEntryId = entryIdFor(dependency.projectId, usedEntryIds)
      addResolved(depEntryId, dependency.projectId, selection.version, `被 ${node.projectId} 需要`)
    }
  }

  // A declared incompatibility only matters when both sides are actually installed.
  for (const edge of incompatibleEdges) {
    if (!resolved.has(edge.dependency.projectId)) continue
    const key = `${edge.from.projectId}>${edge.dependency.projectId}`
    if (reportedIncompatible.has(key)) continue
    reportedIncompatible.add(key)
    report({
      code: 'DECLARED_INCOMPATIBLE',
      verdict: 'conflict',
      message: `${edge.from.projectId} 声明与 ${edge.dependency.projectId} 不兼容，但两者都在清单里。请移除其中一个，或寻找兼容替代/桥接模组。`,
      projectId: edge.dependency.projectId,
      entryId: resolved.get(edge.dependency.projectId)!.entryId,
      details: { declaredBy: edge.from.projectId }
    })
  }

  const lockEntries = [
    ...[...resolved.values()].map((node) => ({
      entryId: node.entryId,
      fileName: node.file.fileName,
      registry: node.version.registry,
      projectId: node.projectId,
      versionId: node.version.versionId,
      downloadUrl: node.file.url,
      hashes: { ...node.file.hashes },
      size: node.file.size,
      side: node.side,
      license: node.license,
      dependencies: node.version.dependencies.map((dependency) => ({
        projectId: dependency.projectId,
        kind: dependency.kind,
        ...(dependency.versionId ? { versionId: dependency.versionId } : {})
      })),
      ...(node.reason ? { reason: node.reason } : {})
    })),
    ...local.map(({ entry }) => ({
      entryId: entry.entryId,
      fileName: entry.fileName,
      downloadUrl: null,
      hashes: { ...entry.hashes },
      side: entry.side,
      license: entry.license,
      dependencies: [],
      reason: '本地条目，只存在于当前工作区'
    }))
  ].sort((left, right) => compareCodeUnits(left.entryId, right.entryId))

  for (const { entry } of local) {
    warn(`本地条目 ${entry.entryId} 只存在于工作区，导出的包无法复现它；请随包分发这个 jar，或把它发布到数据源。`)
  }

  let verdict: ResolveVerdict = 'satisfied'
  for (const finding of findings) {
    if (VERDICT_RANK[finding.verdict] > VERDICT_RANK[verdict]) verdict = finding.verdict
  }

  const lock: PackLock = {
    schemaVersion: 1,
    solverVersion: PACK_SOLVER_VERSION,
    generatedAt: input.generatedAt,
    targetId: input.manifest.targetId,
    entries: lockEntries,
    warnings
  }

  return { verdict, findings, lock, missing: [...missing].sort() }
}

/**
 * Fill the version map from the registry, solve, and repeat for dependencies the
 * previous round could not see. A bounded round count keeps a malformed chain
 * from turning into an unbounded crawl; four rounds covers every real pack
 * shape we have seen (root -> library -> transitively pinned APIs).
 */
export async function solvePackWithRegistry(
  reader: RegistryReader,
  input: { manifest: PackManifest; target: DiscoverTarget; generatedAt: string; rounds?: number; projects?: ReadonlyMap<string, RegistryProject> }
): Promise<SolveResult> {
  const versions = new Map<string, RegistryVersion[]>()
  const registryOf = new Map<string, RegistryId>()
  const pending = new Set<string>()

  for (const entry of input.manifest.entries) {
    if (!entry.enabled || !entry.projectId) continue
    if (entry.source === 'modrinth' || entry.source === 'curseforge') registryOf.set(entry.projectId, entry.source)
    pending.add(entry.projectId)
  }

  const rounds = Math.max(1, Math.min(input.rounds ?? 4, 8))
  let result: SolveResult | undefined
  for (let round = 0; round < rounds; round++) {
    const current = [...pending]
    pending.clear()
    for (const projectId of current) {
      if (versions.has(projectId)) continue
      const registry = registryOf.get(projectId) ?? 'modrinth'
      try {
        versions.set(projectId, await reader.versions({
          registry,
          projectId,
          loader: input.target.loader,
          gameVersion: input.target.minecraft
        }))
      } catch {
        // Degrade to "no data" rather than aborting: one failing catalogue call
        // must not hide the rest of the pack's findings.
        versions.set(projectId, [])
      }
    }

    result = solvePack({
      manifest: input.manifest,
      target: input.target,
      versions,
      projects: input.projects,
      generatedAt: input.generatedAt
    })

    for (const finding of result.findings) {
      if (finding.code !== 'MISSING_DEPENDENCY' || !finding.projectId) continue
      if (versions.has(finding.projectId)) continue
      pending.add(finding.projectId)
      const parentRegistry = finding.details?.registry
      if (parentRegistry === 'modrinth' || parentRegistry === 'curseforge') registryOf.set(finding.projectId, parentRegistry)
    }
    if (pending.size === 0) return result
  }

  return result ?? solvePack({
    manifest: input.manifest,
    target: input.target,
    versions,
    projects: input.projects,
    generatedAt: input.generatedAt
  })
}
