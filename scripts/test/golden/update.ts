#!/usr/bin/env node
/**
 * Regenerate the golden resource trees.
 *
 *   pnpm run golden:update      rewrite representatives + index (never baseline)
 *   pnpm run golden:baseline    one-shot capture of the pre-refactor baseline
 */
import { execFileSync } from 'node:child_process'
import { captureTree } from './capture.ts'
import { summarizeTree } from './diff.ts'
import { CELL_REPRESENTATIVE, REPRESENTATIVES } from './representatives.ts'
import { BASELINE_PATH, readBaseline, writeBaseline, writeIndex, writeRepresentative } from './store.ts'
import { capabilitiesFor } from '../../../packages/modcrafting-core/src/version/capabilities.ts'
import { getRegistry } from '../../../packages/modcrafting-core/src/version/registry.ts'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const commit = (): string => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}

if (process.argv.includes('--baseline')) {
  const baseline = writeBaseline('1.21.4', captureTree('1.21.4'), `${commit()}-pre-p2`)
  process.stdout.write(`已写入基线 ${BASELINE_PATH}\n  ${baseline.files ? Object.keys(baseline.files).length : 0} 个文件，contentHash ${baseline.contentHash.slice(0, 16)}…\n`)
  process.exit(0)
}

const representatives: Record<string, ReturnType<typeof writeRepresentative>> = {}
for (const version of REPRESENTATIVES) {
  const tree = captureTree(version)
  representatives[version] = writeRepresentative(version, tree)
  process.stdout.write(`${version.padEnd(8)} ${summarizeTree(tree)}\n`)
}

const partial: Record<string, { representative: string; reason: string }> = {}
const cells: Record<string, string> = {}
for (const [cell, version] of Object.entries(CELL_REPRESENTATIVE)) {
  const [loader, minecraft] = cell.split('@')
  const release = getRegistry().cell(loader as 'fabric', minecraft)?.release
  const capabilities = capabilitiesFor({ loader: loader as 'fabric', minecraft, release })
  // Recipe resources are mapping-independent, so a cell can still produce files
  // while every content kind is refused. Those cells get the partial treatment.
  if (Object.values(capabilities.content).every((capability) => capability.state === 'blocked')) {
    partial[cell] = { representative: version, reason: Object.values(capabilities.content)[0]?.reason ?? '全部内容类型被拒绝' }
  } else cells[cell] = version
}
writeIndex({ schemaVersion: 2, representatives, cells, partial })

const baseline = readBaseline()
if (baseline) {
  const current = representatives['1.21.4']?.contentHash
  if (current && current !== baseline.contentHash) {
    process.stdout.write(`\n! 1.21.4 内容与基线不一致（${baseline.contentHash.slice(0, 12)}… → ${current.slice(0, 12)}…）。\n  如果这是有意的格式升级，请说明理由；否则这是回归。baseline.json 不会被自动改写。\n`)
  } else if (current) {
    process.stdout.write('\n1.21.4 与基线一致。\n')
  }
}
process.stdout.write(`\n已写入 ${REPRESENTATIVES.length} 个代表形态与 index.json（${Object.keys(CELL_REPRESENTATIVE).length} 个单元格映射）。\n`)
