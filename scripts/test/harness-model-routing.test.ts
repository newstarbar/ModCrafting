import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_ROLE_IDS,
  BUILTIN_ROUTING_PRESETS,
  allRoutingPresets,
  buildHomeProviderLadder,
  buildRouteDecisionFromSignals,
  buildStaticRouteDecision,
  countProvidersInPreset,
  defaultRoutingConfig,
  executableRolesForIntent,
  extractRoutingSignals,
  findRoutingPreset,
  materializePresetForHome,
  normalizeRoutingConfig,
  resolveBindingForDifficulty,
  withActiveRoles
} from '../../src/shared/model-routing.ts'
import { parseRoutingSignalToolArgs } from '../../src/renderer/src/harness/routing-classifier.ts'
import { collaborationForAutomation, toolArgsForAutomation, toolOutputForAutomation } from '../../src/renderer/src/harness/automation-event-projection.ts'

test('routing presets cover every fixed Harness role', () => {
  for (const preset of BUILTIN_ROUTING_PRESETS) {
    assert.deepEqual(Object.keys(preset.roles).sort(), [...AGENT_ROLE_IDS].sort())
    assert.ok(preset.roles.implementer.required)
  }
})

test('built-in presets stay single-provider before companion materialization', () => {
  for (const preset of BUILTIN_ROUTING_PRESETS) {
    assert.equal(countProvidersInPreset(preset), 1, preset.id)
    const ids = new Set(
      AGENT_ROLE_IDS.flatMap((role) => [
        preset.roles[role].primary.providerId,
        ...preset.roles[role].fallbacks.map((item) => item.providerId)
      ])
    )
    assert.equal(ids.size, 1)
    assert.equal([...ids][0], 'deepseek')
  }
})

test('route decision keeps a single writer and requires visual review for GUI', () => {
  const ui = buildStaticRouteDecision('请为模组做一个设置 GUI 界面', 'auto')
  assert.equal(ui.taskTemplateId, 'ui')
  assert.ok(ui.roles.includes('visualReviewer'))
  assert.ok(ui.signals.needsVision)
  assert.equal(ui.delegations.filter((task) => !task.readOnly).map((task) => task.roleId).join(','), 'implementer')
})

test('bug reports route through debugger and Minecraft content through explorer', () => {
  const bug = buildStaticRouteDecision('构建报错，帮我修复这个崩溃', 'auto')
  const minecraft = buildStaticRouteDecision('新增一个方块和配方', 'auto')
  assert.equal(bug.taskTemplateId, 'bugfix')
  assert.ok(bug.roles.includes('debugger'))
  assert.ok(bug.signals.needsDebug)
  assert.equal(minecraft.taskTemplateId, 'minecraft')
  assert.ok(minecraft.roles.includes('explorer'))
})

test('activeRoles only queue executable roles for chat intent', () => {
  const decision = withActiveRoles(buildStaticRouteDecision('你好', 'auto', false, 'chat'), 'chat')
  assert.deepEqual(decision.activeRoles, ['router', 'coordinator'])
  assert.equal(decision.delegations.every((item) => decision.activeRoles.includes(item.roleId)), true)
})

test('develop intent activates explorer planner implementer for feature work', () => {
  const decision = buildStaticRouteDecision('帮我实现一个新功能：添加传送门', 'auto', false, 'develop')
  assert.ok(decision.activeRoles.includes('explorer'))
  assert.ok(decision.activeRoles.includes('planner'))
  assert.ok(decision.activeRoles.includes('implementer'))
  assert.equal(decision.activeRoles.includes('visualReviewer'), false)
})

test('ambiguous short generic input marks low-confidence signals', () => {
  const signals = extractRoutingSignals('怎么办', 'auto')
  assert.equal(signals.ambiguous, true)
  assert.equal(signals.confidence, 'low')
  assert.equal(signals.taskTemplateId, 'feature')
})

test('balanced preset resolves implementer by difficulty on DeepSeek ladder', () => {
  const preset = findRoutingPreset(defaultRoutingConfig(), 'balanced')
  const simple = resolveBindingForDifficulty(preset.roles.implementer, 'simple')
  const complex = resolveBindingForDifficulty(preset.roles.implementer, 'complex')
  assert.equal(simple.primary.providerId, 'deepseek')
  assert.equal(simple.primary.modelId, 'deepseek-flash')
  assert.equal(complex.primary.modelId, 'deepseek-v4-pro')
  assert.equal(preset.roles.visualReviewer.primary.modelId, 'deepseek-flash')
  assert.equal(countProvidersInPreset(preset), 1)
})

test('companion expert slot remaps only codeReviewer by default', () => {
  const config = normalizeRoutingConfig({
    ...defaultRoutingConfig(),
    homeProviderId: 'deepseek',
    companionProviderId: 'zhipu',
    companionExpertRoles: ['codeReviewer']
  })
  const preset = findRoutingPreset(config, 'balanced')
  assert.equal(preset.roles.implementer.primary.providerId, 'deepseek')
  assert.equal(preset.roles.codeReviewer.primary.providerId, 'zhipu')
  assert.equal(preset.roles.visualReviewer.primary.providerId, 'deepseek')
  assert.equal(countProvidersInPreset(preset), 2)
})

test('materializePresetForHome remaps ladder when home vendor changes', () => {
  const source = BUILTIN_ROUTING_PRESETS.find((preset) => preset.id === 'balanced')!
  const remapped = materializePresetForHome(source, 'dashscope')
  const ladder = buildHomeProviderLadder('dashscope')
  assert.equal(remapped.roles.implementer.primary.providerId, 'dashscope')
  assert.equal(remapped.roles.visualReviewer.primary.modelId, ladder.vision.modelId)
  assert.equal(countProvidersInPreset(remapped), 1)
})

test('routing signal model parser keeps seed flags on partial payloads', () => {
  const seed = extractRoutingSignals('界面预览坏了', 'auto')
  const parsed = parseRoutingSignalToolArgs({
    taskTemplateId: 'ui',
    difficulty: 'standard',
    needsVision: true,
    needsDebug: false,
    rationale: 'GUI 问题'
  }, seed)
  assert.ok(parsed)
  assert.equal(parsed?.taskTemplateId, 'ui')
  assert.equal(parsed?.confidence, 'high')
  assert.equal(parsed?.ambiguous, false)
})

test('buildRouteDecisionFromSignals hybrid source is preserved', () => {
  const signals = extractRoutingSignals('请为模组做一个设置 GUI 界面', 'auto')
  const decision = buildRouteDecisionFromSignals({ ...signals, ambiguous: false, confidence: 'high' }, 'hybrid', 'develop')
  assert.equal(decision.source, 'hybrid')
  assert.ok(decision.reason.includes('混合'))
})

test('executableRolesForIntent knowledge path stays readonly', () => {
  const decision = buildStaticRouteDecision('Minecraft 方块 ID 是什么意思', 'knowledge', false, 'develop')
  const roles = executableRolesForIntent(decision, 'develop')
  assert.ok(roles.includes('explorer'))
  assert.ok(roles.includes('summarizer'))
  assert.equal(roles.includes('implementer'), false)
})

test('routing config sanitizes home/companion and hard limits', () => {
  const config = normalizeRoutingConfig({
    onboardingCompleted: true,
    homeProviderId: 'deepseek',
    companionProviderId: 'deepseek',
    companionExpertRoles: ['codeReviewer', 'visualReviewer', 'implementer'],
    hardLimits: { maxReadonlyConcurrency: 99, maxDelegations: -3, maxExpertRepairHandoffs: 8 },
    presets: [{ id: 'bad' }]
  })
  assert.equal(config.homeProviderId, 'deepseek')
  assert.equal(config.companionProviderId, undefined)
  assert.deepEqual(config.companionExpertRoles, ['codeReviewer', 'visualReviewer'])
  assert.equal(config.hardLimits.maxReadonlyConcurrency, 3)
  assert.equal(config.hardLimits.maxDelegations, 1)
  assert.equal(config.hardLimits.maxExpertRepairHandoffs, 3)
  assert.equal(config.presets.length, 0)
  assert.equal(findRoutingPreset(config, 'missing').id, 'balanced')
  assert.ok(allRoutingPresets(defaultRoutingConfig()).length >= 7)
})

test('custom preset with byDifficulty remains valid after normalize', () => {
  const source = findRoutingPreset(defaultRoutingConfig(), 'balanced')
  const custom = {
    ...source,
    id: 'custom-tier',
    label: '自定义档位',
    description: '测试',
    builtIn: false,
    roles: Object.fromEntries(AGENT_ROLE_IDS.map((role) => [role, {
      ...source.roles[role],
      fallbacks: [...source.roles[role].fallbacks],
      byDifficulty: source.roles[role].byDifficulty
        ? Object.fromEntries(Object.entries(source.roles[role].byDifficulty!).map(([tier, binding]) => [tier, {
          primary: { ...binding.primary },
          ...(binding.fallbacks ? { fallbacks: binding.fallbacks.map((item) => ({ ...item })) } : {})
        }]))
        : undefined
    }]))
  }
  const config = normalizeRoutingConfig({
    onboardingCompleted: true,
    homeProviderId: 'deepseek',
    companionExpertRoles: ['codeReviewer'],
    defaultSelection: { mode: 'routed', strategyId: 'custom-tier', taskTemplateId: 'auto' },
    hardLimits: defaultRoutingConfig().hardLimits,
    presets: [custom]
  })
  assert.equal(config.presets.length, 1)
  assert.ok(config.presets[0].roles.implementer.byDifficulty?.simple)
})

test('Test Lab collaboration projection preserves single-model proof without secrets', () => {
  const projected = collaborationForAutomation({
    id: 'role_1', roleId: 'planner', providerId: 'minimax', modelId: 'MiniMax-M3',
    status: 'completed', startedAt: 10, endedAt: 20, summary: '职责完成'
  })
  assert.equal(projected.providerId, 'minimax')
  assert.equal(projected.modelId, 'MiniMax-M3')
  assert.equal('apiKey' in projected, false)
})

test('Test Lab retains only structural plan/game-test evidence', () => {
  assert.equal(toolArgsForAutomation('mc_test_scenario', '{"actions":[]}'), '{"actions":[]}')
  assert.equal(toolOutputForAutomation('mc_run_test', '{"verdict":"PASS"}'), '{"verdict":"PASS"}')
  assert.equal(toolArgsForAutomation('configure_provider', '{"apiKey":"secret"}'), undefined)
  assert.equal(toolOutputForAutomation('read_file', 'source'), undefined)
})
