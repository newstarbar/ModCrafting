/**
 * Target resolution.
 *
 * Two levels on purpose:
 *  - `resolveTarget` is strict. It needs a real catalog cell, so it is what build,
 *    packaging and publishing must use; an unsupported cell fails loudly with a
 *    remediation instead of producing a half-working artifact.
 *  - `describeProjectTarget` is lenient. Authoring workspaces only need to know
 *    the resource and API shape of whatever version the user's project pins, even
 *    if that version is not part of the shipped publishing matrix yet.
 */
import { deriveJavaApiProfile, type JavaApiProfile } from './java-profile.ts'
import { getRegistry, type VersionRegistry } from './registry.ts'
import { deriveResourceLayout, unconfirmedShapes as unconfirmedFor, type ResourceLayout } from './resources-profile.ts'
import { cellKey, loaderIds, loaderLabels, type LoaderId, type LoaderRelease, type MatrixCell } from './schema.ts'

export interface ResolvedTarget {
  readonly id: string
  readonly shortId: string
  readonly loader: LoaderId
  readonly minecraft: string
  readonly status: MatrixCell['status']
  readonly cell: MatrixCell
  readonly release: LoaderRelease
  readonly layout: ResourceLayout
  readonly api: JavaApiProfile
  readonly runtimeObserver: boolean
  /** Resource shapes this target relies on that are not yet proven against a real client jar. */
  readonly unconfirmedShapes: string[]
}

export interface ProjectTarget {
  readonly loader: LoaderId
  readonly minecraft: string
  readonly layout: ResourceLayout
  readonly api: JavaApiProfile
  /** Absent when the project pins a version outside the shipped matrix. */
  readonly cell?: MatrixCell
  readonly unconfirmedShapes: string[]
}

export class TargetUnsupportedError extends Error {
  readonly code = 'TARGET_UNSUPPORTED'
  readonly remediation: string
  constructor(message: string, remediation: string) {
    super(message)
    this.name = 'TargetUnsupportedError'
    this.remediation = remediation
  }
}

export const isLoaderId = (value: unknown): value is LoaderId => typeof value === 'string' && (loaderIds as readonly string[]).includes(value)

export function shortTargetId(loader: LoaderId, minecraft: string): string {
  return `${loader[0]}${minecraft.replace(/\./g, '')}`
}

export function targetId(loader: LoaderId, minecraft: string): string {
  return `${loader}-${minecraft}`
}

export function parseTargetId(value: string): { loader: LoaderId; minecraft: string } {
  const at = value.indexOf('@')
  if (at > 0) {
    const loader = value.slice(0, at), minecraft = value.slice(at + 1)
    if (isLoaderId(loader)) return { loader, minecraft }
  }
  const dash = value.indexOf('-')
  if (dash > 0) {
    const loader = value.slice(0, dash), minecraft = value.slice(dash + 1)
    if (isLoaderId(loader)) return { loader, minecraft }
  }
  throw new TargetUnsupportedError(`无法解析目标 "${value}"`, '使用 "fabric@1.21.4" 或 "fabric-1.21.4" 形式')
}

export function resolveTarget(loader: LoaderId, minecraft: string, registry: VersionRegistry = getRegistry()): ResolvedTarget {
  const cell = registry.cell(loader, minecraft)
  if (!cell) {
    const known = registry.milestones()
    throw new TargetUnsupportedError(
      `矩阵里没有 ${loaderLabels[loader]} ${minecraft}`,
      `当前矩阵覆盖 ${known.join(' / ')}；运行 pnpm run versions:sync 拉取新版本，或改用矩阵内的目标`
    )
  }
  if (!cell.release) {
    throw new TargetUnsupportedError(
      `${loaderLabels[loader]} ${minecraft} 不可用：${cell.reason ?? '上游没有该版本'}`,
      cell.remediation ?? '换用同一位次的其他加载器，或运行 pnpm run versions:sync'
    )
  }
  return {
    id: targetId(loader, minecraft),
    shortId: shortTargetId(loader, minecraft),
    loader,
    minecraft,
    status: cell.status,
    cell,
    release: cell.release,
    layout: deriveResourceLayout(minecraft, registry),
    api: deriveJavaApiProfile(minecraft, cell.release.mappings.kind, registry),
    runtimeObserver: cell.runtimeObserver,
    unconfirmedShapes: unconfirmedFor(deriveResourceLayout(minecraft, registry))
  }
}

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/

export function describeProjectTarget(loader: LoaderId, minecraft: string, registry: VersionRegistry = getRegistry()): ProjectTarget {
  if (!VERSION_PATTERN.test(minecraft)) {
    throw new TargetUnsupportedError(
      `无法识别 Minecraft 版本 "${minecraft}"`,
      '在 gradle.properties 里把 minecraft_version 写成 1.21.4 或 26.3 这样的正式版号'
    )
  }
  const cell = registry.cell(loader, minecraft)
  const layout = deriveResourceLayout(minecraft, registry)
  return {
    loader,
    minecraft,
    layout,
    api: deriveJavaApiProfile(minecraft, cell?.release?.mappings.kind ?? (loader === 'fabric' ? 'yarn' : 'mojmap'), registry),
    ...(cell ? { cell } : {}),
    unconfirmedShapes: unconfirmedFor(layout)
  }
}

export function listTargets(registry: VersionRegistry = getRegistry()): ResolvedTarget[] {
  const targets: ResolvedTarget[] = []
  for (const loader of loaderIds) {
    for (const minecraft of registry.milestones()) {
      const cell = registry.cell(loader, minecraft)
      if (cell?.release) {
        targets.push(resolveTarget(loader, minecraft, registry))
      }
    }
  }
  return targets
}

export interface TargetSummary {
  id: string
  shortId: string
  loader: LoaderId
  loaderLabel: string
  minecraft: string
  status: MatrixCell['status']
  javaTarget: number
  loaderVersion: string | null
  channel: string | null
  runtimeObserver: boolean
  unconfirmedShapes: string[]
  reason?: string
  remediation?: string
}

export function targetSummary(cell: MatrixCell, registry: VersionRegistry = getRegistry()): TargetSummary {
  return {
    id: targetId(cell.loader, cell.minecraft),
    shortId: shortTargetId(cell.loader, cell.minecraft),
    loader: cell.loader,
    loaderLabel: loaderLabels[cell.loader],
    minecraft: cell.minecraft,
    status: cell.status,
    javaTarget: cell.release?.javaTarget ?? 0,
    loaderVersion: cell.release?.loaderVersion ?? null,
    channel: cell.release?.channel ?? null,
    runtimeObserver: cell.runtimeObserver,
    unconfirmedShapes: unconfirmedFor(deriveResourceLayout(cell.minecraft, registry)),
    ...(cell.reason ? { reason: cell.reason } : {}),
    ...(cell.remediation ? { remediation: cell.remediation } : {})
  }
}

/** The shipped matrix, constrained to catalog milestones. */
export function matrix(registry: VersionRegistry = getRegistry()): TargetSummary[] {
  const milestones = new Set(registry.milestones())
  return registry.cells()
    .filter((cell) => milestones.has(cell.minecraft))
    .sort((left, right) => loaderIds.indexOf(left.loader) - loaderIds.indexOf(right.loader) || registry.compare(right.minecraft, left.minecraft))
    .map((cell) => targetSummary(cell, registry))
}

export function cellFor(loader: LoaderId, minecraft: string, registry: VersionRegistry = getRegistry()): MatrixCell | undefined {
  return registry.cells().find((cell) => cell.key === cellKey(loader, minecraft))
}
