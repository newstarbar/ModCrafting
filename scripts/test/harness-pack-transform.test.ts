import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addPackEntries, createPack } from '../../packages/modcrafting-core/src/pack/pack-workspace.ts'
import { createZip, readZip } from '../../packages/modcrafting-core/src/pack/zip.ts'
import { transformAction } from '../../packages/modcrafting-core/src/pack/transform/transform-actions.ts'
import { readTransformAudit } from '../../packages/modcrafting-core/src/pack/transform/trust.ts'
import type { PackLicense } from '../../packages/modcrafting-core/src/workspace-model.ts'

const generatedAt = '2026-11-23T00:00:00.000Z'
const jarBytes = createZip([
  { path: 'fabric.mod.json', data: JSON.stringify({ schemaVersion: 1, id: 'examplemod', version: '1.0.0' }) },
  { path: 'examplemod.mixins.json', data: JSON.stringify({ package: 'com.example.mixin', mixins: [] }) },
  { path: 'assets/example/lang/en_us.json', data: '{"item.example.name":"Example"}' },
  { path: 'assets/example/textures/item/icon.png', data: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x01, 0x02]) },
  { path: 'com/example/Example.class', data: Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]) },
  { path: 'com/example/Other.class', data: Buffer.from([0xCA, 0xFE, 0xBA, 0xBF]) }
])
const sha1 = createHash('sha1').update(jarBytes).digest('hex')
const sha512 = createHash('sha512').update(jarBytes).digest('hex')

function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-transform-'))
  return run(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

async function setup(root: string, license: PackLicense = { id: 'MIT', redistributable: true }) {
  let workspace = createPack(root, { name: 'Transform Pack', targetId: 'fabric@1.21.4' })
  mkdirSync(path.join(root, 'mods'), { recursive: true })
  writeFileSync(path.join(root, 'mods', 'example-1.0.jar'), jarBytes)
  workspace = addPackEntries(root, {
    entries: [{
      entryId: 'example',
      fileName: 'example-1.0.jar',
      source: 'local',
      hashes: { sha1, sha512 },
      license,
      enabled: true
    }],
    expectedRevision: workspace.revision
  }).workspace
  return workspace
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (cause) {
    return (cause as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_ERROR'
}

test('L1 builds a resource overlay with replacements and copied source assets', async () => {
  await withRoot(async (root) => {
    await setup(root)
    const result = await transformAction({
      action: 'apply', level: 'L1', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      operations: [
        { path: 'assets/example/lang/en_us.json', text: '{"item.example.name":"Renamed"}' },
        { path: 'assets/example/textures/item/icon.png', copy: true }
      ]
    }) as { transformId: string; zip: string; output: string; exportable: boolean; files: string[] }

    assert.match(result.transformId, /^example-l1-[a-f0-9]{12}$/)
    assert.equal(result.exportable, true)
    const zip = readZip(readFileSync(result.zip))
    assert.deepEqual(zip.map((row) => row.path), [
      'assets/example/lang/en_us.json',
      'assets/example/textures/item/icon.png',
      'modcrafting.transform.json',
      'pack.mcmeta'
    ])
    assert.equal(zip.find((row) => row.path === 'assets/example/lang/en_us.json')!.data.toString('utf8'), '{"item.example.name":"Renamed"}')
    assert.deepEqual(
      zip.find((row) => row.path === 'assets/example/textures/item/icon.png')!.data,
      readZip(jarBytes).find((row) => row.path === 'assets/example/textures/item/icon.png')!.data
    )
    const manifest = JSON.parse(readFileSync(path.join(result.output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.level, 'L1')
    assert.equal(manifest.source.sha1, sha1)
    assert.equal(manifest.decision.exportable, true)
    assert.equal(readTransformAudit(root).at(-1)?.action, 'apply')
  })
})

test('a non-redistributable source still transforms locally but the product is marked non-exportable', async () => {
  await withRoot(async (root) => {
    await setup(root, { id: 'All-Rights-Reserved', redistributable: false })
    const result = await transformAction({
      action: 'apply', level: 'L1', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      operations: [{ path: 'assets/example/lang/en_us.json', text: '{}' }]
    }) as { exportable: boolean; output: string }
    assert.equal(result.exportable, false)
    const manifest = JSON.parse(readFileSync(path.join(result.output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.decision.exportable, false)
    assert.ok(manifest.decision.reasons.some((reason: string) => /非再分发|导出/.test(reason)))
  })
})

test('a jar whose bytes no longer match the lock is refused and audited', async () => {
  await withRoot(async (root) => {
    await setup(root)
    writeFileSync(path.join(root, 'mods', 'example-1.0.jar'), Buffer.from('tampered'))
    assert.equal(await codeOf(() => transformAction({
      action: 'apply', level: 'L1', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      operations: [{ path: 'assets/example/lang/en_us.json', text: '{}' }]
    })), 'TRANSFORM_HASH_MISMATCH')
    const audit = readTransformAudit(root)
    assert.equal(audit.at(-1)?.action, 'refuse')
    assert.equal(audit.at(-1)?.decision.code, 'TRANSFORM_HASH_MISMATCH')
  })
})

test('L2 generates a companion mixin project and rollback removes it only when asked', async () => {
  await withRoot(async (root) => {
    await setup(root)
    const projectPath = path.join(root, 'companions', 'exampletweaks')
    const result = await transformAction({
      action: 'apply', level: 'L2', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      companion: {
        projectPath,
        modId: 'exampletweaks',
        modName: 'Example Tweaks',
        sourceModId: 'examplemod',
        targets: [{ className: 'com.example.ExampleMod', method: 'onInitialize' }]
      }
    }) as { transformId: string; output: string; files: string[] }
    assert.equal(result.output, projectPath)

    const metadata = JSON.parse(readFileSync(path.join(projectPath, 'src/main/resources/fabric.mod.json'), 'utf8'))
    assert.equal(metadata.id, 'exampletweaks')
    assert.equal(metadata.depends.examplemod, '*')
    assert.deepEqual(metadata.mixins, [{ config: 'exampletweaks.mixins.json', environment: '*' }])

    const mixins = JSON.parse(readFileSync(path.join(projectPath, 'src/main/resources/exampletweaks.mixins.json'), 'utf8'))
    assert.deepEqual(mixins.mixins, ['TargetMixin1'])
    const mixin = readFileSync(path.join(projectPath, 'src/main/java/com/modcrafting/exampletweaks/mixin/TargetMixin1.java'), 'utf8')
    assert.match(mixin, /@Mixin\(targets = "com\.example\.ExampleMod"\)/)
    assert.match(mixin, /method = "onInitialize"/)
    assert.ok(existsSync(path.join(projectPath, '.modcrafting-transform.json')))

    const rolled = await transformAction({ action: 'rollback', workspacePath: root, transformId: result.transformId, deleteProject: true }) as { removed: boolean }
    assert.equal(rolled.removed, true)
    assert.equal(existsSync(projectPath), false)
    assert.equal(existsSync(result.output), false)
    assert.equal(readTransformAudit(root).at(-1)?.action, 'rollback')
    assert.equal(await codeOf(() => transformAction({ action: 'rollback', workspacePath: root, transformId: result.transformId })), 'TRANSFORM_NOT_FOUND')
  })
})

test('L3 and L4 refuse without licence permission or consent, and record the refusal', async () => {
  await withRoot(async (root) => {
    await setup(root, { id: 'All-Rights-Reserved', redistributable: false })
    assert.equal(await codeOf(() => transformAction({
      action: 'apply', level: 'L3', workspacePath: root, entryId: 'example', consent: true, generatedAt,
      patches: [{ className: 'com.example.Example', method: 'tick', description: 'inject' }]
    })), 'TRANSFORM_LICENSE_BLOCKED')
    assert.equal(readTransformAudit(root).at(-1)?.decision.code, 'TRANSFORM_LICENSE_BLOCKED')
    assert.equal(await codeOf(() => transformAction({
      action: 'apply', level: 'L4', workspacePath: root, entryId: 'example', consent: true, generatedAt, maxClasses: 100
    })), 'TRANSFORM_LICENSE_BLOCKED')
  })
})

test('L3 with permission produces a plan and never writes a patched jar; L4 lists classes only', async () => {
  await withRoot(async (root) => {
    await setup(root)
    assert.equal(await codeOf(() => transformAction({
      action: 'apply', level: 'L3', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      patches: [{ className: 'com.example.Example', method: 'tick', description: 'inject' }]
    })), 'TRANSFORM_CONSENT_REQUIRED')
    assert.equal(readTransformAudit(root).at(-1)?.decision.code, 'TRANSFORM_CONSENT_REQUIRED')

    const l3 = await transformAction({
      action: 'apply', level: 'L3', workspacePath: root, entryId: 'example', consent: true, generatedAt,
      patches: [{ className: 'com.example.Example', method: 'tick', description: 'inject' }]
    }) as { applied: boolean; plan: string; exportable: boolean }
    assert.equal(l3.applied, false, 'no bytecode engine ships; a plan is not a patched jar')
    assert.equal(l3.exportable, true)
    const plan = JSON.parse(readFileSync(l3.plan, 'utf8'))
    assert.equal(plan.engine, 'not-shipped')
    assert.deepEqual(plan.patches, [{ className: 'com.example.Example', method: 'tick', description: 'inject' }])

    const l4 = await transformAction({
      action: 'apply', level: 'L4', workspacePath: root, entryId: 'example', consent: true, generatedAt, maxClasses: 100
    }) as { analysis: string; classes: number; exportable: boolean }
    assert.equal(l4.exportable, false)
    const analysis = JSON.parse(readFileSync(l4.analysis, 'utf8'))
    assert.equal(analysis.classes.length, 2)
    assert.deepEqual(analysis.classes.map((row: { name: string }) => row.name).sort(), ['com.example.Example', 'com.example.Other'])
    assert.equal(analysis.decompiler, 'not-shipped')
  })
})

test('rollback removes an L1 overlay and its record', async () => {
  await withRoot(async (root) => {
    await setup(root)
    const result = await transformAction({
      action: 'apply', level: 'L1', workspacePath: root, entryId: 'example', consent: false, generatedAt,
      operations: [{ path: 'assets/example/lang/en_us.json', text: '{}' }]
    }) as { transformId: string; output: string }
    await transformAction({ action: 'rollback', workspacePath: root, transformId: result.transformId })
    assert.equal(existsSync(result.output), false)
    assert.equal(readTransformAudit(root).at(-1)?.action, 'rollback')
  })
})
