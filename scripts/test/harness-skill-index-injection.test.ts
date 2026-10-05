import test from 'node:test'
import assert from 'node:assert/strict'
import { Registry } from '../../src/renderer/src/harness/tools.ts'

// controller -> agent -> tool-call-validator 需要 ajv；未安装依赖的开发树里跳过而不算失败。
let Controller: (typeof import('../../src/renderer/src/harness/controller.ts'))['Controller'] | null = null
try {
  Controller = (await import('../../src/renderer/src/harness/controller.ts')).Controller
} catch {
  Controller = null
}
const skipWithoutDeps = Controller === null ? '需要已安装 npm 依赖（ajv 等）才能加载 controller' : false

interface FakeSkill {
  id: string
  name: string
  description: string
  relPath: string
  bundled: boolean
  overridden: boolean
  enabled: boolean
}

function skill(id: string, enabled = true): FakeSkill {
  return { id, name: id, description: `技能 ${id} 的说明`, relPath: `${id}/SKILL.md`, bundled: true, overridden: false, enabled }
}

function installWindow(skills: FakeSkill[]): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api: { listSkills: async () => skills } }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

type AnyController = {
  messages: Array<{ role: string; content: unknown }>
  updateSystemPrompt(mode: 'chat' | 'plan' | 'execute'): Promise<void>
  invalidateSkillIndex(): void
  lastSystemMode: string | null
}

function makeController(): AnyController {
  const controller = new Controller!({
    registry: new Registry(),
    projectPath: null,
    apiConfig: { endpoint: 'http://localhost:1/v1', apiKey: 'test', model: 'test-model' }
  })
  return controller as unknown as AnyController
}

function systemMessage(ctrl: AnyController): string {
  const message = ctrl.messages.find((m) => m.role === 'system')
  assert.ok(message, '应生成 system prompt')
  return String(message.content)
}

test('技能索引注入 chat 提示词，且只列出已启用技能', { skip: skipWithoutDeps }, async () => {
  const restore = installWindow([skill('mixin-pitfalls'), skill('disabled-one', false)])
  try {
    const ctrl = makeController()
    await ctrl.updateSystemPrompt('chat')
    const prompt = systemMessage(ctrl)
    assert.match(prompt, /## 可用技能/)
    assert.match(prompt, /`mixin-pitfalls`/)
    assert.doesNotMatch(prompt, /disabled-one/)
  } finally {
    restore()
  }
})

test('技能索引注入 plan 与 execute 提示词', { skip: skipWithoutDeps }, async () => {
  const restore = installWindow([skill('mixin-pitfalls')])
  try {
    for (const mode of ['plan', 'execute'] as const) {
      const ctrl = makeController()
      await ctrl.updateSystemPrompt(mode)
      const prompt = systemMessage(ctrl)
      assert.match(prompt, /## 可用技能/, `${mode} 模式缺少技能索引`)
      assert.match(prompt, /read_skill/)
    }
  } finally {
    restore()
  }
})

test('技能服务不可用时提示词仍可构建，不含技能段落', { skip: skipWithoutDeps }, async () => {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = undefined
  try {
    const ctrl = makeController()
    await ctrl.updateSystemPrompt('plan')
    assert.doesNotMatch(systemMessage(ctrl), /## 可用技能/)
  } finally {
    ;(globalThis as { window?: unknown }).window = prior
  }
})

test('同模式下不重建 system prompt（cache 友好）', { skip: skipWithoutDeps }, async () => {
  const restore = installWindow([skill('alpha')])
  try {
    const ctrl = makeController()
    await ctrl.updateSystemPrompt('plan')
    const first = systemMessage(ctrl)
    restore()
    installWindow([skill('alpha'), skill('beta')])
    await ctrl.updateSystemPrompt('plan')
    assert.equal(systemMessage(ctrl), first, '未失效缓存时同 mode 不应改变 system prompt')
  } finally {
    ;(globalThis as { window?: unknown }).window = undefined
  }
})

test('invalidateSkillIndex 后下一轮带上最新列表', { skip: skipWithoutDeps }, async () => {
  let restore = installWindow([skill('alpha')])
  try {
    const ctrl = makeController()
    await ctrl.updateSystemPrompt('plan')
    restore()
    restore = installWindow([skill('alpha'), skill('datagen-content')])
    ctrl.invalidateSkillIndex()
    assert.equal(ctrl.lastSystemMode, null)
    await ctrl.updateSystemPrompt('plan')
    assert.match(systemMessage(ctrl), /datagen-content/)
  } finally {
    restore()
  }
})
