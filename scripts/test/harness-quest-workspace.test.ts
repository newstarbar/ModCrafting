import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { questWorkspace } from '../../packages/modcrafting-core/src/quest-workspace.ts'
import { readChapter } from '../../packages/modcrafting-core/src/quest-model.ts'

const roots: string[] = []

test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const CHAPTER = `{
	group: ""
	id: "0A1B2C3D4E5F6071"
	images: []
	order_index: 0
	quest_links: []
	quests: [
		{
			dependencies: []
			id: "0000000000000001"
			tasks: [{ id: "0000000000000011", type: "checkmark" }]
			x: 0.0d
			y: 0.0d
		}
		{
			dependencies: ["0000000000000001"]
			id: "0000000000000002"
			x: 1.5d
			y: 0.0d
		}
	]
}`

const LANG = `{
	chapter.0A1B2C3D4E5F6071.title: "第一章"
	quest.0000000000000001.title: "开始"
	quest.0000000000000002.title: "第二步"
	quest.0000000000000002.quest_desc: ["先做点事", "再做点事"]
}`

interface Fixture {
  root: string
  questRoot: string
  chapterFile: string
  langFile: string
}

function fixture(options: { withBook?: boolean } = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'modcrafting-quest-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src', 'main', 'resources'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'main', 'resources', 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'quest_demo', version: '0.1.0' }), 'utf8')
  writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\n', 'utf8')
  writeFileSync(path.join(root, 'gradle.properties'), 'minecraft_version=1.21.4\n', 'utf8')

  const questRoot = path.join(root, 'config', 'ftbquests', 'quests')
  if (options.withBook !== false) {
    mkdirSync(path.join(questRoot, 'chapters'), { recursive: true })
    mkdirSync(path.join(questRoot, 'lang'), { recursive: true })
    writeFileSync(path.join(questRoot, 'chapter_groups.snbt'), '{ chapter_groups: [] }\n', 'utf8')
    writeFileSync(path.join(questRoot, 'chapters', 'chapter_1.snbt'), CHAPTER, 'utf8')
    writeFileSync(path.join(questRoot, 'lang', 'zh_cn.snbt'), LANG, 'utf8')
  }
  return {
    root,
    questRoot,
    chapterFile: path.join(questRoot, 'chapters', 'chapter_1.snbt'),
    langFile: path.join(questRoot, 'lang', 'zh_cn.snbt')
  }
}

test('list reports chapters, titles and the current revision', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })

  assert.equal(listed.ok, true)
  assert.equal(listed.chapters.length, 1)
  assert.equal(listed.chapters[0].file, 'chapters/chapter_1.snbt')
  assert.equal(listed.chapters[0].title, '第一章')
  assert.equal(listed.chapters[0].questCount, 2)
  assert.equal(listed.chapters[0].problems, 0)
  assert.deepEqual(listed.locales, ['zh_cn'])
  assert.match(listed.revision, /^[a-f0-9]{64}$/)
})

test('read returns the graph the workbench renders', () => {
  const f = fixture()
  const read = questWorkspace(f.root, { action: 'read', workspacePath: f.root })

  assert.equal(read.ok, true)
  const chapter = read.book.chapters[0]
  assert.equal(chapter.title, '第一章')
  assert.equal(chapter.quests.length, 2)
  assert.equal(chapter.quests[0].title, '开始')
  assert.deepEqual(chapter.quests[1].description, ['先做点事', '再做点事'])
  assert.deepEqual(chapter.quests[1].dependencies, ['0000000000000001'])
  assert.equal(chapter.quests[0].tasks[0].type, 'checkmark')
  assert.deepEqual(chapter.problems, [])
})

test('preview reports the diff without touching the disk', () => {
  const f = fixture()
  const before = readFileSync(f.chapterFile, 'utf8')
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })

  const previewed = questWorkspace(f.root, {
    action: 'preview',
    workspacePath: f.root,
    expectedRevision: listed.revision,
    ops: [{ op: 'move', chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 3, y: 4 }]
  })

  assert.equal(previewed.ok, true)
  assert.equal(previewed.files.length, 1)
  assert.equal(previewed.files[0].file, 'chapters/chapter_1.snbt')
  assert.match(previewed.files[0].before ?? '', /x: 0\.0d/)
  assert.match(previewed.files[0].after, /x: 3\.0d/)
  assert.equal(readFileSync(f.chapterFile, 'utf8'), before, 'preview must not write')
  assert.notEqual(previewed.previewRevision, listed.revision)
})

test('save commits, bumps the revision and leaves no temporary files', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 3, y: 4 }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })

  const saved = questWorkspace(f.root, {
    action: 'save',
    workspacePath: f.root,
    expectedRevision: listed.revision,
    previewRevision: previewed.previewRevision,
    ops
  })

  assert.equal(saved.ok, true)
  assert.deepEqual(saved.written, ['chapters/chapter_1.snbt'])
  assert.notEqual(saved.revision, listed.revision)
  assert.match(readFileSync(f.chapterFile, 'utf8'), /x: 3\.0d/)

  const reread = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  assert.equal(reread.revision, saved.revision)
  const leftovers = readdirSync(path.join(f.questRoot, 'chapters')).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('a stale expected revision is refused with a conflict', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 1, y: 1 }]
  assert.throws(
    () => questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: '0'.repeat(64), ops }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'QUEST_CONFLICT'
  )
  assert.equal(listed.revision.length, 64)
})

test('a save whose preview is out of date is refused', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 2, y: 2 }]
  questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })

  assert.throws(
    () => questWorkspace(f.root, {
      action: 'save',
      workspacePath: f.root,
      expectedRevision: listed.revision,
      previewRevision: '1'.repeat(64),
      ops
    }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'QUEST_PREVIEW_STALE'
  )
})

test('editing text touches only the language file', () => {
  const f = fixture()
  const chapterBefore = readFileSync(f.chapterFile, 'utf8')
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'set_text' as const, locale: 'zh_cn', questId: '0000000000000001', title: '新的开始', description: ['第一行'] }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })

  assert.deepEqual(previewed.files.map((file) => file.file), ['lang/zh_cn.snbt'])

  const saved = questWorkspace(f.root, { action: 'save', workspacePath: f.root, expectedRevision: listed.revision, previewRevision: previewed.previewRevision, ops })
  assert.equal(saved.ok, true)
  assert.equal(readFileSync(f.chapterFile, 'utf8'), chapterBefore, 'the chapter file must not be rewritten')

  const reread = questWorkspace(f.root, { action: 'read', workspacePath: f.root })
  assert.equal(reread.book.chapters[0].quests[0].title, '新的开始')
  assert.deepEqual(reread.book.chapters[0].quests[0].description, ['第一行'])
})

test('removing a quest also clears its lang entries and dangling dependencies', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'remove_quest' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001' }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })
  const saved = questWorkspace(f.root, { action: 'save', workspacePath: f.root, expectedRevision: listed.revision, previewRevision: previewed.previewRevision, ops })

  assert.equal(saved.ok, true)
  assert.deepEqual(saved.written.sort(), ['chapters/chapter_1.snbt', 'lang/zh_cn.snbt'])

  const chapter = readChapter(readFileSync(f.chapterFile, 'utf8'))
  assert.deepEqual(chapter.quests.map((quest) => quest.id), ['0000000000000002'])
  assert.deepEqual(chapter.quests[0].dependencies, [], 'the orphaned dependency is dropped')
  assert.doesNotMatch(readFileSync(f.langFile, 'utf8'), /0000000000000001/)
})

test('adding a quest generates a stable id and optional title', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [
    { op: 'add_quest' as const, chapter: 'chapter_1.snbt', x: 4, y: 4 },
    { op: 'add_quest' as const, chapter: 'chapter_1.snbt', x: 5, y: 5, questId: 'ABCDEF0123456789' }
  ]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })
  questWorkspace(f.root, { action: 'save', workspacePath: f.root, expectedRevision: listed.revision, previewRevision: previewed.previewRevision, ops })

  const chapter = readChapter(readFileSync(f.chapterFile, 'utf8'))
  assert.equal(chapter.quests.length, 4)
  assert.match(chapter.quests[2].id, /^[0-9A-F]{16}$/)
  assert.equal(chapter.quests[3].id, 'ABCDEF0123456789')
  assert.deepEqual(chapter.quests[3].dependencies, [])
})

test('dependency operations validate both ends', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'add_dependency' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', dependsOn: '0000000000000002' }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })
  questWorkspace(f.root, { action: 'save', workspacePath: f.root, expectedRevision: listed.revision, previewRevision: previewed.previewRevision, ops })

  const chapter = readChapter(readFileSync(f.chapterFile, 'utf8'))
  assert.deepEqual(chapter.quests[0].dependencies, ['0000000000000002'])

  assert.throws(
    () => questWorkspace(f.root, {
      action: 'preview',
      workspacePath: f.root,
      expectedRevision: null,
      ops: [{ op: 'add_dependency', chapter: 'chapter_1.snbt', questId: '0000000000000001', dependsOn: 'DEADBEEF' }]
    }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'QUEST_NOT_FOUND'
  )
})

test('validate surfaces graph problems instead of hiding them', () => {
  const f = fixture()
  writeFileSync(f.chapterFile, `{
	id: "C"
	order_index: 0
	quests: [{ id: "A", dependencies: ["MISSING"], x: 0.0d, y: 0.0d }]
	quest_links: []
	images: []
}
`, 'utf8')

  const report = questWorkspace(f.root, { action: 'validate', workspacePath: f.root })
  assert.equal(report.ok, false)
  assert.equal(report.code, 'QUEST_GRAPH_INVALID')
  assert.ok(report.problems.some((entry) => entry.problem.includes('不存在的 MISSING')))
  assert.match(String(report.remediation), /remove_dependency/)
})

test('a missing book says what to do instead of returning an empty list', () => {
  const f = fixture({ withBook: false })
  assert.throws(
    () => questWorkspace(f.root, { action: 'list', workspacePath: f.root }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'QUEST_BOOK_MISSING'
  )
  assert.equal(existsSync(path.join(f.questRoot, 'chapters')), false)
})

test('a no-op save writes nothing and keeps the revision', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  // Moving a quest to where it already is.
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 0, y: 0 }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })
  const saved = questWorkspace(f.root, {
    action: 'save',
    workspacePath: f.root,
    expectedRevision: listed.revision,
    previewRevision: previewed.previewRevision,
    ops
  })

  assert.equal(saved.ok, true)
  assert.equal(saved.noop, true)
  assert.deepEqual(saved.written, [])
  assert.equal(saved.revision, listed.revision)
})

test('file revisions let a caller detect out-of-band edits per file', () => {
  const f = fixture()
  const listed = questWorkspace(f.root, { action: 'list', workspacePath: f.root })
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 9, y: 9 }]
  const previewed = questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: listed.revision, ops })

  // Simulate another editor changing the lang file between preview and save.
  writeFileSync(f.langFile, LANG.replace('第一章', '被外部改过的标题'), 'utf8')

  assert.throws(
    () => questWorkspace(f.root, {
      action: 'save',
      workspacePath: f.root,
      expectedRevision: listed.revision,
      expectedFileRevisions: { 'lang/zh_cn.snbt': '2'.repeat(64) },
      previewRevision: previewed.previewRevision,
      ops
    }),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === 'QUEST_CONFLICT'
  )
})

test('a pack with no authored project can still read its book', () => {
  // The common case: a downloaded pack, no Gradle project inside, quests at the root.
  const root = mkdtempSync(path.join(tmpdir(), 'modcrafting-quest-pack-'))
  roots.push(root)
  mkdirSync(path.join(root, 'mods'), { recursive: true })
  mkdirSync(path.join(root, '.modcrafting'), { recursive: true })
  writeFileSync(path.join(root, '.modcrafting', 'workspace.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'modpack',
    name: 'Downloaded Pack',
    targetId: 'fabric@1.21.4',
    members: [],
    entries: [],
    runtime: { maxInstances: 2, launcher: 'standalone' }
  }), 'utf8')
  const questRoot = path.join(root, 'config', 'ftbquests', 'quests')
  mkdirSync(path.join(questRoot, 'chapters'), { recursive: true })
  mkdirSync(path.join(questRoot, 'lang'), { recursive: true })
  writeFileSync(path.join(questRoot, 'chapter_groups.snbt'), '{ chapter_groups: [] }\n', 'utf8')
  writeFileSync(path.join(questRoot, 'chapters', 'chapter_1.snbt'), CHAPTER, 'utf8')
  writeFileSync(path.join(questRoot, 'lang', 'zh_cn.snbt'), LANG, 'utf8')

  const listed = questWorkspace(root, { action: 'list', workspacePath: root })
  assert.equal(listed.ok, true)
  assert.equal(listed.chapters.length, 1)
  assert.equal(listed.chapters[0].title, '第一章')
  assert.equal(listed.target, null, 'a pack without a member project has no member target')

  // Saving must work here too: the book is at the pack root, not inside a project.
  const ops = [{ op: 'move' as const, chapter: 'chapter_1.snbt', questId: '0000000000000001', x: 5, y: 5 }]
  const previewed = questWorkspace(root, { action: 'preview', workspacePath: root, expectedRevision: listed.revision, ops })
  const saved = questWorkspace(root, { action: 'save', workspacePath: root, expectedRevision: listed.revision, previewRevision: previewed.previewRevision, ops })
  assert.equal(saved.ok, true)
  assert.match(readFileSync(path.join(questRoot, 'chapters', 'chapter_1.snbt'), 'utf8'), /x: 5\.0d/)
})

test('operations are validated before anything is read', () => {
  const f = fixture()
  assert.throws(() => questWorkspace(f.root, { action: 'list', workspacePath: f.root, extra: 1 }), /unrecognized|Unrecognized/i)
  assert.throws(
    () => questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: null, ops: [] }),
    /array|too_small|min/i
  )
  assert.throws(
    () => questWorkspace(f.root, { action: 'preview', workspacePath: f.root, expectedRevision: null, ops: [{ op: 'move', chapter: '../escape.snbt', questId: 'A', x: 0, y: 0 }] }),
    /章节文件名/
  )
})
