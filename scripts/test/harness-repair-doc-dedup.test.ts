import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCompileApiHints,
  hasSimilarDocSearch,
  isSimilarDocSearchFingerprint,
  normalizeDocSearchFingerprint
} from '../../src/renderer/src/harness/doc-search-dedup.ts'
import { looksLikeApiSignatureQuery } from '../../src/renderer/src/harness/fabric-knowledge.ts'
import {
  extractMethodLikeTokens,
  prioritizeYarnMemberLines
} from '../../src/main/yarn-descriptor.ts'
import { buildRepairInstruction } from '../../src/renderer/src/harness/workflow-engine.ts'

test('normalizeDocSearchFingerprint strips noise and versions', () => {
  const a = normalizeDocSearchFingerprint('DrawContext drawTexture 1.21.4')
  const b = normalizeDocSearchFingerprint('DrawContext drawTexture Identifier 1.21.4 parameters')
  assert.match(a, /drawcontext/)
  assert.match(a, /drawtexture/)
  assert.equal(a.includes('1.21'), false)
  assert.ok(isSimilarDocSearchFingerprint(a, b), 'near-duplicate keywords should match')
})

test('hasSimilarDocSearch blocks second near-duplicate', () => {
  const seen = new Set([normalizeDocSearchFingerprint('DrawContext drawTexture 1.21.4')])
  assert.equal(
    hasSimilarDocSearch(seen, normalizeDocSearchFingerprint('DrawContext drawTexture Identifier parameters')),
    true
  )
  assert.equal(
    hasSimilarDocSearch(seen, normalizeDocSearchFingerprint('Registry register Item')),
    false
  )
})

test('extractCompileApiHints finds drawTexture from javac Chinese error', () => {
  const log = [
    'ConfigScreen.java:116: 错误: 对于drawTexture(Identifier,int,int,int,int,int,int,int,int), 找不到合适的方法',
    '            ctx.drawTexture(bgTex, 0, 0, 0, 0, pvW, pvH, bgTexW, bgTexH);'
  ].join('\n')
  const hints = extractCompileApiHints(log)
  assert.ok(hints.includes('drawTexture'), `got ${hints.join(',')}`)
})

test('buildRepairInstruction mentions API method and bans re-query', () => {
  const log = '错误: 对于drawTexture(Identifier,int), 找不到合适的方法\nBUILD FAILED'
  const text = buildRepairInstruction(log, 'build')
  assert.match(text, /drawTexture/)
  assert.match(text, /只查一次/)
  assert.match(text, /禁止用略改关键词反复查/)
})

test('prioritizeYarnMemberLines surfaces keyword methods first', () => {
  const lines = [
    '  方法: fill(int, x1: int) -> void',
    '  方法: drawItem(ItemStack, stack: int) -> void',
    '  方法: drawTexture(java.util.function.Function, Identifier, int, int) -> void',
    '  方法: drawTexture(java.util.function.Function, Identifier, int, int, float) -> void',
    '  字段: client : MinecraftClient'
  ]
  const ranked = prioritizeYarnMemberLines(lines, 'DrawContext drawTexture 1.21.4', 3)
  assert.equal(ranked.length, 3)
  assert.match(ranked[0], /drawTexture/)
  assert.match(ranked[1], /drawTexture/)
  assert.deepEqual(extractMethodLikeTokens('DrawContext drawTexture 1.21.4'), ['drawtexture'])
})

test('looksLikeApiSignatureQuery detects class+method', () => {
  assert.equal(looksLikeApiSignatureQuery('DrawContext drawTexture'), true)
  assert.equal(looksLikeApiSignatureQuery('rendering basics'), false)
})
