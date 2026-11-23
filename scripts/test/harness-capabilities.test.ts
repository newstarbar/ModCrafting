import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { capabilitiesFor } from '../../packages/modcrafting-core/src/version/capabilities.ts'
import { contentKinds, newContentObject } from '../../packages/modcrafting-core/src/content-model.ts'
import { generateContent } from '../../packages/modcrafting-core/src/content-codegen.ts'
import { materializeProject } from '../../packages/modcrafting-core/src/node.ts'
import { deriveResourceLayout } from '../../packages/modcrafting-core/src/resources/layout.ts'
import { getRegistry } from '../../packages/modcrafting-core/src/version/registry.ts'
import { matrix, resolveTarget } from '../../packages/modcrafting-core/src/version/targets.ts'
import type { ContentObject } from '../../packages/modcrafting-core/src/content-model.ts'

const registry = getRegistry()

const sample = (kind: typeof contentKinds[number], minecraft = '1.21.4'): ContentObject => {
  const value = newContentObject(kind, 'cap_test')
  value.id = `cap_test:probe_${kind}`
  value.displayName = 'Probe'
  void minecraft
  return value
}

test('every content capability matches what the generator actually does, across the whole matrix', () => {
  const mismatches: string[] = []
  for (const cell of registry.cells().filter((entry) => entry.loader === 'fabric')) {
    const layout = deriveResourceLayout(cell.minecraft, registry)
    const capabilities = capabilitiesFor({ loader: 'fabric', minecraft: cell.minecraft, release: cell.release, runtimeObserver: cell.runtimeObserver })
    for (const kind of contentKinds) {
      let threw = false
      try { generateContent(sample(kind, cell.minecraft), { layout }) } catch { threw = true }
      const said = capabilities.content[kind]
      if (said.state === 'blocked' && !threw) mismatches.push(`${cell.key} ${kind}: 能力表说 blocked 但生成成功`)
      if (said.state === 'available' && threw) mismatches.push(`${cell.key} ${kind}: 能力表说 available 但生成抛错`)
    }
  }
  assert.deepEqual(mismatches, [], '能力表必须与生成器行为一致，否则 Agent 会信错边界：\n' + mismatches.join('\n'))
})

test('createProject capability matches materialize for all 30 cells', async () => {
  const mismatches: string[] = []
  // A fresh checkout has no temp/ directory; mkdtemp does not create parents.
  mkdirSync(path.resolve('temp'), { recursive: true })
  const root = path.join(mkdtempSync(path.resolve('temp/capabilities-unit-')), 'projects')
  for (const cell of registry.cells()) {
    const capabilities = capabilitiesFor(resolveTarget(cell.loader, cell.minecraft))
    const destination = path.join(root, `${cell.loader}-${cell.minecraft}`)
    mkdirSync(destination, { recursive: true })
    let threw = false
    try { await materializeProject({ projectPath: destination, modId: 'cap_probe', modName: 'Cap Probe', target: resolveTarget(cell.loader, cell.minecraft) }) } catch { threw = true }
    if (capabilities.createProject.state === 'blocked' && !threw) mismatches.push(`${cell.key}: 能力表说 blocked 但物化成功`)
    if (capabilities.createProject.state === 'available' && !threw && !existsSync(path.join(destination, 'gradle.properties'))) mismatches.push(`${cell.key}: 物化未产出工程文件`)
  }
  assert.deepEqual(mismatches, [], '能力表必须与物化行为一致：\n' + mismatches.join('\n'))
})

test('build capability reflects probe evidence and names the missing toolchain', () => {
  for (const cell of registry.cells().filter((entry) => entry.loader === 'fabric')) {
    const capabilities = capabilitiesFor(resolveTarget(cell.loader, cell.minecraft))
    if (cell.release.build.evidence === 'probed') {
      assert.equal(capabilities.build.state, 'available', cell.key)
      assert.equal(capabilities.build.evidence, 'probed')
    }
    if (cell.release.javaTarget > 21) {
      assert.equal(capabilities.build.state, 'blocked', cell.key)
      assert.ok(capabilities.build.requires.some((requirement) => requirement.includes(`JDK ${cell.release.javaTarget}`)), cell.key)
    }
  }
})

test('runtime capability only exists where an observer runtime ships', () => {
  for (const summary of matrix()) {
    const capabilities = capabilitiesFor(resolveTarget(summary.loader, summary.minecraft))
    assert.equal(capabilities.runtimeTest.state, summary.runtimeObserver ? 'available' : 'blocked', summary.id)
  }
})

test('gui capability is available everywhere the draw-call dialect is implemented', () => {
  // Compile-proven on 1.20.1 (legacy drawTexture / 1-arg renderBackground) and
  // 1.21.4 (RenderLayer fn / 4-arg renderBackground): gui-codegen emits per profile.
  for (const cell of registry.cells().filter((entry) => entry.loader === 'fabric')) {
    const capabilities = capabilitiesFor({ loader: 'fabric', minecraft: cell.minecraft })
    assert.equal(capabilities.gui.state, 'available', `${cell.key}: 两个世代的绘制调用都已实现`)
  }
})
