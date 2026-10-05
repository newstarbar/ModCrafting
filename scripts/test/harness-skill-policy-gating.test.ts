import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Registry } from '../../src/renderer/src/harness/tools.ts'
import { readSkillTool } from '../../src/renderer/src/harness/skill-tools.ts'
import {
  getBuiltinToolPolicy,
  isExploreTool,
  isKnowledgeTool,
  isProjectWriteTool,
  isWriteTool,
  planToolNames,
  recommendedToolNames
} from '../../src/renderer/src/harness/tool-policy.ts'
import { isPlanPostLockTool } from '../../src/renderer/src/harness/plan-phase-gate.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const readSource = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

test('read_skill: 中央策略目录里声明为 knowledge.read', () => {
  const policy = getBuiltinToolPolicy('read_skill')
  assert.ok(policy, 'read_skill 必须在 BUILTIN_TOOL_POLICIES 中登记，否则启动即失败')
  assert.deepEqual(policy.capabilities, ['knowledge.read'])
  assert.equal(policy.executionClass, 'knowledge')
  assert.equal(policy.cancellable, true)
})

test('read_skill: 分类辅助判定只读，不是写入也不是探索工具', () => {
  assert.equal(isKnowledgeTool('read_skill'), true)
  assert.equal(isExploreTool('read_skill'), false)
  assert.equal(isWriteTool('read_skill'), false)
  assert.equal(isProjectWriteTool('read_skill'), false)
})

test('read_skill: 通过 Plan 阶段与探索锁的所有门', () => {
  // Plan 白名单按能力派生，知识工具自动在内
  assert.equal(planToolNames().includes('read_skill'), true)
  // 计划锁定后仍允许知识工具（否则提示词说能查、白名单却拒绝）
  assert.equal(isPlanPostLockTool('read_skill'), true)
  // 只读锁过滤只摘 project.read，read_skill 不在其列
  assert.equal(isExploreTool('read_skill', getBuiltinToolPolicy('read_skill')), false)
})

test('read_skill: 出现在各步骤类型的推荐工具集里', () => {
  for (const kind of ['inspect', 'write', 'recipe', 'mixin', 'build', 'game_test'] as const) {
    assert.equal(recommendedToolNames(kind).includes('read_skill'), true, `${kind} 步骤应推荐 read_skill`)
  }
})

test('read_skill: 注册时自动继承目录策略，validatePolicies 不抛', () => {
  const registry = new Registry()
  registry.add(readSkillTool)
  assert.equal(registry.get('read_skill')?.name, 'read_skill')
  assert.equal(registry.policyFor('read_skill')?.capabilities.includes('knowledge.read'), true)
  assert.deepEqual(registry.schemas()[0]?.parameters, readSkillTool.schema)
  registry.validatePolicies()
})

test('read_skill: 全量装配后仍在注册表里', async () => {
  // tool-definitions 依赖生成态数据（src/renderer/src/data/items.ts）与 npm 依赖，
  // 缺其中任一项时跳过，不算回归。
  let registerModCraftingTools: ((registry: Registry, options?: { disabledTools?: string[] }) => void) | null = null
  try {
    registerModCraftingTools = (await import('../../src/renderer/src/harness/tool-definitions.ts')).registerModCraftingTools
  } catch {
    return
  }
  const registry = new Registry()
  registerModCraftingTools!(registry)
  assert.equal(registry.get('read_skill')?.name, 'read_skill')
  assert.equal(registry.policyFor('read_skill')?.capabilities.includes('knowledge.read'), true)
})

test('read_skill: 无条件登记在内置工具装配清单里', () => {
  const source = readSource(path.join('src', 'renderer', 'src', 'harness', 'tool-definitions.ts'))
  assert.match(source, /import \{ readSkillTool \} from "\.\/skill-tools\.ts"/)
  // 数组项形式登记（不是条件登记），保证 catalog 逐轮字节稳定
  assert.match(source, /readSkillTool,\n\s*\.\.\.MC_OBSERVER_TOOLS/)
})

test('read_skill: Chat 固定工具集两处引用同一常量', () => {
  const source = readSource(path.join('src', 'renderer', 'src', 'harness', 'agent.ts'))
  const declaration = /const CHAT_TOOL_NAMES = \[([^\]]*)\];/.exec(source)
  assert.ok(declaration, 'agent.ts 应声明 CHAT_TOOL_NAMES')
  assert.match(declaration[1], /"read_skill"/)
  // 过滤与快照两处都从该常量构造，避免「能选到但被拒」
  const uses = source.split('new Set(CHAT_TOOL_NAMES)').length - 1
  assert.equal(uses, 2, `CHAT_TOOL_NAMES 应在过滤与快照两处各引用一次，实际 ${uses}`)
  assert.doesNotMatch(source, /new Set\(\["read_file", "explain_code", "fabric_docs_search"\]\)/)
})

test('技能索引在三种模式的系统提示词里都有落点', () => {
  const source = readSource(path.join('src', 'renderer', 'src', 'harness', 'controller.ts'))
  assert.match(source, /const skillIndex = await this\.buildSkillIndex\(\);/)
  // chat 分支与 plan/execute 分支各注入一次
  const injections = source.split('\n${skillIndex}\n').length - 1
  assert.equal(injections, 2, `system prompt 应有两处技能索引注入，实际 ${injections}`)
  assert.match(source, /formatSkillIndex\(await window\.api\.listSkills\(\)\)/)
})

test('技能启停通过既有配置事件失效索引', () => {
  const runtime = readSource(path.join('src', 'renderer', 'src', 'harness', 'session-runtime.ts'))
  assert.match(runtime, /public invalidateSkillIndex\(\): void/)
  assert.match(runtime, /rt\.controller\.invalidateSkillIndex\(\)/)
  const controller = readSource(path.join('src', 'renderer', 'src', 'harness', 'controller.ts'))
  assert.match(controller, /invalidateSkillIndex\(\)[\s\S]{0,120}this\.lastSystemMode = null/)
  const chatPanel = readSource(path.join('src', 'renderer', 'src', 'components', 'ChatPanel.tsx'))
  assert.match(chatPanel, /SessionRuntimeManager\.getInstance\(\)\.invalidateSkillIndex\(\)/)
})
