import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyExploreToolLimit,
  buildWriteForceInstruction,
  MAX_FREE_EXPLORE_ROUNDS
} from '../../src/renderer/src/harness/workflow-engine.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

const MIXIN_TOOLS = [
  'fabric_mixin_target_lookup',
  'fabric_mixin_scaffold',
  'fabric_mixin_register',
  'fabric_mixin_validate',
  'edit_file',
  'write_file',
  'delete_file',
  'read_file',
  'list_directory',
  'grep',
  'complete_step',
  'fabric_docs_search',
  'fabric_javadoc_lookup',
  'fabric_log_debugger',
  'read_error_log'
]

test('MAX_FREE_EXPLORE_ROUNDS is 4', () => {
  assert.equal(MAX_FREE_EXPLORE_ROUNDS, 4)
})

test('applyExploreToolLimit keeps read_file and strips roam + knowledge', () => {
  const limited = applyExploreToolLimit(MIXIN_TOOLS, {
    exploreExhausted: true,
    stripKnowledge: true
  })
  assert.ok(limited.includes('read_file'), 'read_file must remain for edit_file aci_read_gate')
  assert.ok(limited.includes('edit_file'))
  assert.ok(limited.includes('write_file'))
  assert.ok(limited.includes('delete_file'))
  assert.ok(limited.includes('fabric_mixin_scaffold'))
  assert.equal(limited.includes('list_directory'), false)
  assert.equal(limited.includes('grep'), false)
  assert.equal(limited.includes('fabric_docs_search'), false)
  assert.equal(limited.includes('fabric_javadoc_lookup'), false)
})

test('applyExploreToolLimit is no-op when explore not exhausted', () => {
  const limited = applyExploreToolLimit(MIXIN_TOOLS, { exploreExhausted: false })
  assert.deepEqual(limited, MIXIN_TOOLS)
})

test('buildWriteForceInstruction does not forbid read_file', () => {
  const step: WorkflowStep = {
    id: '3',
    title: '实现 TitleScreenUiAdjuster',
    kind: 'mixin',
    status: 'running',
    allowedTools: MIXIN_TOOLS,
    maxAttempts: 6,
    targetPath: 'src/main/java/com/example/mixin/TitleScreenUiAdjuster.java'
  }
  const text = buildWriteForceInstruction(step)
  assert.match(text, /强制写入/)
  assert.match(text, /list_directory\/grep/)
  assert.doesNotMatch(text, /禁止再 read_file/)
  assert.match(text, /read_file/)
  assert.match(text, /TitleScreenUiAdjuster\.java/)
})
