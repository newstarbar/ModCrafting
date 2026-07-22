import test from 'node:test'
import assert from 'node:assert/strict'
import {
  expectedMixinSourcePaths,
  isValidMixinSourcePath
} from '../src/renderer/src/harness/mixin-utils.ts'

test('client mixin accepts src/client/java and falls back to src/main/java', () => {
  const fqn = 'com.example.frame_cover.mixin.TitleScreenBgInjector'
  const paths = expectedMixinSourcePaths(fqn, 'client')
  assert.deepEqual(paths, [
    'src/client/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java',
    'src/main/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java'
  ])
  assert.equal(
    isValidMixinSourcePath(
      'src/client/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java',
      fqn,
      'client'
    ),
    true
  )
  assert.equal(
    isValidMixinSourcePath(
      'src/main/java/com/example/frame_cover/mixin/TitleScreenBgInjector.java',
      fqn,
      'client'
    ),
    true
  )
})

test('common/server mixin only allows src/main/java', () => {
  const fqn = 'com.example.mod.mixin.ServerMixin'
  assert.deepEqual(expectedMixinSourcePaths(fqn, 'common'), [
    'src/main/java/com/example/mod/mixin/ServerMixin.java'
  ])
  assert.deepEqual(expectedMixinSourcePaths(fqn, 'server'), [
    'src/main/java/com/example/mod/mixin/ServerMixin.java'
  ])
  assert.equal(
    isValidMixinSourcePath('src/client/java/com/example/mod/mixin/ServerMixin.java', fqn, 'common'),
    false
  )
  assert.equal(
    isValidMixinSourcePath('src/main/java/com/example/mod/mixin/ServerMixin.java', fqn, 'common'),
    true
  )
})
