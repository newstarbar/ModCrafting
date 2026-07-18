import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../src/renderer/src/harness/plan-tracker.ts'
import { Registry } from '../src/renderer/src/harness/tools.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import {
  WorkflowEngine,
  isNoOpBuildResult,
  MAX_IDENTICAL_REJECTIONS
} from '../src/renderer/src/harness/workflow-engine.ts'
import { findFilesByBasename } from '../src/renderer/src/harness/grep-search.ts'

type DirEntry = { name: string; isDirectory: boolean }

function installWindow(api: Record<string, unknown>): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

// ── Fix 1: read_file / grep are always offered on write & build steps ──

test('Fix 1: write & build steps offer read_file and grep', () => {
  const steps = normalizeWorkflowSteps([
    { id: '1', description: '修改 src/main/java/A.java', status: 'pending', kind: 'write', targetPath: 'src/main/java/A.java' },
    { id: '2', description: '构建项目（gradlew build）', status: 'pending' }
  ])
  const write = steps.find((s) => s.kind === 'write')!
  const build = steps.find((s) => s.kind === 'build')!
  for (const tool of ['read_file', 'grep']) {
    assert.ok(write.allowedTools.includes(tool), `write step must offer ${tool}`)
    assert.ok(build.allowedTools.includes(tool), `build step must offer ${tool}`)
  }
})

// ── Fix 3: no-op build detection ──

test('Fix 3: isNoOpBuildResult flags all-UP-TO-DATE builds', () => {
  const noop = [
    '> Task :compileJava UP-TO-DATE',
    '> Task :compileClientJava UP-TO-DATE',
    '> Task :jar UP-TO-DATE',
    'BUILD SUCCESSFUL in 15s'
  ].join('\n')
  assert.equal(isNoOpBuildResult(noop), true)
})

test('Fix 3: isNoOpBuildResult returns false when a task actually ran', () => {
  const real = [
    '> Task :compileJava',
    '> Task :classes UP-TO-DATE',
    'BUILD SUCCESSFUL in 20s'
  ].join('\n')
  assert.equal(isNoOpBuildResult(real), false)
  assert.equal(isNoOpBuildResult('BUILD FAILED'), false)
})

// ── Fix 5: loop guard constant ──

test('Fix 5: MAX_IDENTICAL_REJECTIONS is a small finite guard', () => {
  assert.equal(MAX_IDENTICAL_REJECTIONS, 4)
})

// ── Fix 2: fresh write step over an existing file must not auto-complete ──

function buildWriteEngine(status: 'pending' | 'running', modelRounds: () => { name: string; args: Record<string, unknown> }[][]) {
  const registry = new Registry()
  registry.add({
    name: 'read_file', description: 'read', schema: { type: 'object' }, readOnly: () => true,
    async execute() { return 'file: One.java\n1 | class One {}' }
  })
  registry.add({
    name: 'complete_step', description: 'complete',
    schema: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
    readOnly: () => false,
    async execute() { return '[STEP_COMPLETE_REQUEST:1]' }
  })
  registry.add({
    name: 'write_file', description: 'write',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    readOnly: () => false,
    async execute(_ctx, args) { return `已写入: ${args.path}` }
  })

  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '修改 src/main/java/One.java', status, kind: 'write', targetPath: 'src/main/java/One.java', evidence: '文件已写入' }
  ])
  const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 2 }))
  // normalizeWorkflowSteps resets status; restore the intended one for the resume case.
  steps[0].status = status
  const rounds = modelRounds()
  let round = 0
  const engine = new WorkflowEngine({
    steps,
    planTracker: tracker,
    registry,
    projectPath: '/proj',
    emit: () => {},
    modelCall: async () => {
      const toolCalls = rounds[Math.min(round, rounds.length - 1)]
      round++
      return { text: '', reasoning: '', toolCalls }
    }
  })
  return { engine, tracker }
}

test('Fix 2: fresh write step over existing file does NOT complete without a real write', async () => {
  const restore = installWindow({
    exists: async () => true,
    listDirectory: async () => [] as DirEntry[]
  })
  try {
    const { engine, tracker } = buildWriteEngine('pending', () => [
      [{ name: 'complete_step', args: { stepId: '1' } }]
    ])
    const result = await engine.run([])
    assert.equal(result.allDone, false, 'run must not report all-done')
    assert.notEqual(tracker.steps[0].status, 'completed', 'step must not complete without a write')
  } finally {
    restore()
  }
})

test('Fix 2: real write lets a fresh write step complete', async () => {
  const restore = installWindow({
    exists: async () => true,
    listDirectory: async () => [] as DirEntry[]
  })
  try {
    const { engine, tracker } = buildWriteEngine('pending', () => [
      [
        { name: 'write_file', args: { path: 'src/main/java/One.java', content: 'class One {}' } },
        { name: 'complete_step', args: { stepId: '1' } }
      ]
    ])
    await engine.run([])
    assert.equal(tracker.steps[0].status, 'completed')
  } finally {
    restore()
  }
})

test('Fix 2: resumed (running) write step trusts disk evidence for existing file', async () => {
  const restore = installWindow({
    exists: async () => true,
    listDirectory: async () => [] as DirEntry[]
  })
  try {
    const { engine, tracker } = buildWriteEngine('running', () => [
      [{ name: 'complete_step', args: { stepId: '1' } }]
    ])
    await engine.run([])
    assert.equal(tracker.steps[0].status, 'completed', 'resumed step may complete from disk evidence')
  } finally {
    restore()
  }
})

// ── Fix 4: read_file ENOENT fallback ──

test('Fix 4: findFilesByBasename locates a file across src/', async () => {
  const tree: Record<string, DirEntry[]> = {
    '/proj/src': [{ name: 'client', isDirectory: true }, { name: 'main', isDirectory: true }],
    '/proj/src/client': [{ name: 'java', isDirectory: true }],
    '/proj/src/client/java': [{ name: 'right', isDirectory: true }],
    '/proj/src/client/java/right': [{ name: 'Bar.java', isDirectory: false }],
    '/proj/src/main': []
  }
  const restore = installWindow({
    listDirectory: async (p: string) => tree[p.replace(/\\/g, '/')] || []
  })
  try {
    const found = await findFilesByBasename('/proj', 'Bar.java')
    assert.deepEqual(found, ['src/client/java/right/Bar.java'])
  } finally {
    restore()
  }
})
