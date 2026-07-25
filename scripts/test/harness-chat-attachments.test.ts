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
import { buildCrossTurnDiagnosisRetain } from '../../src/renderer/src/harness/turn-intent.ts'
import { buildSessionMarkdown } from '../../src/renderer/src/utils/session-export-md.ts'
import {
  serializeDisplayMessages,
  deserializeToDisplay,
  toControllerMessagesWithAttachments
} from '../../src/renderer/src/utils/chat-persist.ts'
import { messagePlainText } from '../../src/renderer/src/utils/message-text.ts'

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
  assert.equal(isVisionCapableModel('glm-5-turbo', 'zhipu'), false)
  assert.equal(isVisionCapableModel('glm-5v-turbo', 'zhipu'), true)
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
  assert.equal(persisted[0].attachments?.[0].path, '/tmp/shot.png')

  // Round-trip through JSON (disk persistence path)
  const fromDisk = JSON.parse(JSON.stringify(persisted)) as typeof persisted
  assert.equal(fromDisk[0].attachments?.[0].path, '/tmp/shot.png')

  const display = deserializeToDisplay(fromDisk, () => 'new-id')
  assert.equal(display[0].attachments?.[0].path, '/tmp/shot.png')

  const restored = await toControllerMessagesWithAttachments(fromDisk, async () => ({
    ok: true as const,
    dataUrl: 'data:image/png;base64,zzz'
  }))
  assert.equal(restored[0].role, 'user')
  assert.ok(Array.isArray(restored[0].content))
})

test('buildSessionMarkdown tolerates multimodal controllerMessages', () => {
  const huge = `data:image/png;base64,${'A'.repeat(2000)}`
  const md = buildSessionMarkdown({
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: '看图',
        timestamp: 1,
        attachments: [{ kind: 'image', path: '/tmp/a.png', mimeType: 'image/png' }]
      },
      {
        id: 'a1',
        role: 'assistant',
        content: '好的',
        timestamp: 2,
        entries: [{ kind: 'text', content: '好的' }]
      }
    ],
    controllerMessages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: huge } }
        ]
      },
      { role: 'assistant', content: '好的' }
    ]
  })
  assert.match(md, /附件: image/)
  assert.match(md, /\[图片\]/)
  assert.doesNotMatch(md, /AAAAAA/)
})

test('buildCrossTurnDiagnosisRetain keeps multimodal current user content', () => {
  const parts = [
    { type: 'text' as const, text: '参考图修复布局' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,abc' } }
  ]
  const out = buildCrossTurnDiagnosisRetain({
    system: { role: 'system', content: 'sys', origin: 'harness' },
    messages: [
      { role: 'user', content: '之前反馈', origin: 'user' },
      { role: 'assistant', content: '我已经尝试过一种方案但没修好，继续排查。' },
      { role: 'user', content: parts, origin: 'user' }
    ],
    taskId: 'task_1'
  })
  const current = out.find((m) => m.role === 'user' && m.origin === 'user')
  assert.ok(current)
  assert.ok(Array.isArray(current!.content))
  assert.equal((current!.content as typeof parts)[1].type, 'image_url')
  assert.ok(out.some((m) => typeof m.content === 'string' && String(m.content).includes('跨轮诊断摘要')))
})

test('messagePlainText includes attachment paths for image-only user messages', () => {
  const text = messagePlainText({
    id: 'u',
    role: 'user',
    content: '',
    timestamp: 1,
    attachments: [{ kind: 'image', path: '/tmp/shot.png', mimeType: 'image/png' }]
  })
  assert.match(text, /\[图片\]/)
  assert.match(text, /shot\.png/)
})
