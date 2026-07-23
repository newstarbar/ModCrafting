import test from 'node:test'
import assert from 'node:assert/strict'
import { PlanTracker } from '../../src/renderer/src/harness/plan-tracker.ts'
import type { TurnIntentContext } from '../../src/renderer/src/harness/turn-intent.ts'
import {
  applyClassifyContextGates,
  classifyUserTurn,
  parseClassifyToolArgs,
  structuralClassifyFallback
} from '../../src/renderer/src/harness/turn-classifier.ts'

function intentCtx(overrides: Partial<TurnIntentContext> = {}): TurnIntentContext {
  return {
    phase: 'plan',
    planTracker: null,
    hasProject: true,
    composerMode: 'agent',
    ...overrides
  }
}

function mockClassifyResponse(args: Record<string, unknown>): typeof fetch {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'classify_user_turn',
                    arguments: JSON.stringify(args)
                  }
                }
              ]
            }
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
}

test('parseClassifyToolArgs rejects missing intent', () => {
  assert.equal(parseClassifyToolArgs({ isUserSymptom: true }), null)
})

test('parseClassifyToolArgs coerces verifyTarget', () => {
  const parsed = parseClassifyToolArgs({
    intent: 'develop',
    isInGameVerifyRequest: false,
    skipFormalPlan: true,
    isUserSymptom: true,
    isSymptomResolved: false,
    isErrorReport: false,
    isGuiFeatureSymptom: true,
    verifyTarget: {
      label: '打开 Preview',
      hotkey: 'F6',
      screenNameHints: ['Preview'],
      openSteps: ['key_press f6']
    },
    rationale: '短症状'
  })
  assert.ok(parsed)
  assert.equal(parsed!.intent, 'develop')
  assert.equal(parsed!.verifyTarget?.hotkey, 'f6')
  assert.deepEqual(parsed!.verifyTarget?.screenNameHints, ['Preview'])
})

test('applyClassifyContextGates: ask forces chat', () => {
  const gated = applyClassifyContextGates(
    {
      intent: 'develop',
      isInGameVerifyRequest: false,
      skipFormalPlan: true,
      isUserSymptom: true,
      isSymptomResolved: false,
      isErrorReport: false,
      isGuiFeatureSymptom: false,
      verifyTarget: null,
      rationale: 'x',
      usedFallback: false
    },
    intentCtx({ composerMode: 'ask' }),
    '修一下预览'
  )
  assert.equal(gated.intent, 'chat')
  assert.equal(gated.skipFormalPlan, false)
})

test('applyClassifyContextGates: in-game verify clears skipFormalPlan', () => {
  const gated = applyClassifyContextGates(
    {
      intent: 'develop',
      isInGameVerifyRequest: true,
      skipFormalPlan: true,
      isUserSymptom: false,
      isSymptomResolved: false,
      isErrorReport: false,
      isGuiFeatureSymptom: true,
      verifyTarget: null,
      rationale: '再测',
      usedFallback: false
    },
    intentCtx(),
    '游戏测试'
  )
  assert.equal(gated.isInGameVerifyRequest, true)
  assert.equal(gated.skipFormalPlan, false)
})

test('structuralClassifyFallback: crash during execute → resume', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'completed' },
    { id: '2', description: '构建', status: 'failed' }
  ])
  const crash = `---- Minecraft Crash Report ----
java.lang.IllegalStateException: setScreen on the wrong thread
	at knot//net.minecraft.client.gui.screen.Screen.ensureEventsAreInitialized(Screen.java:1347)`
  const result = structuralClassifyFallback(
    crash,
    intentCtx({ phase: 'execute', planTracker: tracker })
  )
  assert.equal(result.intent, 'resume')
  assert.equal(result.isErrorReport, true)
  assert.equal(result.usedFallback, true)
})

test('structuralClassifyFallback: BUILD FAILED with no plan → develop', () => {
  const result = structuralClassifyFallback(
    'BUILD FAILED\nsrc/main/java/Foo.java:10: error: cannot find symbol',
    intentCtx({ phase: 'plan', planTracker: null })
  )
  assert.equal(result.intent, 'develop')
  assert.equal(result.isErrorReport, true)
})

test('structuralClassifyFallback: narrow resume with incomplete plan', () => {
  const tracker = PlanTracker.fromSteps([
    { id: '1', description: '写文件', status: 'running' },
    { id: '2', description: '构建', status: 'pending' }
  ])
  const result = structuralClassifyFallback(
    '继续。',
    intentCtx({ phase: 'execute', planTracker: tracker })
  )
  assert.equal(result.intent, 'resume')
})

test('structuralClassifyFallback: plan mode → plan_only', () => {
  const result = structuralClassifyFallback('添加二段跳', intentCtx({ composerMode: 'plan' }))
  assert.equal(result.intent, 'plan_only')
})

test('classifyUserTurn: ask mode skips API', async () => {
  let called = false
  const result = await classifyUserTurn({
    apiConfig: { endpoint: 'http://example.invalid', apiKey: 'k', model: 'm' },
    input: '玩家可以进行二段跳',
    ctx: intentCtx({ composerMode: 'ask' }),
    fetchImpl: async () => {
      called = true
      throw new Error('should not fetch')
    }
  })
  assert.equal(called, false)
  assert.equal(result.intent, 'chat')
})

test('classifyUserTurn: mock LLM returns in-game verify', async () => {
  const result = await classifyUserTurn({
    apiConfig: { endpoint: 'http://localhost:9', apiKey: 'test-key', model: 'test-model' },
    input: '游戏测试',
    ctx: intentCtx({ hasProject: true }),
    fetchImpl: mockClassifyResponse({
      intent: 'develop',
      isInGameVerifyRequest: true,
      skipFormalPlan: true,
      isUserSymptom: false,
      isSymptomResolved: false,
      isErrorReport: false,
      isGuiFeatureSymptom: true,
      verifyTarget: {
        label: '打开待测功能界面',
        screenNameHints: [],
        openSteps: ['打开功能', 'mc_inspect']
      },
      rationale: '短验证请求'
    })
  })
  assert.equal(result.usedFallback, false)
  assert.equal(result.isInGameVerifyRequest, true)
  assert.equal(result.skipFormalPlan, false)
  assert.equal(result.intent, 'develop')
})

test('classifyUserTurn: mock LLM short symptom skips formal plan', async () => {
  const result = await classifyUserTurn({
    apiConfig: { endpoint: 'http://localhost:9', apiKey: 'test-key', model: 'test-model' },
    input: '预览还是糊的',
    ctx: intentCtx(),
    fetchImpl: mockClassifyResponse({
      intent: 'develop',
      isInGameVerifyRequest: false,
      skipFormalPlan: true,
      isUserSymptom: true,
      isSymptomResolved: false,
      isErrorReport: false,
      isGuiFeatureSymptom: true,
      verifyTarget: {
        label: '打开 Preview',
        hotkey: 'f6',
        screenNameHints: ['Preview', 'MainMenuPreviewScreen'],
        openSteps: ['key_press f6', 'mc_inspect']
      },
      rationale: 'GUI 症状'
    })
  })
  assert.equal(result.skipFormalPlan, true)
  assert.equal(result.isUserSymptom, true)
  assert.equal(result.isGuiFeatureSymptom, true)
  assert.equal(result.verifyTarget?.hotkey, 'f6')
})

test('classifyUserTurn: API failure uses structural fallback', async () => {
  const result = await classifyUserTurn({
    apiConfig: { endpoint: 'http://localhost:9', apiKey: 'test-key', model: 'test-model' },
    input: '继续',
    ctx: intentCtx({
      phase: 'execute',
      planTracker: PlanTracker.fromSteps([{ id: '1', description: '构建', status: 'running' }])
    }),
    fetchImpl: async () => {
      throw new Error('network down')
    }
  })
  assert.equal(result.usedFallback, true)
  assert.equal(result.intent, 'resume')
})

test('classifyUserTurn: empty api key uses fallback without fetch', async () => {
  let called = false
  const result = await classifyUserTurn({
    apiConfig: { endpoint: 'http://localhost:9', apiKey: '', model: 'm' },
    input: '做个二段跳',
    ctx: intentCtx(),
    fetchImpl: async () => {
      called = true
      throw new Error('no')
    }
  })
  assert.equal(called, false)
  assert.equal(result.usedFallback, true)
  assert.equal(result.intent, 'develop')
})
