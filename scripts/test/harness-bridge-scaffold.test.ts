import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPack } from '../../packages/modcrafting-core/src/pack/pack-workspace.ts'
import { bridgeScaffold } from '../../packages/modcrafting-core/src/pack/bridge-scaffold.ts'

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-bridge-'))
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return (cause as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_ERROR'
}

const request = (workspacePath: string, projectPath: string) => ({
  workspacePath,
  projectPath,
  modId: 'coolbridge',
  modName: 'Cool Bridge',
  sourceModId: 'sourcemod',
  sourceModName: 'Source Mod',
  targetModId: 'targetmod',
  targetModName: 'Target Mod'
})

test('the scaffold writes a complete Fabric bridge project for the pack target', async () => {
  await withRoot(async (root) => {
    createPack(root, { name: 'Bridge Pack', targetId: 'fabric@1.21.4' })
    const projectPath = path.join(root, 'bridges', 'coolbridge')
    const result = await bridgeScaffold(request(root, projectPath)) as {
      projectPath: string
      packageName: string
      entrypoint: string
      mixinConfig: string
      files: string[]
    }

    assert.equal(result.packageName, 'com.modcrafting.coolbridge')
    assert.equal(result.entrypoint, 'com.modcrafting.coolbridge.BridgeMod')
    assert.equal(result.mixinConfig, 'bridge.mixins.json')
    for (const relative of [
      'build.gradle', 'settings.gradle', 'gradle.properties',
      'src/main/resources/fabric.mod.json',
      'src/main/resources/bridge.mixins.json',
      'src/main/java/com/modcrafting/coolbridge/BridgeMod.java',
      'src/main/java/com/modcrafting/coolbridge/BridgeAdapter.java',
      'src/main/java/com/modcrafting/coolbridge/ExampleBridgeAdapter.java',
      'src/main/java/com/modcrafting/coolbridge/mixin/MinecraftServerMixin.java'
    ]) {
      assert.ok(existsSync(path.join(projectPath, ...relative.split('/'))), `missing ${relative}`)
    }
    assert.deepEqual(result.files.slice().sort(), result.files, 'the file list must be stable')

    const metadata = JSON.parse(readFileSync(path.join(projectPath, 'src/main/resources/fabric.mod.json'), 'utf8'))
    assert.equal(metadata.id, 'coolbridge')
    assert.deepEqual(metadata.entrypoints.main, ['com.modcrafting.coolbridge.BridgeMod'])
    assert.deepEqual(metadata.mixins, [{ config: 'bridge.mixins.json', environment: '*' }])
    assert.equal(metadata.recommends.sourcemod, '*')
    assert.equal(metadata.recommends.targetmod, '*')
    assert.match(metadata.depends.minecraft, /1\.21\.4/)

    const mixins = JSON.parse(readFileSync(path.join(projectPath, 'src/main/resources/bridge.mixins.json'), 'utf8'))
    assert.equal(mixins.package, 'com.modcrafting.coolbridge.mixin')
    assert.deepEqual(mixins.mixins, ['MinecraftServerMixin'])
    assert.equal(mixins.compatibilityLevel, 'JAVA_21')

    const main = readFileSync(path.join(projectPath, 'src/main/java/com/modcrafting/coolbridge/BridgeMod.java'), 'utf8')
    assert.match(main, /ServerLifecycleEvents\.SERVER_STARTING/)
    assert.match(main, /CommandRegistrationCallback\.EVENT/)
    assert.match(main, /isModLoaded\(SOURCE_MOD_ID\)/)
    assert.match(main, /isModLoaded\(TARGET_MOD_ID\)/)
    assert.match(main, /coolbridge-status/)

    const adapter = readFileSync(path.join(projectPath, 'src/main/java/com/modcrafting/coolbridge/BridgeAdapter.java'), 'utf8')
    assert.match(adapter, /void onRegister\(\)/)
    assert.match(adapter, /void onServerStarting\(MinecraftServer server\)/)

    const mixin = readFileSync(path.join(projectPath, 'src/main/java/com/modcrafting/coolbridge/mixin/MinecraftServerMixin.java'), 'utf8')
    assert.match(mixin, /@Mixin\(MinecraftServer\.class\)/)
    assert.match(mixin, /@Inject\(method = "shutdown"/)
  })
})

test('scaffolding is deterministic and never overwrites an existing directory', async () => {
  await withRoot(async (root) => {
    createPack(root, { name: 'Bridge Pack', targetId: 'fabric@1.21.4' })
    const first = path.join(root, 'bridges', 'one')
    const second = path.join(root, 'bridges', 'two')
    await bridgeScaffold(request(root, first))
    await bridgeScaffold(request(root, second))
    for (const relative of ['src/main/java/com/modcrafting/coolbridge/BridgeMod.java', 'src/main/resources/bridge.mixins.json', 'build.gradle']) {
      assert.equal(
        readFileSync(path.join(first, ...relative.split('/')), 'utf8'),
        readFileSync(path.join(second, ...relative.split('/')), 'utf8'),
        `${relative} must not depend on the destination path`
      )
    }

    const main = path.join(first, 'src/main/java/com/modcrafting/coolbridge/BridgeMod.java')
    writeFileSync(main, '// edited by the user\n', 'utf8')
    assert.equal(await codeOf(() => bridgeScaffold(request(root, first))), 'BRIDGE_PATH_NOT_EMPTY')
    assert.equal(readFileSync(main, 'utf8'), '// edited by the user\n')
  })
})

test('the scaffold refuses non-Fabric packs, missing packs, and writing into mods/', async () => {
  await withRoot(async (root) => {
    assert.equal(await codeOf(() => bridgeScaffold(request(root, path.join(root, 'bridge')))), 'PACK_NOT_FOUND')

    createPack(root, { name: 'Neo Pack', targetId: 'neoforge@1.21.4' })
    assert.equal(await codeOf(() => bridgeScaffold(request(root, path.join(root, 'bridge')))), 'BRIDGE_FABRIC_ONLY')
  })

  await withRoot(async (root) => {
    createPack(root, { name: 'Bridge Pack', targetId: 'fabric@1.21.4' })
    mkdirSync(path.join(root, 'mods'), { recursive: true })
    assert.equal(await codeOf(() => bridgeScaffold(request(root, path.join(root, 'mods', 'coolbridge')))), 'BRIDGE_PATH_FORBIDDEN')
    assert.deepEqual(readdirSync(path.join(root, 'mods')), [], 'nothing may be written into the installed mods directory')
  })
})
