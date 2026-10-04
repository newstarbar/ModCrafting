import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBuildReport } from '../../src/main/build-report.ts'
import { inspectProjectProfile } from '../../src/main/project-profile.ts'
import { WorkspaceManager } from '../../src/main/workspace-manager.ts'
import { CheckpointStore } from '../../src/main/checkpoint-store.ts'
import { compareDiagnosticProgress } from '../../src/shared/harness-diagnostics.ts'
import type { TaskCheckpoint } from '../../src/shared/harness-runtime.ts'
import { KnowledgeFactCache } from '../../src/renderer/src/harness/knowledge-fact-cache.ts'
import { probeModelCapabilities } from '../../src/renderer/src/harness/model-adapter.ts'

test('BuildReport normalizes English, Chinese and Mixin diagnostics', () => {
  const report = createBuildReport({
    projectPath: 'C:/demo/mod',
    task: 'compileJava',
    exitCode: 1,
    output: [
      '> Task :compileJava FAILED',
      'C:\\demo\\mod\\src\\main\\java\\demo\\Mod.java:18: error: cannot find symbol',
      '  symbol:   class MissingThing',
      'src/main/java/demo/Other.java:9: 错误: 找不到符号',
      'org.spongepowered.asm.mixin.transformer.throwables.MixinApplyError: InvalidInjectionException'
    ].join('\n')
  })
  assert.equal(report.ok, false)
  assert.ok(report.diagnostics.some((item) => item.file?.endsWith('src/main/java/demo/Mod.java')))
  assert.ok(report.diagnostics.some((item) => item.message.includes('找不到符号')))
  assert.ok(report.diagnostics.some((item) => item.stage === 'mixin'))
  assert.ok(report.diagnostics.every((item) => item.id.length > 0))
})

test('BuildReport parses Gradle Problems HTML and retains a stable root diagnostic', () => {
  const report = createBuildReport({
    projectPath: 'C:/demo/mod',
    task: 'build',
    exitCode: 1,
    output: '<html><body><div>C:/demo/mod/src/main/java/demo/Mod.java:22: error: cannot find symbol</div><div>symbol: class MissingThing</div></body></html>'
  })
  assert.equal(report.ok, false)
  assert.ok(report.diagnostics.some((item) => item.stage === 'java_compile'))
  assert.ok(report.diagnostics[0]?.rootCauseId)
})

test('diagnostic progress recognizes root resolution and stage advancement', () => {
  const progress = compareDiagnosticProgress(
    [{ id: 'root', stage: 'java_compile', responsibility: 'generated_code', message: 'root', normalizedMessage: 'root', raw: 'root' }],
    [{ id: 'downstream', stage: 'java_compile', responsibility: 'generated_code', message: 'downstream', normalizedMessage: 'downstream', raw: 'downstream' }]
  )
  assert.equal(progress.resolvedIds.length, 1)
  assert.equal(progress.newIds.length, 1)
  assert.equal(progress.progressed, true)
})

test('ProjectProfile finds split source sets, Fabric metadata and custom tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-profile-'))
  try {
    await mkdir(path.join(root, 'src/main/resources'), { recursive: true })
    await mkdir(path.join(root, 'src/client/java/demo'), { recursive: true })
    await writeFile(path.join(root, 'gradle.properties'), 'minecraft_version=1.21.4\nyarn_mappings=1.21.4+build.8\nloader_version=0.16.10\n')
    await writeFile(path.join(root, 'build.gradle'), [
      'plugins { id "fabric-loom" version "1.9.2" }',
      'loom { splitEnvironmentSourceSets() }',
      'sourceSets { client { } }',
      'dependencies { modImplementation "net.fabricmc.fabric-api:fabric-api:0.119.0+1.21.4" }',
      'tasks.register("verifyMod") { }'
    ].join('\n'))
    await writeFile(path.join(root, 'src/main/resources/fabric.mod.json'), JSON.stringify({ id: 'demo_mod', entrypoints: { main: ['demo.Main'], client: ['demo.Client'] }, mixins: ['demo.mixins.json'], access_wideners: ['demo.accesswidener'] }))
    await writeFile(path.join(root, 'src/client/java/demo/Client.java'), 'package demo; class Client {}')
    const profile = inspectProjectProfile(root, { symbolIndex: { available: true, classes: 42 } })
    assert.equal(profile.minecraftVersion, '1.21.4')
    assert.equal(profile.splitEnvironment, true)
    assert.deepEqual(profile.entrypoints.client, ['demo.Client'])
    assert.ok(profile.sourceSets.includes('client'))
    assert.ok(profile.gradleTasks.includes('verifyMod'))
    assert.equal(profile.symbolIndex.classes, 42)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('WorkspaceManager promotes atomically and detects concurrent edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-workspace-'))
  const dataRoot = path.join(root, '.appdata')
  const project = path.join(root, 'project')
  try {
    await mkdir(project, { recursive: true })
    await writeFile(path.join(project, 'README.md'), 'baseline')
    const manager = new WorkspaceManager({ dataRoot })
    const workspace = await manager.create(project, 'task-test')
    await writeFile(path.join(workspace.shadowPath, 'README.md'), 'candidate')
    const promoted = await manager.promote(workspace.id)
    assert.equal(promoted.ok, true)
    assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'candidate')

    const second = await manager.create(project, 'task-test-2')
    await writeFile(path.join(second.shadowPath, 'README.md'), 'candidate-2')
    await writeFile(path.join(project, 'README.md'), 'user-edit')
    const conflict = await manager.promote(second.id)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.status, 'promotion_conflict')
    assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'user-edit')
    const reloaded = new WorkspaceManager({ dataRoot })
    const persisted = await reloaded.get(second.id)
    assert.equal(persisted.status, 'promotion_conflict')

    const third = await reloaded.create(project, 'task-test-3')
    await writeFile(path.join(third.shadowPath, 'README.md'), 'candidate-3')
    assert.equal((await reloaded.promote(third.id)).ok, true)
    const afterRestart = new WorkspaceManager({ dataRoot })
    await afterRestart.rollback(third.id)
    assert.equal(await readFile(path.join(project, 'README.md'), 'utf8'), 'user-edit')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('KnowledgeFactCache is version-scoped and provider capabilities are deterministic', () => {
  const cache = new KnowledgeFactCache()
  const key = cache.key('profile-a', 'fabric_javadoc', 'Registry.register')
  cache.set(key, 'fact')
  assert.equal(cache.get(key), 'fact')
  assert.equal(cache.has(cache.key('profile-b', 'fabric_javadoc', 'Registry.register')), false)
  const caps = probeModelCapabilities('https://api.example.test/v1', 'glm-5.2')
  assert.equal(caps.streaming, true)
  assert.equal(caps.reasoning, true)
  assert.equal(caps.jsonSchema, true)
})

test('CheckpointStore atomically round-trips the paused repair state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modcrafting-checkpoint-'))
  try {
    const store = new CheckpointStore(root)
    const report = createBuildReport({ projectPath: 'C:/demo/mod', task: 'compileJava', exitCode: 1, output: 'src/main/java/demo/Mod.java:4: error: cannot find symbol' })
    const checkpoint: TaskCheckpoint = {
      version: 1,
      taskId: 'task-recover',
      workspace: { version: 1, id: 'ws-recover', userProjectPath: 'C:/demo/mod', shadowPath: 'C:/app/ws-recover/project', baseline: [], createdAt: Date.now(), status: 'paused', patchJournal: [] },
      state: 'PAUSED',
      stage: 'compile_check',
      diagnosticIds: report.diagnostics.map((item) => item.id),
      resolvedDiagnosticIds: [],
      lastBuildReport: report,
      repairProposals: [],
      fallbackIndex: 1,
      budgets: { repairProposals: 2, modelRounds: 7, toolCalls: 12, startedAt: Date.now() },
      updatedAt: Date.now(),
      knowledgeFactKeys: ['profile|fabric_javadoc|registry'],
      knowledgeFacts: [{ key: 'profile|fabric_javadoc|registry', value: 'Registry.register signature' }]
    }
    await store.save(checkpoint)
    const restored = await store.load('task-recover')
    assert.equal(restored?.state, 'PAUSED')
    assert.equal(restored?.budgets.modelRounds, 7)
    assert.equal(restored?.lastBuildReport?.diagnostics[0]?.id, report.diagnostics[0]?.id)
    assert.deepEqual(restored?.knowledgeFactKeys, checkpoint.knowledgeFactKeys)
    assert.equal(restored?.knowledgeFacts?.[0]?.value, 'Registry.register signature')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
