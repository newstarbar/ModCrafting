/**
 * Access Widener parser tests.
 *
 * Targets: src/main/access-widener.ts
 *   - parseAccessWidener (handles v1 named, accessible/mutable/extendable, classes/fields/methods)
 *   - isAwWidened (matches class-level widening, member widening, optional descriptor)
 *   - validateAccessWidenerEntries (flags class-not-found and member-not-found)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAccessWidener, isAwWidened, validateAccessWidenerEntries, type AwEntry } from '../../src/main/access-widener.ts'

const HEADER = 'accessWidener v1 named\n'

test('parses a minimal class-level accessible entry', () => {
  const out = parseAccessWidener(`${HEADER}accessible\tclass\tcom/example/GameRenderer\n`)
  assert.equal(out.length, 1)
  assert.equal(out[0].op, 'accessible')
  assert.equal(out[0].target, 'class')
  assert.equal(out[0].className, 'com.example.GameRenderer')
  assert.equal(out[0].memberName, undefined)
  assert.equal(out[0].descriptor, undefined)
  assert.equal(out[0].line, 2)
})

test('parses accessible method with descriptor', () => {
  const text = `${HEADER}accessible\tmethod\tcom/example/ItemStack\thandleBoxItemAmount\t(I)I\n`
  const out = parseAccessWidener(text)
  assert.equal(out.length, 1)
  assert.equal(out[0].target, 'method')
  assert.equal(out[0].memberName, 'handleBoxItemAmount')
  assert.equal(out[0].descriptor, '(I)I')
})

test('parses mutable field entry', () => {
  const text = `${HEADER}mutable\tfield\tnet/minecraft/world/World\tfield_12345\tLjava/util/Map;\n`
  const out = parseAccessWidener(text)
  assert.equal(out.length, 1)
  assert.equal(out[0].op, 'mutable')
  assert.equal(out[0].target, 'field')
  assert.equal(out[0].className, 'net.minecraft.world.World')
  assert.equal(out[0].memberName, 'field_12345')
})

test('parses extendable class', () => {
  const out = parseAccessWidener(`${HEADER}extendable\tclass\tcom/example/MyExtensible\n`)
  assert.equal(out.length, 1)
  assert.equal(out[0].op, 'extendable')
  assert.equal(out[0].target, 'class')
})

test('skips comments and blank lines', () => {
  const text = `${HEADER}# this is a comment\n\n\t\naccessible\tclass\tcom/example/A\n# another\naccessible\tfield\tcom/example/A\tx\tI\n`
  const out = parseAccessWidener(text)
  assert.equal(out.length, 2)
})

test('isAwWidened: class-level entry widens everything', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'class', className: 'com.example.Cls', source: 'x', line: 1
  }]
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'anyMethod'), true)
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'anyField'), true)
  assert.equal(isAwWidened(entries, 'com.example.Other'), false)
})

test('isAwWidened: method entry requires descriptor when AW has one', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'method', className: 'com.example.Cls',
    memberName: 'doWork', descriptor: '()V', source: 'x', line: 1
  }]
  // Without descriptor -> still widens (caller decides)
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'doWork'), true)
  // With matching descriptor -> widens
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'doWork', '()V'), true)
  // With wrong descriptor -> does NOT widen
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'doWork', '()Z'), false)
})

test('isAwWidened: method entry without descriptor always matches', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'method', className: 'com.example.Cls',
    memberName: 'doWork', source: 'x', line: 1
  }]
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'doWork', '()V'), true)
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'doWork'), true)
})

test('isAwWidened: field entry matches by name regardless of descriptor', () => {
  const entries: AwEntry[] = [{
    op: 'mutable', target: 'field', className: 'com.example.Cls',
    memberName: 'secret', source: 'x', line: 1
  }]
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'secret'), true)
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'other'), false)
})

test('validateAccessWidenerEntries flags missing classes', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'class', className: 'com.example.Ghost',
    source: 'aw', line: 3
  }]
  const issues = validateAccessWidenerEntries(entries, () => null)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'class_not_found')
  assert.match(issues[0].hint, /com\.example\.Ghost/)
})

test('validateAccessWidenerEntries flags missing methods', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'method', className: 'com.example.Cls',
    memberName: 'ghostMethod', descriptor: '()V', source: 'aw', line: 4
  }]
  const lookup = () => ({ name: 'com.example.Cls', methods: [{ name: 'realMethod', descriptor: '()V' }], fields: [] })
  const issues = validateAccessWidenerEntries(entries, lookup)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'member_not_found')
  assert.match(issues[0].hint, /ghostMethod/)
})

test('validateAccessWidenerEntries flags missing fields', () => {
  const entries: AwEntry[] = [{
    op: 'mutable', target: 'field', className: 'com.example.Cls',
    memberName: 'ghostField', source: 'aw', line: 4
  }]
  const lookup = () => ({ name: 'com.example.Cls', methods: [], fields: [{ name: 'realField' }] })
  const issues = validateAccessWidenerEntries(entries, lookup)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'member_not_found')
  assert.match(issues[0].hint, /ghostField/)
})

test('validateAccessWidenerEntries: happy path with no issues', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'method', className: 'com.example.Cls',
    memberName: 'realMethod', descriptor: '()V', source: 'aw', line: 4
  }]
  const lookup = () => ({ name: 'com.example.Cls', methods: [{ name: 'realMethod', descriptor: '()V' }], fields: [] })
  const issues = validateAccessWidenerEntries(entries, lookup)
  assert.equal(issues.length, 0)
})

test('validateAccessWidenerEntries: class-level widening does not need member lookups', () => {
  const entries: AwEntry[] = [{
    op: 'accessible', target: 'class', className: 'com.example.Cls',
    source: 'aw', line: 2
  }]
  const issues = validateAccessWidenerEntries(entries, () => ({ name: 'com.example.Cls', methods: [], fields: [] }))
  assert.equal(issues.length, 0)
})

test('mixed entry types parsed independently', () => {
  const text = [
    HEADER,
    'accessible\tclass\tcom/example/A\n',
    'accessible\tfield\tcom/example/A\tx\tI\n',
    'mutable\tfield\tcom/example/A\ty\tI\n',
    'extendable\tclass\tcom/example/B\n',
    'accessible\tmethod\tcom/example/A\tfoo\t()V\n'
  ].join('')
  const out = parseAccessWidener(text)
  assert.equal(out.length, 5)
  assert.equal(out.filter((e) => e.op === 'accessible').length, 3)
  assert.equal(out.filter((e) => e.op === 'mutable').length, 1)
  assert.equal(out.filter((e) => e.op === 'extendable').length, 1)
})

test('class-level widening suppresses per-member widening when both present', () => {
  const entries: AwEntry[] = [
    { op: 'accessible', target: 'class', className: 'com.example.Cls', source: 'aw', line: 1 },
    { op: 'accessible', target: 'method', className: 'com.example.Cls', memberName: 'foo', descriptor: '()V', source: 'aw', line: 2 }
  ]
  // The class-level entry alone matches everything.
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'foo', '()V'), true)
  assert.equal(isAwWidened(entries, 'com.example.Cls', 'bar'), true)
})