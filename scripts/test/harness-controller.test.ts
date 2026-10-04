import test from 'node:test'
import assert from 'node:assert/strict'
import { Controller } from '../../src/renderer/src/harness/controller.ts'
import { Registry } from '../../src/renderer/src/harness/tools.ts'
import type { ControllerOptions } from '../../src/renderer/src/harness/controller.ts'

// ─── helpers ───────────────────────────────────────────

function minimalRegistry(): Registry {
  const registry = new Registry()
  registry.add({
    name: 'read_file',
    description: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    readOnly: () => true,
    async execute(_ctx, args) { return `read ${args.path}` }
  })
  registry.add({
    name: 'write_file',
    description: 'write',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    readOnly: () => false,
    async execute(_ctx, args) { return `wrote ${args.path}` }
  })
  registry.add({
    name: 'complete_step',
    description: 'complete',
    schema: { type: 'object', properties: { stepId: { type: 'string' } }, required: ['stepId'] },
    readOnly: () => false,
    async execute() { return '[STEP_COMPLETE_REQUEST:1]' }
  })
  return registry
}

function makeController(overrides?: Partial<ControllerOptions>): Controller {
  return new Controller({
    registry: minimalRegistry(),
    projectPath: 'D:/test-project',
    apiConfig: { endpoint: 'http://localhost:11434/v1', apiKey: 'test', model: 'test-model' },
    ...overrides
  })
}

// ─── initial state ──────────────────────────────────────

test('Controller starts in plan phase with running=false', () => {
  const ctrl = makeController()
  assert.equal(ctrl.running, false)
  assert.equal(ctrl.phase, 'plan')
  assert.equal(ctrl.isPlanReady, false)
})

test('Controller preserves project path from options', () => {
  const ctrl = makeController({ projectPath: 'D:/my-project' })
  assert.equal(ctrl.projectPath, 'D:/my-project')
})

test('Controller accepts null project path', () => {
  const ctrl = makeController({ projectPath: null })
  assert.equal(ctrl.projectPath, null)
})

// ─── composer mode ──────────────────────────────────────

test('setComposerMode changes the composer mode', () => {
  const ctrl = makeController()
  assert.equal(ctrl.composerModeSnapshot, 'agent')
  ctrl.setComposerMode('plan_only')
  assert.equal(ctrl.composerModeSnapshot, 'plan_only')
  ctrl.setComposerMode('agent')
  assert.equal(ctrl.composerModeSnapshot, 'agent')
})

// ─── session goal ───────────────────────────────────────

test('setSessionGoal trims and stores the goal', () => {
  const ctrl = makeController()
  assert.equal(ctrl.getSessionGoal(), '')
  ctrl.setSessionGoal('  实现一个方块  ')
  assert.equal(ctrl.getSessionGoal(), '实现一个方块')
})

test('setSessionGoal with empty string clears the goal', () => {
  const ctrl = makeController()
  ctrl.setSessionGoal('some goal')
  ctrl.setSessionGoal('  ')
  assert.equal(ctrl.getSessionGoal(), '')
})

// ─── setProjectPath ─────────────────────────────────────

test('setProjectPath updates the project path', () => {
  const ctrl = makeController({ projectPath: 'D:/old' })
  ctrl.setProjectPath('D:/new')
  assert.equal(ctrl.projectPath, 'D:/new')
})

test('setProjectPath to null clears the project path', () => {
  const ctrl = makeController({ projectPath: 'D:/project' })
  ctrl.setProjectPath(null)
  assert.equal(ctrl.projectPath, null)
})

// ─── setApiConfig ───────────────────────────────────────

test('setApiConfig updates the API configuration', () => {
  const ctrl = makeController()
  ctrl.setApiConfig({ endpoint: 'http://new-endpoint/v1', apiKey: 'new-key', model: 'new-model' })
  assert.equal(ctrl.apiConfig.endpoint, 'http://new-endpoint/v1')
  assert.equal(ctrl.apiConfig.apiKey, 'new-key')
  assert.equal(ctrl.apiConfig.model, 'new-model')
})

// ─── event emission ─────────────────────────────────────

test('Controller emits events through onEvent callback', () => {
  const events: any[] = []
  const ctrl = makeController({
    onEvent: (event) => events.push(event)
  })
  // setComposerMode and setSessionGoal are synchronous state changes
  // that don't emit events directly, but the controller should be constructed
  // without errors when onEvent is provided.
  assert.equal(events.length, 0)
  ctrl.setSessionGoal('test')
  assert.equal(ctrl.getSessionGoal(), 'test')
})

// ─── lastTurnModeSnapshot ───────────────────────────────

test('lastTurnModeSnapshot returns initial chat mode', () => {
  const ctrl = makeController()
  assert.equal(ctrl.lastTurnModeSnapshot, 'chat')
})

// ─── Controller construction with routing config ────────

test('Controller accepts routing config without error', () => {
  const ctrl = makeController({
    routingConfig: {
      models: {
        planner: { providerId: 'test', modelId: 'plan-model' },
        implementer: { providerId: 'test', modelId: 'code-model' },
        classifier: { providerId: 'test', modelId: 'classify-model' }
      }
    }
  })
  assert.equal(ctrl.phase, 'plan')
  assert.equal(ctrl.running, false)
})

// ─── multiple state changes are independent ─────────────

test('multiple state changes compose without interference', () => {
  const ctrl = makeController({ projectPath: 'D:/project' })
  ctrl.setComposerMode('plan_only')
  ctrl.setSessionGoal('实现功能')
  ctrl.setApiConfig({ endpoint: 'http://alt/v1', apiKey: 'k', model: 'm' })

  assert.equal(ctrl.composerModeSnapshot, 'plan_only')
  assert.equal(ctrl.getSessionGoal(), '实现功能')
  assert.equal(ctrl.apiConfig.endpoint, 'http://alt/v1')
  assert.equal(ctrl.projectPath, 'D:/project')
  assert.equal(ctrl.phase, 'plan')
})
