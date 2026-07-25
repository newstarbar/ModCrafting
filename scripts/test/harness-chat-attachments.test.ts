import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFilePathsToText,
  hasImageAttachment,
  isImagePath,
  mimeFromPath,
  payloadToAttachment
} from '../../src/renderer/src/context/context-ingress.ts'
import { buildUserContent } from '../../src/renderer/src/context/user-content.ts'
import { isVisionCapableModel } from '../../src/renderer/src/harness/chat-message.ts'
import {
  serializeDisplayMessages,
  deserializeToDisplay,
  toControllerMessagesWithAttachments
} from '../../src/renderer/src/utils/chat-persist.ts'

test('mimeFromPath and isImagePath', () => {
  assert.equal(mimeFromPath('a.PNG'), 'image/png')
  assert.equal(isImagePath('shot.jpg'), true)
  assert.equal(isImagePath('notes.txt'), false)
})

test('appendFilePathsToText adds file paths for agent', () => {
  const out = appendFilePathsToText('看看这个', [
    { kind: 'file', path: 'D:/mod/src/Main.java', name: 'Main.java' },
    { kind: 'image', path: 'D:/shot.png', mimeType: 'image/png' }
  ])
  assert.match(out, /附件路径/)
  assert.match(out, /Main\.java/)
  assert.doesNotMatch(out, /shot\.png/)
})

test('payloadToAttachment maps image and file', () => {
  const img = payloadToAttachment(
    { kind: 'image', path: '/a.png', mimeType: 'image/png', name: 'a.png' },
    'id1'
  )
  assert.equal(img?.kind, 'image')
  const file = payloadToAttachment({ kind: 'file', path: '/b.txt', name: 'b.txt' }, 'id2')
  assert.equal(file?.kind, 'file')
  assert.equal(payloadToAttachment({ kind: 'text', text: 'hi' }, 'id3'), null)
})

test('hasImageAttachment gates vision send', () => {
  assert.equal(hasImageAttachment([{ kind: 'file' }]), false)
  assert.equal(hasImageAttachment([{ kind: 'image' }]), true)
  // Catalog models use explicit vision flags
  assert.equal(isVisionCapableModel('qwen3.7-plus', 'dashscope'), true)
  assert.equal(isVisionCapableModel('qwen3.7-max', 'dashscope'), true)
  assert.equal(isVisionCapableModel('kimi-k2.5', 'moonshot'), true)
  assert.equal(isVisionCapableModel('glm-5.2', 'zhipu'), false)
  assert.equal(isVisionCapableModel('deepseek-chat', 'deepseek'), false)
  assert.equal(isVisionCapableModel('MiniMax-M3', 'minimax'), true)
  assert.equal(isVisionCapableModel('MiniMax-M2.7', 'minimax'), false)
  // Custom / unknown still use heuristics
  assert.equal(isVisionCapableModel('gpt-4o-mini'), true)
})

test('buildUserContent creates multimodal parts for images', () => {
  const urls = new Map([['/a.png', 'data:image/png;base64,aaa']])
  const content = buildUserContent('看图', [{ kind: 'image', path: '/a.png', mimeType: 'image/png' }], urls)
  assert.ok(Array.isArray(content))
  if (!Array.isArray(content)) throw new Error('expected parts')
  assert.equal(content[0].type, 'text')
  assert.equal(content[1].type, 'image_url')
  if (content[1].type === 'image_url') {
    assert.equal(content[1].image_url.url, 'data:image/png;base64,aaa')
  }
})

test('buildUserContent stays string without images', () => {
  const content = buildUserContent('hello', [{ kind: 'file', path: '/x.txt', name: 'x.txt' }], new Map())
  assert.equal(typeof content, 'string')
  assert.match(String(content), /附件路径/)
})

test('serialize/deserialize keeps attachments; restore rebuilds multimodal', async () => {
  const persisted = serializeDisplayMessages(
    [
      {
        id: 'u1',
        role: 'user',
        content: '看这张图',
        timestamp: 1,
        attachments: [{ kind: 'image', path: '/tmp/shot.png', mimeType: 'image/png', name: 'shot.png' }]
      }
    ],
    null
  )
  assert.equal(persisted[0].attachments?.[0].kind, 'image')

  const display = deserializeToDisplay(persisted, () => 'new-id')
  assert.equal(display[0].attachments?.[0].path, '/tmp/shot.png')

  const restored = await toControllerMessagesWithAttachments(persisted, async () => ({
    ok: true as const,
    dataUrl: 'data:image/png;base64,zzz'
  }))
  assert.equal(restored[0].role, 'user')
  assert.ok(Array.isArray(restored[0].content))
})
