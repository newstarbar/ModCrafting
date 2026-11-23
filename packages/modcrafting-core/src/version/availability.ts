/**
 * Availability and evidence helpers.
 *
 * The point of this module is that no caller has to invent what "supported"
 * means. `maxEvidenceFor` is the single answer to "how far has this cell been
 * proven", and it deliberately tops out at `compile` for cells that build but
 * have no Observer runtime.
 */
import type { MatrixCell } from './schema.ts'

export const evidenceLevels = ['none', 'model', 'codegen', 'compile', 'package', 'runtime'] as const
export type EvidenceLevel = (typeof evidenceLevels)[number]

export function maxEvidenceFor(cell: MatrixCell): EvidenceLevel {
  if (cell.status === 'supported') return 'runtime'
  if (cell.status === 'build-only') return 'compile'
  if (cell.status === 'declared') return 'codegen'
  return 'none'
}

/** True when the cell is worth materializing at all. */
export function isBuildable(cell: MatrixCell): boolean {
  return Boolean(cell.release?.build) && (cell.status === 'supported' || cell.status === 'build-only' || cell.status === 'declared')
}

export function cellLabel(cell: MatrixCell): string {
  return `${cell.loader} ${cell.minecraft}`
}

/** Plain-language status plus the one action that would improve it. */
export function describeCell(cell: MatrixCell): { status: string; evidence: EvidenceLevel; next: string } {
  const evidence = maxEvidenceFor(cell)
  if (cell.status === 'supported') return { status: '构建与游戏内测试均可用', evidence, next: '无需操作' }
  if (cell.status === 'build-only') {
    return { status: '可以构建，但没有可用的游戏内测试运行时', evidence, next: '需要把 Observer 移植到该目标后才能跑自动化测试' }
  }
  if (cell.status === 'declared') return { status: '上游存在该版本，但构建工具链尚未验证', evidence, next: '运行 pnpm run probe:target 升级证据' }
  if (cell.status === 'unavailable') return { status: '上游没有该加载器的这个版本', evidence, next: cell.remediation ?? '换用同一位次的其他加载器' }
  return { status: '尚未同步到该单元格', evidence, next: '运行 pnpm run versions:sync' }
}

export function summarize(cells: readonly MatrixCell[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const cell of cells) counts[cell.status] = (counts[cell.status] ?? 0) + 1
  return counts
}
