import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEmbeddedPlanStep, validateToolCalls } from '../../src/renderer/src/harness/tool-call-validator.ts'
import { executeBatch, inferToolErrorKind, Registry } from '../../src/renderer/src/harness/tools.ts'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { WorkflowEngine } from '../../src/renderer/src/harness/workflow-engine.ts'
import { isNonBurningRejectionRound } from '../../src/renderer/src/harness/workflow-engine.ts'
import { isBuildFailureWithinRepairScope } from '../../src/renderer/src/harness/workflow-engine.ts'
import { compilePlanFromText } from '../../src/renderer/src/harness/plan-compiler.ts'
import { microCompact } from '../../src/renderer/src/harness/context-compact.ts'
import { planToolNames, recommendedToolNames } from '../../src/renderer/src/harness/tool-policy.ts'
import { rejectedToolCallSignature } from '../../src/renderer/src/harness/tool-rejection-guard.ts'
import { MAX_IMPLEMENTATION_PLAN_STEPS, MAX_PLAN_STEPS } from '../../src/renderer/src/utils/plan-steps.ts'
import { structuredGameTestGate } from '../../src/renderer/src/harness/plan-execution-gate.ts'

test('tool boundary rejects tools not offered in the current phase', () => {
  const result = validateToolCalls([
    {
      id: 'call_write',
      name: 'write_file',
      args: { path: 'src/main/java/X.java', content: 'x' },
      rawArguments: '{"path":"src/main/java/X.java","content":"x"}'
    }
  ], [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }])

  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.get('call_write')?.errorKind, 'tool_not_offered')
})

test('blocked tool output preserves the concrete host rejection kind', () => {
  assert.equal(
    inferToolErrorKind('blocked: [aci_write_gate] file exists'),
    'aci_write_gate'
  )
  assert.equal(inferToolErrorKind('Error: compiler failed'), undefined)
})

test('ACI write guidance does not consume a write/build attempt', () => {
  assert.equal(isNonBurningRejectionRound([{
    output: 'blocked: [aci_write_gate] read first',
    error: 'blocked: [aci_write_gate] read first',
    durationMs: 0,
    ok: false,
    toolName: 'write_file',
    args: {},
    exitCode: null,
    errorKind: 'aci_write_gate'
  }]), true)
})

test('tool boundary rejects malformed or schema-invalid arguments', () => {
  const offered = [{
    name: 'read_file',
    description: 'read',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  }]
  const result = validateToolCalls([
    { id: 'bad_json', name: 'read_file', args: {}, rawArguments: '{bad' },
    { id: 'missing_path', name: 'read_file', args: {}, rawArguments: '{}' }
  ], offered)

  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.get('bad_json')?.errorKind, 'invalid_tool_arguments')
  assert.equal(result.rejected.get('missing_path')?.errorKind, 'invalid_tool_arguments')
})

test('submit_plan normalizes provider-encoded nested JSON objects', () => {
  const step = { kind: 'write', description: '实现功能', targetPath: 'src/main/java/Feature.java', evidence: '文件写入成功' }
  const args = { steps: [JSON.stringify(step)] }
  const result = validateToolCalls([{
    id: 'plan',
    name: 'submit_plan',
    args,
    rawArguments: JSON.stringify(args)
  }], [{
    name: 'submit_plan',
    description: 'plan',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              description: { type: 'string' },
              targetPath: { type: 'string' },
              evidence: { type: 'string' }
            },
            required: ['kind', 'description', 'targetPath', 'evidence']
          }
        }
      },
      required: ['steps']
    }
  }])

  assert.equal(result.rejected.size, 0)
  assert.deepEqual(result.accepted[0]?.args.steps, [step])
})

test('MiniMax XML and key-value nested plan steps normalize deterministically', () => {
  assert.deepEqual(
    parseEmbeddedPlanStep(' <kind>mixin</kind> <description>使用 PigEntityModel 渲染</description> <targetPath>src/client/java/PigMixin.java</targetPath> <evidence>校验通过</evidence>'),
    { kind: 'mixin', description: '使用 PigEntityModel 渲染', targetPath: 'src/client/java/PigMixin.java', evidence: '校验通过' }
  )
  assert.deepEqual(
    parseEmbeddedPlanStep('kind=write, targetPath=src/main/java/Morph.java, description=创建状态, 包含服务端同步, evidence=编译通过'),
    { kind: 'write', targetPath: 'src/main/java/Morph.java', description: '创建状态, 包含服务端同步', evidence: '编译通过' }
  )
  assert.equal(parseEmbeddedPlanStep('|\n<invoke name="submit_plan">'), null)
})

test('submit_plan string steps receive an actionable field-level example', () => {
  const args = { steps: ['实现功能'] }
  const result = validateToolCalls([{
    id: 'plan', name: 'submit_plan', args, rawArguments: JSON.stringify(args)
  }], [{
    name: 'submit_plan', description: 'plan', parameters: {
      type: 'object', properties: { steps: { type: 'array', items: { type: 'object' } } }, required: ['steps']
    }
  }])

  assert.match(result.rejected.get('plan')?.output || '', /每一项必须是 JSON 对象/)
  assert.match(result.rejected.get('plan')?.output || '', /targetPath/)
})

test('repeated array-item schema failures share one rejection signature', () => {
  const make = (output: string) => ({
    output,
    toolName: 'submit_plan',
    errorKind: 'invalid_tool_arguments' as const,
    durationMs: 0,
    ok: false
  })
  assert.equal(
    rejectedToolCallSignature([make('/steps/0 must be object; /steps/1 must be object')]),
    rejectedToolCallSignature([make('/steps/0 must be object; /steps/1 must be object; /steps/2 must be object')])
  )
})

test('implementation plan capacity reserves the deterministic terminal tail', () => {
  assert.equal(MAX_IMPLEMENTATION_PLAN_STEPS, 9)
  assert.equal(MAX_IMPLEMENTATION_PLAN_STEPS + 3, MAX_PLAN_STEPS)
})

test('game-code prose plans cannot bypass submit_plan gameTest validation', () => {
  assert.equal(structuredGameTestGate('1. [mixin] 修改 src/main/java/example/PlayerMixin.java').ok, false)
  assert.equal(structuredGameTestGate('更新 docs/harness.md').ok, true)
  assert.equal(structuredGameTestGate('```json\n{"steps":[{"kind":"mixin","targetPath":"src/main/java/X.java"}],"gameTest":{"version":2},"acceptanceContract":{"version":1}}\n```').ok, true)
})

test('repair scope recovers project-relative src path from a truncated Windows build log path', () => {
  assert.equal(isBuildFailureWithinRepairScope(
    'ta/Local/Temp/run/workspace/src/main/java/com/example/PigForm.java',
    ['src/main/java/com/example/PigForm.java'],
    'C:/Users/test/AppData/Local/Temp/run/workspace'
  ), true)
  assert.equal(isBuildFailureWithinRepairScope(
    'ta/Local/Temp/run/workspace/src/main/java/com/example/Unrelated.java',
    ['src/main/java/com/example/PigForm.java'],
    'C:/Users/test/AppData/Local/Temp/run/workspace'
  ), false)
  assert.equal(isBuildFailureWithinRepairScope(
    'od/mixin/PlayerAttributeMixin.java',
    ['src/main/java/com/example/prefetch_mod/mixin/PlayerAttributeMixin.java'],
    'C:/Users/test/AppData/Local/Temp/run/workspace'
  ), true)
})

test('ordered scheduler keeps write -> read observation order', async () => {
  const registry = new Registry()
  let value = 'before'
  registry.add({
    name: 'write_value', description: 'write', schema: { type: 'object' }, readOnly: () => false,
    async execute() { value = 'after'; return 'written' }
  })
  registry.add({
    name: 'read_value', description: 'read', schema: { type: 'object' }, readOnly: () => true,
    async execute() { return value }
  })

  const results = await executeBatch([
    { id: 'write', name: 'write_value', args: {} },
    { id: 'read', name: 'read_value', args: {} }
  ], registry, { projectPath: null, callId: 'test' })

  assert.equal(results.get('read')?.output, 'after')
})

test('timed-out read settles the batch and does not block the following write', async () => {
  const registry = new Registry()
  registry.add({
    name: 'never_returns', description: 'hang', schema: { type: 'object' }, readOnly: () => true,
    policy: { capabilities: ['project.read'], executionClass: 'fast', timeoutMs: 15, cancellable: true },
    async execute() { return await new Promise<string>(() => {}) }
  })
  let wrote = false
  registry.add({
    name: 'write_after_timeout', description: 'write', schema: { type: 'object' }, readOnly: () => false,
    policy: { capabilities: ['project.write'], executionClass: 'fast', timeoutMs: 100, cancellable: true },
    async execute() { wrote = true; return 'written' }
  })

  const results = await executeBatch([
    { id: 'hang', name: 'never_returns', args: {} },
    { id: 'write', name: 'write_after_timeout', args: {} }
  ], registry, { projectPath: null, callId: 'test', runId: 'run-test' })

  assert.equal(results.get('hang')?.errorKind, 'tool_timeout')
  assert.equal(results.get('hang')?.outcome, 'timed_out')
  assert.equal(results.get('hang')?.executionId, 'run-test:hang')
  assert.equal(wrote, true)
})

test('tool cancellation settles with a cancelled outcome', async () => {
  const registry = new Registry()
  let sawAbort = false
  registry.add({
    name: 'wait_for_abort', description: 'wait', schema: { type: 'object' }, readOnly: () => true,
    policy: { capabilities: ['project.read'], executionClass: 'fast', timeoutMs: 1000, cancellable: true },
    async execute(ctx) {
      return await new Promise<string>((_resolve, reject) => {
        ctx.abortSignal?.addEventListener('abort', () => {
          sawAbort = true
          reject(ctx.abortSignal?.reason)
        }, { once: true })
      })
    }
  })
  const controller = new AbortController()
  const pending = executeBatch([{ id: 'cancel', name: 'wait_for_abort', args: {} }], registry, {
    projectPath: null, callId: 'test', abortSignal: controller.signal
  })
  setTimeout(() => controller.abort(new Error('test cancel')), 10)
  const results = await pending
  assert.equal(sawAbort, true)
  assert.equal(results.get('cancel')?.errorKind, 'tool_cancelled')
  assert.equal(results.get('cancel')?.outcome, 'cancelled')
})

test('capability catalogue exposes Minecraft data to plan and write steps', () => {
  assert.ok(planToolNames().includes('minecraft_data_lookup'))
  assert.ok(planToolNames().includes('mc_wiki_search'))
  assert.ok(recommendedToolNames('write').includes('minecraft_data_lookup'))
  assert.ok(recommendedToolNames('write').includes('mc_wiki_search'))
})

test('policy deferrals do not burn the workflow attempt budget', () => {
  assert.equal(isNonBurningRejectionRound([{
    toolName: 'create_recipe', errorKind: 'policy_deferred', output: 'defer', durationMs: 0
  }]), true)
})

test('write plus complete_step advances exactly one plan step', async () => {
  const registry = new Registry()
  registry.add({
    name: 'write_file',
    description: 'write',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    readOnly: () => false,
    async execute(_ctx, args) { return `Written ${args.path}` }
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
    async execute() { return '[STEP_COMPLETE_REQUEST:1]' }
  })
  registry.add({
    name: 'ask_clarification',
    description: 'ask',
    schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question']
    },
    readOnly: () => true,
    async execute() { return '[CLARIFICATION_NEEDED]' }
  })

  const tracker = PlanTracker.fromSteps([
    {
      id: '1', description: '写入 src/main/java/One.java', status: 'running', kind: 'write',
      targetPath: 'src/main/java/One.java', evidence: '文件已写入'
    },
    {
      id: '2', description: '写入 src/main/java/Two.java', status: 'pending', kind: 'write',
      targetPath: 'src/main/java/Two.java', evidence: '文件已写入'
    }
  ])
  let round = 0
  const engine = new WorkflowEngine({
    steps: normalizeWorkflowSteps(tracker.steps),
    planTracker: tracker,
    registry,
    projectPath: 'D:/fake',
    emit: () => {},
    modelCall: async () => {
      round++
      return {
        text: '', reasoning: '',
        toolCalls: round === 1
          ? [
              { name: 'write_file', args: { path: 'src/main/java/One.java', content: 'one' } },
              { name: 'complete_step', args: { stepId: '1' } }
            ]
          : [{ name: 'ask_clarification', args: { question: 'pause' } }]
      }
    }
  })

  const result = await engine.run([])
  assert.equal(result.needsClarification, true)
  assert.equal(tracker.steps[0].status, 'completed')
  assert.equal(tracker.currentStep?.id, '2')
})

test('numbered plans preserve evidence and multi-target JSON plans preserve paths', () => {
  const numbered = compilePlanFromText(
    '1. [write] 修改入口 — src/main/java/com/acme/Main.java；evidence: 注册成功'
  )
  assert.equal(numbered[0].evidence, '注册成功')

  const structured = compilePlanFromText(JSON.stringify([{
    kind: 'write',
    description: '生成资源',
    targetPaths: ['src/main/resources/a.json', 'src/main/resources/b.json'],
    evidence: '两个资源均存在'
  }]))
  assert.deepEqual(structured[0].targetPaths, [
    'src/main/resources/a.json',
    'src/main/resources/b.json'
  ])
})

test('micro compaction still compacts old results after a new run resets counters', () => {
  const oldOutput = 'x'.repeat(2000)
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'assistant', content: '', tool_calls: [] },
    { role: 'tool', name: 'read_file', tool_call_id: 'old', content: oldOutput },
    ...Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: String(index)
    }))
  ]
  const compacted = microCompact(messages, 0)
  assert.ok(compacted[2].content.length < oldOutput.length)
})
