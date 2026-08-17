import assert from 'node:assert/strict'
import test from 'node:test'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import {
  GAME_TEST_WORLD,
  createRuntimePaths,
  isAllowedBridgeApiPath,
  scaffoldFabricProject,
  testVerdict,
  validateFabricProject,
  validateGameTestSpec
} from '../../packages/modcrafting-core/src/index.ts'

test('shared core exposes the deterministic Observer and game-test contracts without Electron', () => {
  assert.equal(isAllowedBridgeApiPath('/v2/snapshot'), true)
  assert.equal(isAllowedBridgeApiPath('/v1/input'), true)
  assert.equal(isAllowedBridgeApiPath('/api/delete-everything'), false)
  assert.equal(testVerdict([{ passed: true }]), 'PASS')
  assert.equal(testVerdict([{ passed: false }]), 'FAIL')
  assert.equal(testVerdict([{ passed: true, unavailable: true }]), 'INCONCLUSIVE')
  const parsed = validateGameTestSpec({ version: 2, id: 'test_item', featureType: 'new_item', subject: {}, setup: [], actions: [], assertions: [{ type: 'inventory_contains', itemId: 'minecraft:stone' }], cleanup: [] })
  assert.equal(parsed.ok, true)
  assert.equal(GAME_TEST_WORLD, 'ModCrafting Test World')
})

test('system-toolchain project inspection does not create a wrapper or download toolchain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modcrafting-plugin-'))
  try {
    const project = await scaffoldFabricProject(path.join(root, 'example'), 'example_mod', 'Example Mod')
    assert.equal(project.modId, 'example_mod')
    const validation = validateFabricProject(project.path)
    assert.equal(validation.checks.wrapper, false)
    assert.equal(existsSync(path.join(project.path, 'gradlew.bat')), false)
    const paths = createRuntimePaths(path.join(root, 'plugin-data'))
    assert.equal(paths.knowledgeRoot.endsWith('knowledge'), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
