/**
 * Golden store: the checked-in expected tree plus its index.
 *
 * `baseline.json` is intentionally write-once. It records what the 1.21.4 output
 * looked like *before* the resource-dialect refactor, so any later change to
 * 1.21.4 bytes fails instead of being silently accepted by `golden:update`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, pathsetHash, sha256, type CapturedTree } from './capture.ts'

export const GOLDEN_DIR = path.dirname(fileURLToPath(import.meta.url))
export const RESOURCES_DIR = path.join(GOLDEN_DIR, 'resources')
export const INDEX_PATH = path.join(GOLDEN_DIR, 'resources', 'index.json')
export const BASELINE_PATH = path.join(GOLDEN_DIR, 'baseline.json')

export interface RepresentativeRecord {
  pathsetHash: string
  contentHash: string
  text: number
  binary: number
  binaryEntries: Array<{ path: string; sha256: string; size: number }>
}

export interface GoldenIndex {
  schemaVersion: 2
  representatives: Record<string, RepresentativeRecord>
  /** cell key -> representative version */
  cells: Record<string, string>
  /**
   * Cells that can only produce part of the case set (26.x: recipes yes, content no).
   * They are not skipped — every file they *do* produce must still match the
   * representative byte for byte, and the reason must explain the gap.
   */
  partial?: Record<string, { representative: string; reason: string }>
}

export interface Baseline {
  schemaVersion: 1
  capturedFromCommit: string
  minecraft: string
  pathsetHash: string
  contentHash: string
  /** relative resource path -> sha256 */
  files: Record<string, string>
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export const readIndex = (): GoldenIndex | undefined => readJson<GoldenIndex>(INDEX_PATH)
export const readBaseline = (): Baseline | undefined => readJson<Baseline>(BASELINE_PATH)
export const writeIndex = (index: GoldenIndex): void => writeJson(INDEX_PATH, index)

export function writeBaseline(minecraft: string, tree: CapturedTree, capturedFromCommit: string): Baseline {
  if (existsSync(BASELINE_PATH)) throw new Error(`baseline.json 已存在，拒绝覆盖。基线只能由 P2 改造前的代码捕获一次：${BASELINE_PATH}`)
  const baseline: Baseline = {
    schemaVersion: 1,
    capturedFromCommit,
    minecraft,
    pathsetHash: pathsetHash(tree),
    contentHash: contentHash(tree),
    files: Object.fromEntries([...tree.text.map((file) => [file.path, sha256(file.content)] as const), ...tree.binary.map((file) => [file.path, file.sha256] as const)].sort(([left], [right]) => left < right ? -1 : 1))
  }
  writeJson(BASELINE_PATH, baseline)
  return baseline
}

/** Read one representative back into the same shape capture produces. */
export function readRepresentative(version: string, index: GoldenIndex): CapturedTree {
  const root = path.join(RESOURCES_DIR, version)
  const record = index.representatives[version]
  if (!record) throw new Error(`index.json 缺少代表形态 ${version}`)
  const text: CapturedTree['text'] = []
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      const relative = path.relative(root, file).replaceAll('\\', '/')
      text.push({ path: relative, content: readFileSync(file, 'utf8') })
    }
  }
  walk(root)
  return { text: text.sort((left, right) => left.path < right.path ? -1 : 1), binary: record.binaryEntries }
}

export function writeRepresentative(version: string, tree: CapturedTree): RepresentativeRecord {
  const root = path.join(RESOURCES_DIR, version)
  // Write first, then prune files that are no longer part of the tree. Deleting the
  // whole directory trips the sandbox delete shim (it times out on big trees), and a
  // write-then-prune leaves the same result without a bulk delete.
  const keep = new Set(tree.text.map(file => file.path))
  for (const file of tree.text) {
    const target = path.join(root, ...file.path.split('/'))
    // Skip identical content: rewriting untouched files is pure risk (and on Windows
    // an unrelated handle on the file turns a no-op into EPERM).
    try { if (readFileSync(target, 'utf8') === file.content) continue } catch { /* missing: write it */ }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
  if (existsSync(root)) for (const stale of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!stale.isFile()) continue
    const absolute = path.join(stale.parentPath ?? root, stale.name)
    const relative = path.relative(root, absolute).replaceAll('\\', '/')
    if (keep.has(relative)) continue
    try { unlinkSync(absolute) } catch { /* a stale file that cannot be removed is reported by the golden check */ }
  }
  return {
    pathsetHash: pathsetHash(tree),
    contentHash: contentHash(tree),
    text: tree.text.length,
    binary: tree.binary.length,
    binaryEntries: tree.binary
  }
}
