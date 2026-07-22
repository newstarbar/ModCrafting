import test from 'node:test'
import assert from 'node:assert/strict'
import { clampBadgeLabel, encodePngRGBA } from '../../src/main/app-badge-utils.ts'

test('clampBadgeLabel: zero and negative → empty', () => {
  assert.equal(clampBadgeLabel(0), '')
  assert.equal(clampBadgeLabel(-1), '')
  assert.equal(clampBadgeLabel(Number.NaN), '')
})

test('clampBadgeLabel: 1–9 are digits', () => {
  assert.equal(clampBadgeLabel(1), '1')
  assert.equal(clampBadgeLabel(5), '5')
  assert.equal(clampBadgeLabel(9), '9')
})

test('clampBadgeLabel: above 9 → 9+', () => {
  assert.equal(clampBadgeLabel(10), '9+')
  assert.equal(clampBadgeLabel(99), '9+')
})

test('encodePngRGBA produces a valid PNG signature', () => {
  const rgba = Buffer.alloc(4 * 4 * 4, 255)
  const png = encodePngRGBA(4, 4, rgba)
  assert.ok(png.length > 8)
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10]
  )
})
