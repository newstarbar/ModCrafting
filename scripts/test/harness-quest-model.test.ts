import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chapterGroupKey,
  chapterTitle,
  dependencyProblems,
  isQuestId,
  questDescription,
  questIdFrom,
  questKey,
  questTitle,
  readChapter,
  readChapterGroups,
  readLang,
  removeQuest,
  replaceQuest,
  withChapterTitle,
  withQuestText,
  withoutQuestText,
  writeChapter,
  writeChapterGroups,
  writeLang
} from '../../packages/modcrafting-core/src/quest-model.ts'

const CHAPTER = `{
	default_hide_dependency_lines: false
	default_quest_shape: ""
	filename: "chapter_1"
	group: ""
	icon: { id: "minecraft:book" }
	id: "0A1B2C3D4E5F6071"
	images: []
	order_index: 0
	quest_links: []
	quests: [
		{
			dependencies: []
			id: "0000000000000001"
			rewards: [{ id: "0000000000000011", item: { count: 1, id: "minecraft:bread" }, type: "item" }]
			shape: "hexagon"
			size: 1.5d
			tasks: [{ id: "0000000000000021", type: "checkmark" }]
			x: 0.0d
			y: 0.0d
		}
		{
			dependencies: ["0000000000000001"]
			id: "0000000000000002"
			tasks: [
				{ count: 5L, id: "0000000000000022", item: "minecraft:oak_log", type: "item" }
			]
			x: 1.5d
			y: 0.0d
		}
	]
}`

test('reads a chapter into typed quests, tasks and rewards', () => {
  const chapter = readChapter(CHAPTER)
  assert.equal(chapter.id, '0A1B2C3D4E5F6071')
  assert.equal(chapter.groupId, '')
  assert.equal(chapter.orderIndex, 0)
  assert.equal(chapter.quests.length, 2)

  const [first, second] = chapter.quests
  assert.equal(first.id, '0000000000000001')
  assert.equal(first.shape, 'hexagon')
  assert.equal(first.size, 1.5)
  assert.deepEqual(first.dependencies, [])
  assert.equal(first.tasks[0].type, 'checkmark')
  assert.equal(first.rewards[0].type, 'item')

  assert.deepEqual(second.dependencies, ['0000000000000001'])
  assert.equal(second.tasks[0].fields.count.t, 'long', 'a long count must stay a long')
  assert.equal(second.x, 1.5)

  // The chapter keeps fields it does not model, so saving cannot drop them.
  assert.equal(chapter.extra.filename.t, 'string')
  assert.equal(chapter.extra.default_hide_dependency_lines.t, 'byte')
})

test('a full read/write/read cycle preserves every field', () => {
  const chapter = readChapter(CHAPTER)
  const printed = writeChapter(chapter)
  const again = readChapter(printed)
  assert.deepEqual(again, chapter)
  assert.equal(writeChapter(again), printed, 'writing is idempotent')
})

test('the writer emits keys in alphabetical order so diffs stay small', () => {
  const printed = writeChapter(readChapter(CHAPTER))
  const keys = [...printed.matchAll(/^\t([A-Za-z_]+):/gm)].map((match) => match[1])
  assert.deepEqual(keys, [...keys].sort(), `chapter keys out of order:\n${keys.join(', ')}`)
  // Defaults that the file did not carry are not invented, except the two lists
  // FTB always expects.
  assert.match(printed, /quest_links: \[\]/)
  assert.match(printed, /images: \[\]/)
})

test('inline text survives, while new text is written to lang only', () => {
  const legacy = readChapter(`{
	id: "AAA"
	order_index: 0
	quests: [{ id: "BBB", title: "旧版内联标题", description: ["第一行"], x: 0.0d, y: 0.0d }]
}`)
  const quest = legacy.quests[0]
  assert.equal(quest.extra.title.t, 'string')

  // Re-emitting the chapter must not delete the inline text: that would be data loss.
  const reprinted = writeChapter(legacy)
  assert.match(reprinted, /title: "旧版内联标题"/)

  // Fallback reading works before and after a save.
  assert.equal(questTitle({}, quest), '旧版内联标题')
  assert.deepEqual(questDescription({}, quest), ['第一行'])

  // Editing text never touches the chapter file.
  const lang = withQuestText({}, 'BBB', { title: '新标题', description: ['甲', '乙'] })
  assert.equal(lang[questKey('BBB', 'title')], '新标题')
  assert.deepEqual(lang[questKey('BBB', 'quest_desc')], ['甲', '乙'])
  assert.equal(questTitle(lang, quest), '新标题', 'lang wins over inline')
  assert.deepEqual(questDescription(lang, quest), ['甲', '乙'])
})

test('clearing text removes the lang key instead of writing an empty string', () => {
  const lang = withQuestText({}, 'BBB', { title: 'x', description: ['y'] })
  const cleared = withQuestText(lang, 'BBB', { title: '', description: [] })
  assert.equal(questKey('BBB', 'title') in cleared, false)
  assert.equal(questKey('BBB', 'quest_desc') in cleared, false)

  assert.equal(chapterTitle(withChapterTitle({}, 'AAA', '第一章'), { id: 'AAA', groupId: '', orderIndex: 0, quests: [], questLinks: [], images: [], extra: {} }), '第一章')
  assert.equal(chapterGroupKey('G', 'title'), 'chapter_group.G.title')
})

test('deleting a quest also removes its lang entries and dangling dependencies', () => {
  const chapter = readChapter(CHAPTER)
  const lang = withQuestText({}, '0000000000000001', { title: '根任务' })
  const next = removeQuest(chapter, '0000000000000001')

  assert.equal(next.quests.length, 1)
  assert.deepEqual(next.quests[0].dependencies, [], 'the child must not point at a deleted quest')
  assert.equal(questKey('0000000000000001', 'title') in withoutQuestText(lang, '0000000000000001'), false)

  assert.throws(() => removeQuest(chapter, 'missing'), /没有任务/)
})

test('dependency validation catches unknown targets, self loops and cycles', () => {
  const chapter = readChapter(`{
	id: "C"
	order_index: 0
	quests: [
		{ id: "A", dependencies: ["B"], x: 0.0d, y: 0.0d },
		{ id: "B", dependencies: ["A"], x: 0.0d, y: 0.0d },
		{ id: "D", dependencies: ["D"], x: 0.0d, y: 0.0d },
		{ id: "E", dependencies: ["NOPE"], x: 0.0d, y: 0.0d }
	]
}`)
  const problems = dependencyProblems(chapter)
  assert.ok(problems.some((problem) => problem.includes('依赖自己')), problems.join('\n'))
  assert.ok(problems.some((problem) => problem.includes('不存在的 NOPE')), problems.join('\n'))
  assert.ok(problems.some((problem) => problem.includes('成环')), problems.join('\n'))
})

test('a clean chapter reports no dependency problems', () => {
  assert.deepEqual(dependencyProblems(readChapter(CHAPTER)), [])
})

test('replaceQuest keeps array position so the file order is stable', () => {
  const chapter = readChapter(CHAPTER)
  const target = chapter.quests[1]
  const moved = replaceQuest(chapter, { ...target, x: 9.5 })
  assert.equal(moved.quests[0].id, '0000000000000001')
  assert.equal(moved.quests[1].x, 9.5)
  assert.throws(() => replaceQuest(chapter, { ...target, id: 'missing' }), /没有任务/)
})

test('lang accepts both strings and string lists, and writes them sorted', () => {
  const entries = readLang(`{
	quest.AAA.title: "标题"
	quest.AAA.quest_desc: ["一", "二"]
	chapter.GGG.title: "组"
}`)
  assert.equal(entries['quest.AAA.title'], '标题')
  assert.deepEqual(entries['quest.AAA.quest_desc'], ['一', '二'])

  const printed = writeLang(entries)
  const keys = [...printed.matchAll(/^\t([^:]+):/gm)].map((match) => match[1])
  assert.deepEqual(keys, [...keys].sort())
  assert.deepEqual(readLang(printed), entries)

  assert.throws(() => readLang(`{ "a": { b: 1 } }`), /必须是字符串或字符串列表/)
})

test('chapter groups round-trip inside their wrapper compound', () => {
  const groups = readChapterGroups(`{
	chapter_groups: [
		{ id: "G1", order_index: 0 }
		{ id: "G2", order_index: 1, custom: 1b }
	]
}`)
  assert.deepEqual(groups.map((group) => group.id), ['G1', 'G2'])
  assert.equal(groups[1].extra.custom.t, 'byte')

  const printed = writeChapterGroups(groups)
  assert.match(printed, /chapter_groups:/)
  assert.deepEqual(readChapterGroups(printed), groups)
  assert.deepEqual(readChapterGroups('{}'), [])
})

test('quest ids are deterministic, distinct and FTB shaped', () => {
  const first = questIdFrom('chapter_1/quest/0')
  assert.equal(first, questIdFrom('chapter_1/quest/0'), 'same seed, same id')
  assert.notEqual(first, questIdFrom('chapter_1/quest/1'))
  assert.equal(first.length, 16)
  assert.match(first, /^[0-9A-F]{16}$/)
  assert.equal(isQuestId(first), true)
  assert.equal(isQuestId('0A1B2C3D4E5F6071'), true)
  assert.equal(isQuestId('not-hex'), false)
  assert.equal(isQuestId('00000000000000000'), false)
})

test('a malformed quest fails loudly instead of being dropped', () => {
  assert.throws(() => readChapter(`{ id: "C", order_index: 0, quests: [{ x: 0.0d }] }`), /缺少字符串字段/)
  assert.throws(() => readChapter(`{ id: "C", order_index: 0, quests: [{ id: "A", tasks: [{ type: "item" }] }] }`), /tasks\[0\]\.id/)
  assert.throws(
    () => readChapter(`{ id: "C", order_index: 0, quests: [{ id: "A", dependencies: ["A"] }, { id: "A" }] }`),
    /两个 quest id/
  )
})
