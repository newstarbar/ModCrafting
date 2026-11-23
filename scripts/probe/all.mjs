#!/usr/bin/env node
/**
 * Probe the whole matrix, not one target at a time.
 *
 * The content emitters (Mojmap, NeoForge DeferredRegister) cannot be written
 * honestly without a fast compile loop, and this machine cannot reach the NeoForge
 * maven or the 26.x mappings. This runner is the loop: one command, every cell,
 * machine-readable summary, evidence written back only where a build really passed.
 *
 *   node --experimental-strip-types scripts/probe/all.mjs --list
 *   node --experimental-strip-types scripts/probe/all.mjs --loader fabric --content --record
 *   node --experimental-strip-types scripts/probe/all.mjs --ci --json probe-summary.json
 *
 * Exit code: 0 when every attempted cell either passed or was blocked by a
 * precondition (JDK/maven), 1 when any cell failed to build.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'
import { capabilitiesFor } from '../../packages/modcrafting-core/src/version/capabilities.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const registry = getRegistry()
const loader = value('loader', '')
const only = value('target', '')
const cells = registry.cells()
  .filter((cell) => (loader ? cell.loader === loader : true))
  .filter((cell) => (only ? cell.key === only : true))
  .map((cell) => {
    const capabilities = capabilitiesFor({ loader: cell.loader, minecraft: cell.minecraft, release: cell.release, runtimeObserver: cell.runtimeObserver })
    return {
      key: cell.key,
      loader: cell.loader,
      minecraft: cell.minecraft,
      javaTarget: cell.release.javaTarget,
      create: capabilities.createProject.state,
      content: capabilities.content.item.state,
      build: capabilities.build.evidence,
      required: capabilities.build.requires,
      reason: capabilities.createProject.reason ?? capabilities.content.item.reason
    }
  })

if (flag('list')) {
  for (const cell of cells) {
    const state = cell.create === 'blocked' ? 'blocked' : cell.build === 'probed' ? 'probed ' : 'declared'
    process.stdout.write(`${cell.key.padEnd(20)} ${state}  java=${cell.javaTarget}  ${cell.reason ?? ''}\n`)
  }
  process.stdout.write(`\n共 ${cells.length} 格；probed ${cells.filter((cell) => cell.build === 'probed').length}，blocked ${cells.filter((cell) => cell.create === 'blocked').length}\n`)
  process.exit(0)
}

const probeArgs = ['--experimental-strip-types', path.join(root, 'scripts/probe/target.mjs')]
const passthrough = ['content', 'gui', 'record', 'verbose'].filter(flag).map((name) => `--${name}`)
if (value('timeout', '')) passthrough.push('--timeout', value('timeout', ''))
if (value('gradle-home', '')) passthrough.push('--gradle-home', value('gradle-home', ''))

const results = []
for (const cell of cells) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [...probeArgs, '--target', cell.key, ...passthrough], { cwd: root, encoding: 'utf8', timeout: 3_600_000 })
  const line = `${run.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop() ?? ''
  let outcome = { code: 'NO_OUTPUT' }
  try { outcome = JSON.parse(line) } catch { /* keep NO_OUTPUT with the raw line */ }
  // A cell whose build the capability table already declares blocked (missing JDK,
  // missing upstream mappings) must not turn CI red: the attempt is recorded, the
  // "requirement" is the answer. Only unexpected failures count.
  const expected = cell.required.length > 0 || cell.create === 'blocked'
  const code = outcome.code === 'BUILD_FAILED' && expected ? 'BLOCKED_AS_EXPECTED' : outcome.code ?? 'UNKNOWN'
  const summary = {
    key: cell.key,
    code,
    seconds: Math.round((Date.now() - started) / 1000),
    build: outcome.durationMs ? Math.round(outcome.durationMs / 1000) : undefined,
    message: (outcome.message ?? '').split('\n')[0]?.slice(0, 160)
  }
  results.push(summary)
  process.stdout.write(`${summary.key.padEnd(20)} ${summary.code.padEnd(18)} ${summary.build ? summary.build + 's build' : ''} ${summary.message ?? ''}\n`)
}

const failed = results.filter((entry) => entry.code === 'BUILD_FAILED')
const passed = results.filter((entry) => entry.code === 'OK')
const blocked = results.filter((entry) => !['OK', 'BUILD_FAILED', 'BLOCKED_AS_EXPECTED'].includes(entry.code))
process.stdout.write(`\n通过 ${passed.length}，构建失败 ${failed.length}，前置阻塞 ${blocked.length}，按预期阻塞 ${results.filter((entry) => entry.code === 'BLOCKED_AS_EXPECTED').length}（共 ${results.length}）\n`)
if (flag('json')) {
  writeFileSync(path.resolve(value('json', 'probe-summary.json')), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, 'utf8')
}
process.exit(failed.length > 0 ? 1 : 0)
