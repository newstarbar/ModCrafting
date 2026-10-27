import test from 'node:test'
import assert from 'node:assert/strict'
import {
  blankImage, drawLine, drawRect, extractColors, floodFill, fromBase64, mirrorX, putPixel, replaceColor, rgbaAt, toBase64
} from '../../packages/modcrafting-view/src/pixel-editor.ts'

test('Pixel editor line, fill, rectangle and mirror operate on exact pixels', () => {
  const line = blankImage(8, 8)
  drawLine(line, 0, 0, 7, 7, [255, 0, 0, 255])
  assert.deepEqual(rgbaAt(line, 0, 0), [255, 0, 0, 255])
  assert.deepEqual(rgbaAt(line, 7, 7), [255, 0, 0, 255])
  assert.deepEqual(rgbaAt(line, 4, 4), [255, 0, 0, 255])
  const image = blankImage(8, 8)
  floodFill(image, 0, 0, [0, 255, 0, 255])
  assert.deepEqual(rgbaAt(image, 0, 0), [0, 255, 0, 255])
  assert.deepEqual(rgbaAt(image, 7, 7), [0, 255, 0, 255])
  drawRect(image, 2, 2, 5, 5, [0, 0, 255, 255])
  assert.deepEqual(rgbaAt(image, 2, 2), [0, 0, 255, 255])
  assert.deepEqual(rgbaAt(image, 3, 3), [0, 255, 0, 255])
  mirrorX(image)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) assert.deepEqual(rgbaAt(image, x, y), rgbaAt(image, 7 - x, y))
})

test('Pixel editor base64 and palette helpers round-trip a texture', () => {
  const image = blankImage(4, 4)
  putPixel(image, 0, 0, [10, 20, 30, 255]); putPixel(image, 3, 3, [200, 100, 50, 255])
  const restored = fromBase64(toBase64(image), 4, 4)
  assert.deepEqual([...restored.data], [...image.data])
  const colors = extractColors(restored, 8)
  assert.ok(colors.includes('#0a141e')); assert.ok(colors.includes('#c86432'))
  replaceColor(restored, '#0a141e', '#ffffff')
  assert.deepEqual(rgbaAt(restored, 0, 0), [255, 255, 255, 255])
  assert.deepEqual(rgbaAt(restored, 3, 3), [200, 100, 50, 255])
})
