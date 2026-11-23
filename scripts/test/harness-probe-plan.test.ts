import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capabilitiesFor } from '../../packages/modcrafting-core/src/version/capabilities.ts'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('the probe runner plans every cell and agrees with the capability table', () => {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/probe/all.mjs', '--list'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.trim().split('\n')
  const body = lines.filter((line) => /^[a-z]+@/.test(line))
  const registry = getRegistry()
  assert.equal(body.length, registry.cells().length, '计划必须覆盖整张矩阵，不能悄悄漏格')

  // Every blocked cell must state why — that reason is what an Agent would report.
  const blocked = body.filter((line) => /\bblocked\b/.test(line))
  const expectedBlocked = registry.cells().filter((cell) => capabilitiesFor({ loader: cell.loader, minecraft: cell.minecraft, release: cell.release }).createProject.state === 'blocked')
  assert.equal(blocked.length, expectedBlocked.length, '阻塞格数量必须与能力表一致')
  for (const line of blocked) assert.match(line, /尚未实现/, `阻塞格必须带原因：${line}`)

  assert.match(lines.at(-1) ?? '', /共 \d+ 格/)
})

test('probe runner treats a declared-blocked build as expected, not as a failure', async () => {
  // Exercised without running Gradle: the classification lives in the runner, so unit
  // testing it here keeps CI semantics honest (a missing-upstream blocker is not red).
  const source = await import('node:fs').then((fs) => fs.readFileSync(path.join(root, 'scripts/probe/all.mjs'), 'utf8'))
  assert.match(source, /BLOCKED_AS_EXPECTED/, '已知阻塞必须与真实失败区分')
  assert.match(source, /entry\.code === 'BUILD_FAILED'/, '退出码只能由真实失败决定')
})
