import test from 'node:test'
import assert from 'node:assert/strict'
import {
  needsWindowsAsciiLaunchAlias,
  windowsAsciiLaunchAliasName
} from '../../src/main/mc-launch-path.ts'

test('Windows Minecraft launch uses an ASCII alias for non-ASCII project paths', () => {
  assert.equal(needsWindowsAsciiLaunchAlias('win32', 'C:\\Users\\辰沫星空\\project'), true)
  assert.equal(needsWindowsAsciiLaunchAlias('win32', 'C:\\workspace\\project'), false)
  assert.equal(needsWindowsAsciiLaunchAlias('linux', '/home/用户/project'), false)
})

test('Windows launch alias names are stable ASCII hashes', () => {
  const first = windowsAsciiLaunchAliasName('C:\\Users\\辰沫星空\\project')
  const second = windowsAsciiLaunchAliasName('C:\\Users\\辰沫星空\\project')
  assert.equal(first, second)
  assert.match(first, /^[a-f0-9]{16}$/)
})
