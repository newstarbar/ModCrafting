import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatClarificationOutput,
  looksLikeCodeFactQuestion,
  MAX_CLARIFY_OPTION_CHARS,
  MAX_CLARIFY_QUESTION_CHARS,
  validateClarificationArgs
} from '../src/renderer/src/harness/clarify-validation.ts'

test('validateClarificationArgs accepts short preference question', () => {
  const result = validateClarificationArgs('你希望主菜单背景默认开启模糊吗？', [
    '开启模糊',
    '关闭模糊'
  ])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.match(formatClarificationOutput(result.question, result.options), /CLARIFICATION_NEEDED/)
  }
})

test('validateClarificationArgs rejects empty options', () => {
  const result = validateClarificationArgs('你希望哪种布局？', ['仅一项'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /至少 2 个 options/)
})

test('validateClarificationArgs rejects long question', () => {
  const question = '字'.repeat(MAX_CLARIFY_QUESTION_CHARS + 1)
  const result = validateClarificationArgs(question, ['方案A', '方案B'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /question 过长/)
})

test('validateClarificationArgs rejects long option', () => {
  const opt = 'x'.repeat(MAX_CLARIFY_OPTION_CHARS + 1)
  const result = validateClarificationArgs('你希望用哪种交互？', [opt, '短选项'])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /option 过长/)
})

test('validateClarificationArgs rejects multiline option', () => {
  const result = validateClarificationArgs('你希望怎么处理冲突？', [
    '删空壳\n再注册实装',
    '合并到空壳'
  ])
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /禁止换行/)
})

test('looksLikeCodeFactQuestion detects API naming dumps', () => {
  assert.equal(
    looksLikeCodeFactQuestion(
      'ModConfigScreen 调用了 getFitMode()，但 ModConfig 只有 getBackgroundFit()，签名不一致怎么改？'
    ),
    true
  )
  assert.equal(looksLikeCodeFactQuestion('你希望截图快捷键默认绑定哪一个？'), false)
})

test('validateClarificationArgs rejects code-fact questions without preference framing', () => {
  const result = validateClarificationArgs(
    'mixins.json 已注册空类 TitleScreenBgInjector，实装在 TitleScreenBackgroundMixin 未注册，方法名也不一致。',
    ['删空壳并注册实装', '合并进空壳']
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /代码事实/)
})

test('validateClarificationArgs allows preference question even if technical', () => {
  const result = validateClarificationArgs('你希望保留模糊背景效果，还是关闭？', [
    '保留模糊',
    '关闭模糊'
  ])
  assert.equal(result.ok, true)
})
