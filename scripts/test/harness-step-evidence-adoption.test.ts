import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import { Registry, type ToolResult } from '../../src/renderer/src/harness/tools.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import {
  WorkflowEngine,
  buildStepFailureMessage,
  missingWriteEvidencePaths,
  stepEvidenceSatisfied
} from '../../src/renderer/src/harness/workflow-engine.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

const MIXIN_SRC = 'src/main/java/com/example/mixin/ShulkerBulletMixin.java'
const MIXINS_JSON = 'src/main/resources/modcrafting.mixins.json'

function installWindow(api: Record<string, unknown>): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

function step(id: string, overrides: Partial<WorkflowStep>): WorkflowStep {
  return {
    id,
    title: overrides.title || overrides.description || `step ${id}`,
    kind: 'write',
    status: 'running',
    allowedTools: ['write_file', 'edit_file', 'complete_step', 'fabric_mixin_register', 'fabric_mixin_validate', 'read_file'],
    maxAttempts: 6,
    ...overrides
  } as WorkflowStep
}

function registerTool(name: string, args: Record<string, unknown> = {}) {
  return { name, args }
}

function mixinRegistry(written: string[]): Registry {
  const registry = new Registry()
  registry.add({
    name: 'fabric_mixin_register',
    description: 'register mixin config',
    schema: { type: 'object', properties: { sourcePath: { type: 'string' } }, required: ['sourcePath'] },
    readOnly: () => false,
    async execute() {
      written.push(MIXINS_JSON)
      return { output: `已将 ShulkerBulletMixin 注册到 ${MIXINS_JSON}`, artifactPaths: [MIXINS_JSON] }
    }
  })
  registry.add({
    name: 'fabric_mixin_validate',
    description: 'validate mixin',
    schema: { type: 'object', properties: { sourcePath: { type: 'string' } }, required: ['sourcePath'] },
    readOnly: () => true,
    async execute() {
      return {
        output: 'Mixin 轻量校验通过',
        validation: { kind: 'mixin', valid: true, version: '1.21.4', targetPath: MIXIN_SRC, checkedAt: 1 }
      }
    }
  })
  registry.add({
    name: 'complete_step',
    description: 'complete',
    schema: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
    readOnly: () => false,
    async execute(_ctx, args) {
      return `[STEP_COMPLETE_REQUEST:${args.stepId}]`
    }
  })
  registry.add({
    name: 'ask_clarification',
    description: 'ask',
    schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    readOnly: () => true,
    async execute() {
      return '[CLARIFICATION_NEEDED]'
    }
  })
  registry.add({
    name: 'fabric_mod_json_validate',
    description: 'validate fabric.mod.json',
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    readOnly: () => true,
    async execute() {
      // Reproduces the log: the validator reports success but produces neither a
      // structured validation nor an artifact path, so it can never satisfy evidence.
      return { output: 'ok' }
    }
  })
  registry.add({
    name: 'read_file',
    description: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    readOnly: () => true,
    async execute() {
      return 'ok'
    }
  })
  return registry
}

test('write evidence accepts a path an earlier step of the same run wrote', () => {
  const target = step('2', { targetPath: MIXINS_JSON })
  assert.equal(stepEvidenceSatisfied(target, [], [MIXINS_JSON]), true, 'run-scoped artifact is admissible')
  assert.equal(stepEvidenceSatisfied(target, [], []), false, 'no artifact is still no evidence')
  assert.deepEqual(missingWriteEvidencePaths(target, [], [MIXINS_JSON]), [])
  assert.deepEqual(missingWriteEvidencePaths(target, [], []), [MIXINS_JSON])
})

test('a file that only exists on disk never counts as adopted write evidence', async () => {
  const written: string[] = []
  const restore = installWindow({
    // The register tool from step #1 already landed the config, so the target exists.
    exists: async () => true,
    listDirectory: async () => [],
    readFile: async () => ({ success: false })
  })
  try {
    const registry = mixinRegistry(written)
    const tracker = PlanTracker.fromSteps([
      { id: '1', description: '实现 ShulkerBulletMixin 并注册', status: 'pending', kind: 'mixin', targetPath: MIXIN_SRC, evidence: 'Mixin 校验通过' },
      { id: '2', description: '写入 modcrafting.mixins.json', status: 'pending', kind: 'write', targetPath: MIXINS_JSON, evidence: '注册配置已写入' }
    ])
    const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 4 }))
    steps[1].status = 'running'
    const engine = new WorkflowEngine({
      steps: [steps[1]],
      planTracker: tracker,
      registry,
      projectPath: '/proj',
      emit: () => {},
      modelCall: async () => ({ text: '', reasoning: '', toolCalls: [registerTool('complete_step', { stepId: '2' })] })
    })
    const result = await engine.run([])
    assert.notEqual(tracker.steps[1].status, 'completed', 'resumed step + existing file must not auto-satisfy')
    assert.equal(result.allDone, false)
  } finally {
    restore()
  }
})

test('later write step adopts the mixin register artifact written by an earlier step', async () => {
  const written: string[] = []
  const restore = installWindow({
    exists: async () => written.length > 0,
    listDirectory: async () => [],
    readFile: async () => ({ success: false })
  })
  try {
    const registry = mixinRegistry(written)
    const tracker = PlanTracker.fromSteps([
      { id: '1', description: '实现 ShulkerBulletMixin 并注册', status: 'pending', kind: 'mixin', targetPath: MIXIN_SRC, evidence: 'Mixin 校验通过' },
      { id: '2', description: '将 Mixin 注册写入 modcrafting.mixins.json', status: 'pending', kind: 'write', targetPath: MIXINS_JSON, evidence: '注册配置已写入' }
    ])
    const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 4 }))
    let round = 0
    const notices: string[] = []
    const evidenceRejections: string[] = []
    const engine = new WorkflowEngine({
      steps,
      planTracker: tracker,
      registry,
      projectPath: '/proj',
      emit: (ev) => {
        if (ev.kind === 'Notice' && ev.notice?.text) notices.push(ev.notice.text)
        if (ev.kind === 'ToolResult' && String(ev.tool?.error || '').includes('step_evidence_required')) {
          evidenceRejections.push(String(ev.tool?.error))
        }
      },
      modelCall: async () => {
        round++
        if (round === 1) return { text: '', reasoning: '', toolCalls: [registerTool('fabric_mixin_register', { sourcePath: MIXIN_SRC })] }
        if (round === 2) return { text: '', reasoning: '', toolCalls: [registerTool('fabric_mixin_validate', { sourcePath: MIXIN_SRC })] }
        if (round === 3) return { text: '', reasoning: '', toolCalls: [registerTool('complete_step', { stepId: '1' })] }
        // The write step performs no write of its own — the config is already on disk
        // from step #1, so only run-scoped adoption can advance it.
        if (round === 4) return { text: '', reasoning: '', toolCalls: [registerTool('complete_step', { stepId: '2' })] }
        // Stop the run before the deterministic test_design/game_test tail.
        return { text: '', reasoning: '', toolCalls: [registerTool('ask_clarification', { question: 'stop' })] }
      }
    })

    const result = await engine.run([])
    assert.equal(tracker.steps[0].status, 'completed')
    assert.equal(tracker.steps[1].status, 'completed', 'register artifact from step #1 must satisfy step #2')
    assert.equal(result.needsClarification, true)
    assert.equal(round, 5, `adoption must not burn extra rounds, got ${round}`)
    assert.equal(evidenceRejections.length, 0, 'no step_evidence_required rejection expected')
    assert.ok(
      notices.some((text) => /已由本轮早前步骤的工具写入/.test(text) && text.includes(MIXINS_JSON)),
      `adoption notice missing, got: ${notices.join(' | ')}`
    )
  } finally {
    restore()
  }
})

test('two evidence refusals pause the run with the real round count instead of an exhausted budget', async () => {
  const restore = installWindow({
    exists: async () => false,
    listDirectory: async () => [],
    readFile: async () => ({ success: false })
  })
  try {
    const registry = mixinRegistry([])
    const tracker = PlanTracker.fromSteps([
      { id: '3', description: '写入 modcrafting.mixins.json', status: 'pending', kind: 'write', targetPath: MIXINS_JSON, evidence: '注册配置已写入' }
    ])
    const steps = normalizeWorkflowSteps(tracker.steps).map((s) => ({ ...s, maxAttempts: 4 }))
    let round = 0
    const engine = new WorkflowEngine({
      steps,
      planTracker: tracker,
      registry,
      projectPath: '/proj',
      emit: () => {},
      modelCall: async () => {
        round++
        return {
          text: '',
          reasoning: '',
          toolCalls: [registerTool('fabric_mod_json_validate', {}), registerTool('complete_step', { stepId: '3' })]
        }
      }
    })
    const result = await engine.run([])
    assert.equal(round, 2, `deadlock must stop after two refusals, got ${round} rounds`)
    assert.ok(
      result.finalContent.startsWith('[HARNESS_PAUSED:evidence_deadlock]'),
      `expected evidence deadlock, got: ${result.finalContent}`
    )
    assert.match(result.finalContent, /实际消耗 2 轮/)
    assert.doesNotMatch(result.finalContent, /已用 \d+\/\d+ 轮/, 'must not claim an exhausted budget')
    assert.match(result.finalContent, new RegExp(MIXINS_JSON), 'must name the missing target path')
  } finally {
    restore()
  }
})

test('evidence rejection text names an actionable remedy, not the tool catalogue', () => {
  const note = buildStepFailureMessage(step('3', { title: '写入 mixins.json' }), 18, 18, 'complete_step', '', '#3 写入 mixins.json', '实际消耗 2 轮后触发提前终止护栏，步骤预算 18 轮')
  assert.match(note, /实际消耗 2 轮/)
  assert.doesNotMatch(note, /已用 18\/18 轮/)
})
