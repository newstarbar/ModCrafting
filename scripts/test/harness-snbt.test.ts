import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nbtByte,
  nbtCompound,
  nbtDouble,
  nbtInt,
  nbtList,
  nbtLong,
  nbtNumber,
  nbtString,
  nbtText,
  parseSnbt,
  parseSnbtCompound,
  printSnbt,
  snbtSignature,
  type NbtValue
} from '../../packages/modcrafting-core/src/snbt.ts'

/** parse -> print -> parse must be lossless; that is the whole contract. */
function roundTrip(source: string): NbtValue {
  const once = parseSnbt(source)
  const printed = printSnbt(once)
  const twice = parseSnbt(printed)
  assert.deepEqual(twice, once, `round-trip changed the value\n--- printed ---\n${printed}`)
  assert.equal(printSnbt(twice), printed, 'printing is not idempotent')
  return once
}

test('reads FTB style: one entry per line, no commas, tab indented', () => {
  const value = parseSnbtCompound(`{
	id: "44A5523F7A909209"
	x: 0.0d
	y: 1.5d
	shape: "hexagon"
	size: 1.5d
	dependencies: ["abc", "def"]
	tasks: [
		{
			id: "1A2B"
			type: "item"
			item: { count: 1, id: "minecraft:diamond" }
		}
	]
}`)

  assert.equal(nbtText(value.v.id), '44A5523F7A909209')
  assert.equal(nbtNumber(value.v.x), 0)
  assert.equal(value.v.x.t, 'double')
  assert.equal(value.v.size.t, 'double')
  assert.deepEqual(value.v.dependencies, nbtList([nbtString('abc'), nbtString('def')]))
  const tasks = value.v.tasks
  assert.equal(tasks.t, 'list')
  if (tasks.t !== 'list') return
  const first = tasks.v[0]
  assert.equal(first.t, 'compound')
  if (first.t !== 'compound') return
  assert.equal(first.v.item.t, 'compound')
})

test('reads JSON style with commas and no whitespace', () => {
  const value = roundTrip('{a:1,b:2.5d,c:"x",d:[1,2,3],e:{f:1b}}')
  assert.equal(value.t, 'compound')
  if (value.t !== 'compound') return
  assert.equal(value.v.a.t, 'int')
  assert.equal(value.v.b.t, 'double')
  assert.equal(value.v.c.t, 'string')
  assert.equal(value.v.e.t, 'compound')
})

test('numeric suffixes survive, because the tag is the data', () => {
  const value = roundTrip('{b:5b,s:5s,i:5,l:5L,f:5.0f,d:5.0d,neg:-3}')
  if (value.t !== 'compound') return
  assert.equal(value.v.b.t, 'byte')
  assert.equal(value.v.s.t, 'short')
  assert.equal(value.v.i.t, 'int')
  assert.equal(value.v.l.t, 'long')
  assert.equal(value.v.f.t, 'float')
  assert.equal(value.v.d.t, 'double')
  assert.equal(value.v.neg.t, 'int')

  const printed = printSnbt(value)
  assert.match(printed, /\bb: 5b/)
  assert.match(printed, /\bs: 5s/)
  assert.match(printed, /\bi: 5\n/)
  assert.match(printed, /\bl: 5L/)
  assert.match(printed, /\bf: 5\.0f/)
  assert.match(printed, /\bd: 5\.0d/)
})

test('booleans are bytes and print back as booleans, matching FTB output', () => {
  const value = roundTrip('{hide:false,visible:true,other:2b}')
  if (value.t !== 'compound') return
  assert.deepEqual(value.v.hide, nbtByte(0))
  assert.deepEqual(value.v.visible, nbtByte(1))
  const printed = printSnbt(value)
  assert.match(printed, /hide: false/)
  assert.match(printed, /visible: true/)
  assert.match(printed, /other: 2b/, 'only 0/1 becomes a keyword')
})

test('typed arrays keep their element type', () => {
  const value = roundTrip('{bytes:[B;1b,2b],ints:[I;1,2],longs:[L;1L,2L],empty:[B;]}')
  if (value.t !== 'compound') return
  assert.equal(value.v.bytes.t, 'byteArray')
  assert.equal(value.v.ints.t, 'intArray')
  assert.equal(value.v.longs.t, 'longArray')
  assert.deepEqual(value.v.empty, { t: 'byteArray', v: [] })
  const printed = printSnbt(value)
  assert.match(printed, /\[B;1b,2b\]/)
  assert.match(printed, /\[I;1,2\]/)
  assert.match(printed, /\[L;1L,2L\]/)
})

test('strings escape and unescape without loss', () => {
  const source = String.raw`{a:"quote\"back\\slash\nnewline\ttab\u4e2d\u6587",b:"plain 中文 🐔"}`
  const value = roundTrip(source)
  if (value.t !== 'compound') return
  assert.equal(nbtText(value.v.a), 'quote"back\\slash\nnewline\ttab中文')
  assert.equal(nbtText(value.v.b), 'plain 中文 🐔')

  // Non-ASCII must stay literal: escaping it would make every translated file unreadable.
  const printed = printSnbt(value)
  assert.match(printed, /中文/)
  assert.doesNotMatch(printed, /\\u4e2d/)
})

test('unquoted strings are read but never written back unquoted', () => {
  // A bare token may only contain [0-9A-Za-z_.+-]; `minecraft:diamond` needs quotes.
  const value = roundTrip('{type:item,note:not-a-number,id:"minecraft:diamond"}')
  if (value.t !== 'compound') return
  assert.equal(nbtText(value.v.type), 'item')
  assert.equal(nbtText(value.v.note), 'not-a-number')
  assert.equal(nbtText(value.v.id), 'minecraft:diamond')
  const printed = printSnbt(value)
  assert.match(printed, /type: "item"/)
  assert.match(printed, /id: "minecraft:diamond"/)

  // An unquoted namespace is a real error, and the message says how to fix it.
  assert.throws(() => parseSnbt('{id:minecraft:diamond}'), /必须给它加引号/)
})

test('line comments are skipped', () => {
  const value = roundTrip(`{
	// 这一行是注释
	a: 1 // 行尾注释
	b: 2
}`)
  if (value.t !== 'compound') return
  assert.equal(nbtNumber(value.v.a), 1)
  assert.equal(nbtNumber(value.v.b), 2)
})

test('empty containers stay compact and round-trip', () => {
  const value = roundTrip('{a:{},b:[],c:[B;]}')
  if (value.t !== 'compound') return
  assert.deepEqual(value.v.a, nbtCompound({}))
  assert.deepEqual(value.v.b, nbtList([]))
})

test('a realistic chapter document survives a full round-trip', () => {
  const source = `{
	Default_hide_dependency_lines: false
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
			dependencies: ["0000000000000001"]
			description: ["第一行", "第二行"]
			id: "0000000000000002"
			rewards: [{ id: "0000000000000003", item: { count: 1, id: "minecraft:bread" }, type: "item" }]
			shape: "hexagon"
			size: 1.5d
			tasks: [{ id: "0000000000000004", type: "checkmark" }]
			x: 0.0d
			y: 0.0d
		}
	]
	title: "第一章"
}`
  const value = roundTrip(source)
  if (value.t !== 'compound') return
  assert.equal(nbtText(value.v.title), '第一章')
  const quests = value.v.quests
  assert.equal(quests.t, 'list')
  if (quests.t !== 'list') return
  const quest = quests.v[0]
  assert.equal(quest.t, 'compound')
  if (quest.t !== 'compound') return
  assert.deepEqual(quest.v.description, nbtList([nbtString('第一行'), nbtString('第二行')]))
  assert.equal(nbtNumber(quest.v.size), 1.5)
})

test('signatures ignore key order and whitespace but not types', () => {
  const left = parseSnbt('{a:1,b:{c:2}}')
  const right = parseSnbt('{ "b": {"c": 2}, "a": 1 }')
  assert.equal(snbtSignature(left), snbtSignature(right))

  // 1 vs 1L is a different tag, so it must be a different signature.
  assert.notEqual(snbtSignature(parseSnbt('{a:1}')), snbtSignature(parseSnbt('{a:1L}')))
})

test('invalid input reports where it broke', () => {
  assert.throws(() => parseSnbt('{a:1'), /没有闭合/)
  assert.throws(() => parseSnbt('{a 1}'), /缺少「:」/)
  assert.throws(() => parseSnbt(''), /内容为空/)
  assert.throws(() => parseSnbt('{a:1} trailing'), /多余内容/)
  assert.throws(() => parseSnbt('"unterminated'), /没有闭合的引号/)
  assert.throws(() => parseSnbt('{a:3000000000}'), /超出 32 位整数范围/)
  assert.throws(() => parseSnbt('{a:99999999999999999999L}'), /安全整数范围/)

  try {
    parseSnbt('{\n\ta: 1\n\tb 2\n}')
    assert.fail('should have thrown')
  } catch (cause) {
    const error = cause as { code?: string; line?: number; column?: number; message: string }
    assert.equal(error.code, 'SNBT_INVALID')
    assert.equal(error.line, 3, 'the failing entry is on line 3')
    assert.match(error.message, /第 3 行/)
    assert.ok((error.column ?? 0) > 0)
  }
})

test('the document root is always expanded so diffs stay line-oriented', () => {
  const printed = printSnbt(parseSnbt('{a:1,b:2}'))
  // `{`, two entries, `}`, plus the empty tail after the final newline.
  assert.equal(printed.split('\n').length, 5)
  assert.match(printed, /^\{\n\ta: 1\n\tb: 2\n\}\n$/)
})

test('narrowing helpers do not cross type boundaries', () => {
  assert.equal(nbtNumber(nbtInt(3)), 3)
  assert.equal(nbtNumber(nbtLong(4)), 4)
  assert.equal(nbtText(nbtString('x')), 'x')
  assert.equal(nbtNumber(nbtString('3')), undefined)
  assert.equal(nbtText(nbtDouble(1.5)), undefined)
})

test('long values keep the L suffix across a rewrite', () => {
  const value = roundTrip('{progress:1234567890123L}')
  if (value.t !== 'compound') return
  assert.equal(value.v.progress.t, 'long')
  assert.equal(printSnbt(value).includes('1234567890123L'), true)
})
