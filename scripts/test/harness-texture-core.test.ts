import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTexture, buildTextureBrief, processTexture, type RGBAImage } from '../../packages/modcrafting-core/src/texture-core.ts'

type Color = [number, number, number, number]
function image(width: number, height: number, paint: (x: number, y: number) => Color): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = paint(x, y), index = (y * width + x) * 4
    data[index] = color[0]; data[index + 1] = color[1]; data[index + 2] = color[2]; data[index + 3] = color[3]
  }
  return { width, height, data }
}
function distance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  return Math.abs(dx * (ay - py) - (ax - px) * dy) / Math.hypot(dx, dy)
}
function swordSource(): RGBAImage {
  return image(256, 256, (x, y) => {
    const blade = distance(x, y, 76, 184, 200, 60) < 20
    const highlight = distance(x, y, 88, 172, 198, 62) < 6
    const guard = distance(x, y, 54, 170, 96, 212) < 12
    const handle = distance(x, y, 52, 208, 26, 234) < 11
    const pommel = Math.hypot(x - 26, y - 234) < 11
    if (blade) return highlight ? [235, 245, 255, 255] : [170, 185, 200, 255]
    if (guard || pommel) return [205, 160, 45, 255]
    if (handle) return [105, 62, 28, 255]
    return [255, 0, 255, 255]
  })
}
const options = { size: 16 as const, background: 'auto' as const, backgroundTolerance: 40, trim: true, padding: 1, pixelize: true, outlineExpansion: true, paletteSize: 12, dither: 'none' as const, alphaThreshold: 128, outline: 1 as const, contrast: 0, saturation: 0, mirror: 'none' as const }

test('Texture pipeline produces a deterministic, binary-alpha 16x16 item grid', () => {
  const first = processTexture(swordSource(), options)
  const second = processTexture(swordSource(), options)
  assert.equal(first.image.width, 16); assert.equal(first.image.height, 16)
  assert.equal(first.ok, true, JSON.stringify(first.failures))
  assert.equal(first.metrics.partialAlphaPixels, 0)
  assert.ok(first.metrics.visiblePixels > 20)
  assert.equal(first.image.data[3], 0, 'top-left background must be removed')
  assert.ok(first.metrics.uniqueColors <= 32)
  assert.deepEqual([...first.image.data], [...second.image.data])
  assert.ok(first.palette.every(value => /^#[0-9a-f]{6}$/i.test(value)))
})

test('Target sizes 16, 32 and 64 produce square binary-alpha grids', () => {
  for (const size of [16, 32, 64] as const) {
    const result = processTexture(swordSource(), { ...options, size })
    assert.equal(result.image.width, size); assert.equal(result.image.height, size)
    assert.equal(result.metrics.partialAlphaPixels, 0)
    assert.ok(result.metrics.visiblePixels > 0)
    assert.ok(result.palette.length > 0)
  }
})

test('Background can be retained, and recolor preserves the alpha silhouette', () => {
  const kept = processTexture(swordSource(), { ...options, background: 'keep', trim: false, pixelize: false, outline: 0, paletteSize: 32 })
  assert.equal(kept.image.data[3], 255, 'keep mode must preserve the source background')
  const base = processTexture(swordSource(), options)
  const gold = processTexture(swordSource(), { ...options, recolor: { preset: 'gold' } })
  assert.deepEqual([...base.image.data].filter((_, index) => index % 4 === 3), [...gold.image.data].filter((_, index) => index % 4 === 3))
  assert.notDeepEqual(base.palette, gold.palette)
})

test('Mirror X produces a vertically symmetric texture', () => {
  const result = processTexture(swordSource(), { ...options, mirror: 'x' })
  for (let y = 0; y < result.image.height; y++) for (let x = 0; x < result.image.width; x++) {
    const left = (y * result.image.width + x) * 4, right = (y * result.image.width + (result.image.width - 1 - x)) * 4
    assert.deepEqual([...result.image.data.subarray(left, left + 4)], [...result.image.data.subarray(right, right + 4)])
  }
})

test('Quality checks catch empty, partial-alpha, wrong-size and fake-upscale inputs', () => {
  const blank = image(16, 16, () => [0, 0, 0, 0])
  assert.ok(analyzeTexture(blank, { size: 16 }).failures.some(value => value.code === 'TEXTURE_EMPTY'))
  const partial = image(16, 16, () => [120, 120, 120, 255])
  partial.data[3] = 128
  assert.ok(analyzeTexture(partial, { size: 16 }).failures.some(value => value.code === 'TEXTURE_PARTIAL_ALPHA'))
  assert.ok(analyzeTexture(image(16, 16, () => [120, 120, 120, 255]), { size: 32 }).failures.some(value => value.code === 'TEXTURE_SIZE_MISMATCH'))
  const small = image(16, 16, (x, y) => (x + y) % 3 === 0 ? [180, 30, 30, 255] : [40, 60, 90, 255])
  const enlarged = image(64, 64, (x, y) => small.data[((Math.floor(y / 4) * 16) + Math.floor(x / 4)) * 4 + 3] === 0 ? [0, 0, 0, 0] : [...small.data.subarray(((Math.floor(y / 4) * 16) + Math.floor(x / 4)) * 4, ((Math.floor(y / 4) * 16) + Math.floor(x / 4)) * 4 + 4)] as Color)
  assert.ok(analyzeTexture(enlarged, { size: 64 }).failures.some(value => value.code === 'TEXTURE_FAKE_DETAIL'))
  const full = analyzeTexture(image(16, 16, () => [180, 30, 30, 255]), { size: 16 })
  assert.ok(full.warnings.some(value => value.code === 'TEXTURE_TOO_FULL'))
  assert.ok(full.warnings.some(value => value.code === 'TEXTURE_BORDER'))
})

test('Texture brief locks the target ID, native grid and a clean generation checklist', () => {
  const brief = buildTextureBrief({ description: '紫水晶长剑', itemId: 'demo:amethyst_sword', modId: 'demo', size: 16, background: 'magenta' })
  assert.equal(brief.target.textureId, 'demo:item/amethyst_sword')
  assert.equal(brief.target.filePath, 'src/main/resources/assets/demo/textures/item/amethyst_sword.png')
  assert.equal(brief.standard, 'sword')
  assert.match(brief.prompt, /16x16/)
  assert.match(brief.negativePrompt, /watermark/)
  assert.equal(brief.background, 'magenta')
  assert.ok(brief.checklist.length >= 4)
  assert.ok(brief.instructions.length >= 3)
})
