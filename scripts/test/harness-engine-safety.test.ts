import test from 'node:test'
import assert from 'node:assert/strict'
import { validateToolCalls } from '../../src/renderer/src/harness/tool-call-validator.ts'
import { executeBatch, Registry } from '../../src/renderer/src/harness/tools.ts'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import { normalizeWorkflowSteps } from '../../src/renderer/src/harness/plan-normalizer.ts'
import { WorkflowEngine } from '../../src/renderer/src/harness/workflow-engine.ts'
import { compilePlanFromText } from '../../src/renderer/src/harness/plan-compiler.ts'
import { microCompact } from '../../src/renderer/src/harness/context-compact.ts'

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
    ...Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: String(index)
    }))
  ]
  const compacted = microCompact(messages, 0)
  assert.ok(compacted[2].content.length < oldOutput.length)
})
