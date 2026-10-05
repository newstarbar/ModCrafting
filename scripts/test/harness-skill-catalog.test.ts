import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createMdTreeStore } from '../../src/main/md-tree-store.ts'
import { isSkillId, listSkillsFromTree, loadSkillFromTree, parseSkillMarkdown } from '../../src/main/skill-catalog.ts'

test('frontmatter: 解析 name 与 description 并从正文剥离', () => {
  const parsed = parseSkillMarkdown('---\nname: foo\ndescription: 做 foo 的流程\n---\n\n# 标题\n步骤一\n', 'fallback')
  assert.equal(parsed.name, 'foo')
  assert.equal(parsed.description, '做 foo 的流程')
  assert.equal(parsed.body.trim(), '# 标题\n步骤一')
})

test('frontmatter: 无 frontmatter 时回退目录名与首个正文行', () => {
  const parsed = parseSkillMarkdown('# 指南\n这是第一句说明。\n', 'fallback-id')
  assert.equal(parsed.name, 'fallback-id')
  assert.equal(parsed.description, '这是第一句说明。')
  assert.match(parsed.body, /# 指南/)
})

test('frontmatter: 缺 description 时取首行非标题文本，上限 120 字符', () => {
  const long = 'x'.repeat(200)
  const parsed = parseSkillMarkdown(`---\nname: only-name\n---\n\n${long}\n`, 'only-name')
  assert.equal(parsed.name, 'only-name')
  assert.equal(parsed.description.length, 120)
})

test('frontmatter: 兼容 CRLF 与 UTF-8 BOM', () => {
  const parsed = parseSkillMarkdown('﻿---\r\nname: crlf\r\ndescription: 换行测试\r\n---\r\n\r\n正文\r\n', 'fallback')
  assert.equal(parsed.name, 'crlf')
  assert.equal(parsed.description, '换行测试')
  assert.equal(parsed.body.trim(), '正文')
})

test('frontmatter: 引号包裹的值被脱引号，未知字段被忽略', () => {
  const parsed = parseSkillMarkdown('---\nname: "quoted"\nvendor: nobody\ndescription: \'单引号\'\n---\n正文\n', 'fallback')
  assert.equal(parsed.name, 'quoted')
  assert.equal(parsed.description, '单引号')
})

test('isSkillId: 只接受小写目录名风格 id', () => {
  assert.equal(isSkillId('mixin-nested_target'), true)
  assert.equal(isSkillId('a'), true)
  assert.equal(isSkillId('../evil'), false)
  assert.equal(isSkillId('A'), false)
  assert.equal(isSkillId('-lead'), false)
  assert.equal(isSkillId(''), false)
})

function tempSkillTree(): { root: string; store: ReturnType<typeof createMdTreeStore> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-skill-'))
  const bundled = path.join(root, 'bundled')
  const override = path.join(root, 'override')
  fs.mkdirSync(bundled, { recursive: true })
  return { root, store: createMdTreeStore({ bundledRoot: bundled, overrideRoot: override }) }
}

test('listSkillsFromTree: 只收 <id>/SKILL.md，按 id 排序，跳过畸形布局', () => {
  const tree = tempSkillTree()
  try {
    const store = tree.store
    const bundled = path.join(tree.root, 'bundled')
    const write = (rel: string, content: string) => {
      const target = path.join(bundled, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf-8')
    }
    write('b-skill/SKILL.md', '---\nname: b-skill\ndescription: B 流程\n---\nB 正文\n')
    write('a-skill/SKILL.md', '---\nname: a-skill\ndescription: A 流程\n---\nA 正文\n')
    write('README.md', '根目录散文件，不是技能')
    write('nested/deep/SKILL.md', '多层目录，不是合法 id 布局')
    write('Bad_Id/SKILL.md', '大写 id 不合法')

    const list = listSkillsFromTree(store, [])
    assert.deepEqual(list.map((s) => s.id), ['a-skill', 'b-skill'])
    assert.equal(list[0].relPath, 'a-skill/SKILL.md')
    assert.equal(list[0].bundled, true)
    assert.equal(list[0].overridden, false)
    assert.equal(list[1].description, 'B 流程')
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('listSkillsFromTree: disabledSkills 只翻 enabled 标记，不隐藏技能', () => {
  const tree = tempSkillTree()
  try {
    const target = path.join(tree.root, 'bundled', 'one', 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '---\nname: one\ndescription: 一\n---\n正文\n', 'utf-8')
    const all = listSkillsFromTree(tree.store, [])
    assert.equal(all.length, 1)
    assert.equal(all[0].enabled, true)
    const off = listSkillsFromTree(tree.store, ['one'])
    assert.equal(off.length, 1)
    assert.equal(off[0].enabled, false)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('loadSkillFromTree: 返回去 frontmatter 的正文与来源', () => {
  const tree = tempSkillTree()
  try {
    const target = path.join(tree.root, 'bundled', 'one', 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '---\nname: one\ndescription: 一\n---\n第一步\n', 'utf-8')
    const res = loadSkillFromTree(tree.store, 'one', [])
    assert.equal(res.success, true)
    assert.equal(res.source, 'bundled')
    assert.equal(res.enabled, true)
    assert.equal(res.content.trim(), '第一步')
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('loadSkillFromTree: raw 原样返回，编辑回环不丢未知 frontmatter 字段', () => {
  const tree = tempSkillTree()
  const source = '---\nname: one\ndescription: 一\nlicense: MIT\n---\n\n正文\n'
  try {
    const target = path.join(tree.root, 'bundled', 'one', 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source, 'utf-8')
    const res = loadSkillFromTree(tree.store, 'one', [])
    assert.equal(res.raw, source)
    assert.equal((res.content ?? '').trim(), '正文')
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('loadSkillFromTree: 不存在的 id 与非法 id 都失败且不抛错', () => {
  const tree = tempSkillTree()
  try {
    assert.equal(loadSkillFromTree(tree.store, 'missing', []).success, false)
    const bad = loadSkillFromTree(tree.store, '../escape', [])
    assert.equal(bad.success, false)
    assert.match(bad.error ?? '', /非法技能 id/)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('loadSkillFromTree: 停用的技能依然可读（供设置界面编辑）', () => {
  const tree = tempSkillTree()
  try {
    const target = path.join(tree.root, 'bundled', 'one', 'SKILL.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '---\nname: one\ndescription: 一\n---\n正文\n', 'utf-8')
    const res = loadSkillFromTree(tree.store, 'one', ['one'])
    assert.equal(res.success, true)
    assert.equal(res.enabled, false)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})
