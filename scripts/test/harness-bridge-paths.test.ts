import test from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedBridgeApiPath } from '../../src/main/mc-bridge-client.ts'

test('bridge IPC permits authenticated V1 and V2 Observer APIs only', () => {
  assert.equal(isAllowedBridgeApiPath('/v1/health'), true)
  assert.equal(isAllowedBridgeApiPath('/v2/capabilities'), true)
  assert.equal(isAllowedBridgeApiPath('/v2/snapshot?fresh=1'), true)
  assert.equal(isAllowedBridgeApiPath('/health'), false)
  assert.equal(isAllowedBridgeApiPath('/v3/command'), false)
  assert.equal(isAllowedBridgeApiPath('http://127.0.0.1/'), false)
})
