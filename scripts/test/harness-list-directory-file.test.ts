import test from 'node:test'
import assert from 'node:assert/strict'
import {
  listDirectoryEmptyFileMessage,
  pathBasenameLooksLikeFile
} from '../../src/renderer/src/harness/list-directory-guard.ts'

test('pathBasenameLooksLikeFile detects java/json files', () => {
  assert.equal(
    pathBasenameLooksLikeFile('src/client/java/com/example/frame_cover/BackgroundManager.java'),
    true
  )
  assert.equal(pathBasenameLooksLikeFile('assets/frame-cover/lang/en_us.json'), true)
  assert.equal(pathBasenameLooksLikeFile('src/client/java/com/example/frame_cover'), false)
  assert.equal(pathBasenameLooksLikeFile('src/main/resources/'), false)
  assert.equal(pathBasenameLooksLikeFile(''), false)
  assert.equal(pathBasenameLooksLikeFile('.gitignore'), false)
})

test('listDirectoryEmptyFileMessage guides agent to read_file', () => {
  const msg = listDirectoryEmptyFileMessage(
    'src/client/java/com/example/frame_cover/BackgroundManager.java'
  )
  assert.match(msg, /是文件不是目录/)
  assert.match(msg, /read_file/)
  assert.match(msg, /list_directory/)
})
