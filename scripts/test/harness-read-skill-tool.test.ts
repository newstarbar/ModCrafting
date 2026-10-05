import test from 'node:test'
import assert from 'node:assert/strict'
import { formatSkillIndex, readSkillTool } from '../../src/renderer/src/harness/skill-tools.ts'
import type { ToolContext } from '../../src/renderer/src/harness/tools.ts'

interface FakeSkill {
  id: string
  name: string
  description: string
  relPath: string
  bundled: boolean
  overridden: boolean
  enabled: boolean
}

function skill(id: string, overrides: Partial<FakeSkill> = {}): FakeSkill {
  return {
    id,
    name: id,
    description: `${id} 的说明`,
    relPath: `${id}/SKILL.md`,
    bundled: true,
    overridden: false,
    enabled: true,
    ...overrides
  }
}

function installWindow(api: Record<string, unknown>): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

const ctx: ToolContext = { projectPath: null, callId: 'test-call' }

test('read_skill: 不带 id 返回已启用技能的索引', async () => {
  const restore = installWindow({
    listSkills: async () => [skill('alpha'), skill('beta', { enabled: false })],
    readSkill: async () => ({ success: false })
  })
  try {
    const text = String(await readSkillTool.execute(ctx, {}))
    assert.match(text, /## 可用技能/)
    assert.match(text, /`alpha`/)
    assert.doesNotMatch(text, /`beta`/)
  } finally {
    restore()
  }
})

test('read_skill: 带 id 返回去 frontmatter 的正文', async () => {
  const restore = installWindow({
    listSkills: async () => [skill('alpha')],
    readSkill: async (id: string) => ({
      success: true,
      id,
      name: 'alpha',
      description: 'alpha 的说明',
      content: '\n第一步\n第二步\n',
      source: 'bundled',
      enabled: true
    })
  })
  try {
    const text = String(await readSkillTool.execute(ctx, { id: 'alpha' }))
    assert.match(text, /【技能 · alpha】/)
    assert.match(text, /第一步\n第二步/)
  } finally {
    restore()
  }
})

test('read_skill: 未知 id 返回可发现的失败文案', async () => {
  const restore = installWindow({
    listSkills: async () => [skill('alpha')],
    readSkill: async () => ({ success: false, error: '技能不存在：nope' })
  })
  try {
    const text = String(await readSkillTool.execute(ctx, { id: 'nope' }))
    assert.match(text, /未找到技能：nope/)
    assert.match(text, /read_skill/)
  } finally {
    restore()
  }
})

test('read_skill: 停用的技能被拒绝并引导查看列表', async () => {
  const restore = installWindow({
    listSkills: async () => [skill('alpha', { enabled: false })],
    readSkill: async () => ({ success: true, id: 'alpha', name: 'alpha', content: '正文', enabled: false })
  })
  try {
    const text = String(await readSkillTool.execute(ctx, { id: 'alpha' }))
    assert.match(text, /已被用户停用/)
    assert.doesNotMatch(text, /正文/)
  } finally {
    restore()
  }
})

test('read_skill: window.api 缺失时返回服务不可用', async () => {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = undefined
  try {
    const text = String(await readSkillTool.execute(ctx, { id: 'alpha' }))
    assert.match(text, /read_skill 服务不可用/)
  } finally {
    ;(globalThis as { window?: unknown }).window = prior
  }
})

test('read_skill: window.api 缺少技能方法时同样不可用', async () => {
  const restore = installWindow({})
  try {
    const text = String(await readSkillTool.execute(ctx, {}))
    assert.match(text, /read_skill 服务不可用/)
  } finally {
    restore()
  }
})

test('read_skill: 工具元数据 —— 只读且 id 可选', () => {
  assert.equal(readSkillTool.name, 'read_skill')
  assert.equal(readSkillTool.readOnly(), true)
  assert.ok(readSkillTool.description.includes('技能包'))
  assert.equal(readSkillTool.schema.required, undefined)
})

test('formatSkillIndex: 空列表返回空串', () => {
  assert.equal(formatSkillIndex([]), '')
  assert.equal(formatSkillIndex([skill('a', { enabled: false })]), '')
})

test('formatSkillIndex: 排序稳定、超长描述被截断', () => {
  const long = '详'.repeat(200)
  const index = formatSkillIndex([skill('zeta'), skill('alpha'), skill('muted', { enabled: false }), skill('long', { description: long })])
  const lines = index.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(lines[0].includes('`alpha`'), true)
  assert.equal(lines.some((line) => line.includes('`muted`')), false)
  const longLine = lines.find((line) => line.includes('`long`')) ?? ''
  assert.ok(longLine.length < 130, `长描述应被裁剪：${longLine.length}`)
  assert.match(longLine, /…$/)
})

test('formatSkillIndex: 超过 20 条时截断并提示不带 id 调用', () => {
  const many = Array.from({ length: 25 }, (_unused, i) => skill(`skill-${String(i).padStart(2, '0')}`))
  const index = formatSkillIndex(many)
  const listed = index.split('\n').filter((line) => line.startsWith('- `')).length
  assert.equal(listed, 20)
  assert.match(index, /另有 5 个技能未列出/)
})
