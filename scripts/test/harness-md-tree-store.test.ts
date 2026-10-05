import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createMdTreeStore, sanitizeRelPath } from '../../src/main/md-tree-store.ts'

function tempTree(): { root: string; bundled: string; override: string; store: ReturnType<typeof createMdTreeStore> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-md-tree-'))
  const bundled = path.join(root, 'bundled')
  const override = path.join(root, 'override')
  fs.mkdirSync(bundled, { recursive: true })
  return { root, bundled, override, store: createMdTreeStore({ bundledRoot: bundled, overrideRoot: override }) }
}

function write(dir: string, rel: string, content: string): void {
  const target = path.join(dir, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf-8')
}

test('sanitizeRelPath 归一化分隔符并丢弃空段与点段', () => {
  assert.equal(sanitizeRelPath('fabric\\docs\\a.md'), 'fabric/docs/a.md')
  assert.equal(sanitizeRelPath('/leading/slash.md'), 'leading/slash.md')
  assert.equal(sanitizeRelPath('a/./b.md'), 'a/b.md')
  assert.equal(sanitizeRelPath(''), '')
})

test('sanitizeRelPath 拒绝穿越、绝对路径与盘符', () => {
  assert.equal(sanitizeRelPath('../escape.md'), '')
  assert.equal(sanitizeRelPath('a/../../escape.md'), '')
  assert.equal(sanitizeRelPath('C:/Windows/x.md'), '')
  assert.equal(sanitizeRelPath('a\u0000b.md'), '')
})

test('list 只收集 .md 并递归子目录', () => {
  const tree = tempTree()
  try {
    write(tree.bundled, 'a.md', 'A')
    write(tree.bundled, 'sub/dir/b.md', 'B')
    write(tree.bundled, 'sub/ignored.txt', 'nope')
    assert.deepEqual(tree.store.list().map((f) => f.path), ['a.md', 'sub/dir/b.md'])
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('缺失的 bundledRoot 返回空列表而不是抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-md-tree-empty-'))
  try {
    const store = createMdTreeStore({ bundledRoot: path.join(root, 'nope'), overrideRoot: path.join(root, 'also-nope') })
    assert.deepEqual(store.list(), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('read 优先返回用户覆盖层，并标注 source', () => {
  const tree = tempTree()
  try {
    write(tree.bundled, 'x.md', 'bundled text')
    assert.equal(tree.store.read('x.md').source, 'bundled')
    assert.match(tree.store.read('x.md').content ?? '', /bundled text/)
    write(tree.override, 'x.md', 'override text')
    const after = tree.store.read('x.md')
    assert.equal(after.source, 'override')
    assert.match(after.content ?? '', /override text/)
    assert.equal(tree.store.list().find((f) => f.path === 'x.md')?.overridden, true)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('list 收录只在覆盖层存在的文件', () => {
  const tree = tempTree()
  try {
    tree.store.save('mine/SKILL.md', 'hello')
    const entry = tree.store.list().find((f) => f.path === 'mine/SKILL.md')
    assert.ok(entry)
    assert.equal(entry.bundled, false)
    assert.equal(entry.overridden, true)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('save 写入覆盖层，deleteOverride 回落到内置版本', () => {
  const tree = tempTree()
  try {
    write(tree.bundled, 's.md', 'bundled')
    assert.equal(tree.store.save('s.md', 'user').success, true)
    assert.match(tree.store.read('s.md').content ?? '', /user/)
    assert.equal(tree.store.deleteOverride('s.md').success, true)
    assert.equal(tree.store.read('s.md').source, 'bundled')
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('越界路径的 read/save 被拒绝且不写出文件', () => {
  const tree = tempTree()
  try {
    assert.equal(tree.store.read('../evil.md').success, false)
    assert.equal(tree.store.save('../evil.md', 'x').success, false)
    assert.equal(fs.existsSync(path.join(tree.root, 'evil.md')), false)
    assert.equal(fs.existsSync(path.join(tree.override, '..', 'evil.md')), false)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})

test('未覆盖时 hasOverride 为 false，覆盖后为 true', () => {
  const tree = tempTree()
  try {
    write(tree.bundled, 'h.md', 'bundled')
    assert.equal(tree.store.hasOverride('h.md'), false)
    tree.store.save('h.md', 'user')
    assert.equal(tree.store.hasOverride('h.md'), true)
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true })
  }
})
