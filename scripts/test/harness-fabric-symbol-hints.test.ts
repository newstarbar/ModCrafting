import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { nestedClassMemberHints } from '../../src/main/fabric-symbol-hints.ts'
import type { FabricClassRecord } from '../../src/main/fabric-metadata.ts'

const index = JSON.parse(
  zlib.gunzipSync(fs.readFileSync('resources/fabric-symbol-index-1.21.4.json.gz')).toString('utf8')
) as { classes: FabricClassRecord[] }

const owner = index.classes.find((entry) => entry.name === 'net.minecraft.entity.mob.ShulkerEntity')!

test('member miss points at the nested class that declares it, with a compilable Mixin form', () => {
  const hints = nestedClassMemberHints(index.classes, owner, 'shouldRunEveryTick')
  assert.ok(hints.length > 0, 'expected a nested-class hint')
  assert.match(hints.join('\n'), /ShulkerEntity\$ShootBulletGoal/)
  assert.ok(
    hints.every((hint) => /@Mixin\(targets = "net\.minecraft\.entity\.mob\.ShulkerEntity\$\w+"\)/.test(hint)),
    hints.join('\n')
  )
})

test('a near-miss member name still resolves through edit distance', () => {
  const hints = nestedClassMemberHints(index.classes, owner, 'canStand')
  assert.match(hints.join('\n'), /canStart\(\)Z/)
})

test('hints stay bounded and unrelated names produce none', () => {
  assert.ok(nestedClassMemberHints(index.classes, owner, 'canStart').length <= 6)
  assert.deepEqual(nestedClassMemberHints(index.classes, owner, 'damage'), [])
  assert.deepEqual(nestedClassMemberHints(index.classes, owner, ''), [])
})
