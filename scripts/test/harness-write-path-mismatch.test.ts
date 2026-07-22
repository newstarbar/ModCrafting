import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import { Registry } from '../../src/renderer/src/harness/tools.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import {
  WorkflowEngine,
  orphanWriteArtifacts,
  successfulWriteArtifacts
} from '../../src/renderer/src/harness/workflow-engine.ts'
import type { ToolResult } from '../../src/renderer/src/harness/tools.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

function installWindow(api: Record<string, unknown>): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

const CLIENT = 'src/client/java/com/example/frame_cover/Frame_coverClient.java'
const SCREENSHOT = 'src/client/java/com/example/frame_cover/screenshot/ScreenshotManager.java'

test('orphanWriteArtifacts detects plan path vs actual write mismatch', () => {
  const step: WorkflowStep = {
    id: '2',
    title: '改 F6 打开 ConfigScreen',
    kind: 'write',
    status: 'running',
    allowedTools: ['edit_file', 'complete_step'],
    maxAttempts: 6,
    targetPath: CLIENT
  }
  const results: ToolResult[] = [
    {
      id: 'e1',
      toolName: 'edit_file',
      ok: true,
      output: `已编辑 ${SCREENSHOT}`,
      artifactPath: SCREENSHOT,
      artifactPaths: [SCREENSHOT],
      args: { path: SCREENSHOT }
    }
  ]
  assert.deepEqual(successfulWriteArtifacts(results), [SCREENSHOT])
  assert.deepEqual(orphanWriteArtifacts(step, results), [SCREENSHOT])
  assert.deepEqual(
    orphanWriteArtifacts(step, [
      ...results,
      {
        id: 'e2',
        toolName: 'edit_file',
        ok: true,
        output: `已编辑 ${CLIENT}`,
        artifactPath: CLIENT,
        artifactPaths: [CLIENT],
        args: { path: CLIENT }
      }
    ]),
    [],
    'matching target clears orphan list'
  )
})

test('complete_step adopts orphan write when plan targetPath was wrong', async () => {
  const restore = installWindow({
    exists: async () => false,
    listDirectory: async () => []
  })
  try {
    const registry = new Registry()
    registry.add({
      name: 'edit_file',
      description: 'edit',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' }
        },
        required: ['path', 'old_string', 'new_string']
      },
      readOnly: () => false,
      async execute(_ctx, args) {
        return `已编辑 ${args.path}`
      }
    })
    registry.add({
      name: 'complete_step',
      description: 'complete',
      schema: {
        type: 'object',
        properties: { stepId: { type: 'string' } },
        required: ['stepId']
      },
      readOnly: () => false,
      async execute() {
        return '[STEP_COMPLETE_REQUEST:1]'
      }
    })
    registry.add({
      name: 'read_file',
      description: 'read',
      schema: { type: 'object' },
      readOnly: () => true,
      async execute() {
        return 'ok'
      }
    })

    const tracker = PlanTracker.fromSteps([
      {
        id: '1',
        description: '将 F6 键绑定改为打开 ConfigScreen',
        status: 'pending',
        kind: 'write',
        targetPath: CLIENT,
        evidence: 'F6 打开 ConfigScreen'
      }
    ])
    const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 4 }))
    steps[0].status = 'pending'
    let round = 0
    const notices: string[] = []
    const engine = new WorkflowEngine({
      steps,
      planTracker: tracker,
      registry,
      projectPath: '/proj',
      emit: (ev) => {
        if (ev.kind === 'Notice' && ev.notice?.text) notices.push(ev.notice.text)
      },
      modelCall: async () => {
        round++
        if (round === 1) {
          return {
            text: '',
            reasoning: '',
            toolCalls: [
              {
                name: 'edit_file',
                args: {
                  path: SCREENSHOT,
                  old_string: 'MainMenuPreviewScreen.open',
                  new_string: 'new ConfigScreen(null)'
                }
              }
            ]
          }
        }
        return {
          text: '',
          reasoning: '',
          toolCalls: [{ name: 'complete_step', args: { stepId: '1' } }]
        }
      }
    })

    const result = await engine.run([])
    assert.equal(tracker.steps[0].status, 'completed', 'orphan edit + complete_step must advance')
    assert.equal(result.allDone, true)
    assert.ok(round <= 3, `should adopt within a few rounds, got ${round}`)
    assert.ok(
      notices.some((t) => /计划路径与实际写入不一致/.test(t)),
      'should emit path-mismatch adopt notice'
    )
  } finally {
    restore()
  }
})

test('complete_step without any write still does not advance (no orphan adopt)', async () => {
  const restore = installWindow({
    exists: async () => true,
    listDirectory: async () => []
  })
  try {
    const registry = new Registry()
    registry.add({
      name: 'complete_step',
      description: 'complete',
      schema: {
        type: 'object',
        properties: { stepId: { type: 'string' } },
        required: ['stepId']
      },
      readOnly: () => false,
      async execute() {
        return '[STEP_COMPLETE_REQUEST:1]'
      }
    })
    registry.add({
      name: 'read_file',
      description: 'read',
      schema: { type: 'object' },
      readOnly: () => true,
      async execute() {
        return 'ok'
      }
    })
    registry.add({
      name: 'edit_file',
      description: 'edit',
      schema: { type: 'object' },
      readOnly: () => false,
      async execute() {
        return 'edited'
      }
    })

    const tracker = PlanTracker.fromSteps([
      {
        id: '1',
        description: '修改 Frame_coverClient',
        status: 'pending',
        kind: 'write',
        targetPath: CLIENT,
        evidence: '已改'
      }
    ])
    const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 2 }))
    steps[0].status = 'pending'
    const engine = new WorkflowEngine({
      steps,
      planTracker: tracker,
      registry,
      projectPath: '/proj',
      emit: () => {},
      modelCall: async () => ({
        text: '',
        reasoning: '',
        toolCalls: [{ name: 'complete_step', args: { stepId: '1' } }]
      })
    })
    await engine.run([])
    assert.notEqual(tracker.steps[0].status, 'completed')
  } finally {
    restore()
  }
})
