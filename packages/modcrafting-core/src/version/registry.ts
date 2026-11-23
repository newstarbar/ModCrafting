/**
 * Total ordering over Minecraft release ids.
 *
 * The catalog `order` array (Mojang manifest sequence) is authoritative because
 * Minecraft ships two numbering schemes side by side: legacy `1.20.1 … 1.21.11`
 * and year-based `26.1 … 26.3`. Numeric comparison happens to agree today, but
 * a hypothetical `1.21.12` patch released after `26.1` would break it, so the
 * release sequence wins whenever both ids are known.
 *
 * Comparison must stay *total* (it is used by era boundaries), so unknown ids
 * fall back to numeric comparison instead of throwing. Resolving a target does
 * throw — that is the strict boundary.
 */
import { VERSION_CATALOG } from './catalog.generated.ts'
import { cellKey, parseCatalog, type LoaderId, type MatrixCell, type VersionCatalog } from './schema.ts'

export interface VersionRange { min: string; max: string }

export interface VersionRegistry {
  readonly catalog: VersionCatalog
  readonly order: readonly string[]
  has(version: string): boolean
  /** Positive when `a` is newer than `b`. */
  compare(a: string, b: string): number
  atLeast(version: string, boundary: string): boolean
  /** Half-open: [min, maxExclusive). */
  between(version: string, min: string, maxExclusive: string): boolean
  /** Undefined unless the ids form an unbroken run in the release sequence. */
  contiguousRange(versions: readonly string[]): VersionRange | undefined
  cell(loader: LoaderId, minecraft: string): MatrixCell | undefined
  cells(): readonly MatrixCell[]
  milestones(): readonly string[]
}

function parseVersion(value: string): { base: number[]; suffix: string } {
  const [base, ...rest] = String(value).trim().split('-')
  return {
    base: base.split('.').map((part) => {
      const parsed = Number(part)
      return Number.isInteger(parsed) ? parsed : 0
    }),
    suffix: rest.join('-')
  }
}

function compareNumeric(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b)
  const length = Math.max(left.base.length, right.base.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.base[index] ?? 0, y = right.base[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.suffix === right.suffix) return 0
  if (!left.suffix) return 1
  if (!right.suffix) return -1
  return left.suffix < right.suffix ? -1 : 1
}

export function createRegistry(catalog: VersionCatalog): VersionRegistry {
  const rank = new Map(catalog.order.map((id, index) => [id, index]))
  const cellIndex = new Map(catalog.cells.map((entry) => [entry.key, entry]))

  const compare = (a: string, b: string): number => {
    const left = rank.get(a), right = rank.get(b)
    if (left !== undefined && right !== undefined) return left === right ? 0 : left < right ? 1 : -1
    return compareNumeric(a, b)
  }

  return {
    catalog,
    order: catalog.order,
    has: (version) => rank.has(version),
    compare,
    atLeast: (version, boundary) => compare(version, boundary) >= 0,
    between: (version, min, maxExclusive) => compare(version, min) >= 0 && compare(version, maxExclusive) < 0,
    contiguousRange(versions) {
      if (versions.length === 0) return undefined
      const ranks = versions.map((version) => rank.get(version))
      if (ranks.some((value) => value === undefined)) return undefined
      const sorted = [...(ranks as number[])].sort((a, b) => a - b)
      for (let index = 1; index < sorted.length; index += 1) if (sorted[index] - sorted[index - 1] !== 1) return undefined
      // Smaller rank is newer, so the highest rank is the lowest version.
      return { min: catalog.order[sorted.at(-1)!], max: catalog.order[sorted[0]] }
    },
    cell: (loader, minecraft) => cellIndex.get(cellKey(loader, minecraft)),
    cells: () => catalog.cells,
    milestones: () => catalog.milestones
  }
}

let cached: VersionRegistry | undefined

export function getRegistry(): VersionRegistry {
  cached ??= createRegistry(parseCatalog(VERSION_CATALOG))
  return cached
}

/** Tests only. */
export function resetRegistry(): void { cached = undefined }
