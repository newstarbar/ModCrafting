import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isModificationAllowedLicense, isRedistributableLicense } from '../../packages/modcrafting-core/src/pack/license-policy.ts'
import {
  appendTransformAudit,
  evaluateTransform,
  readTransformAudit,
  TRANSFORM_AUDIT_FILE
} from '../../packages/modcrafting-core/src/pack/transform/trust.ts'

test('modification permission is stricter than redistribution for no-derivatives licences', () => {
  assert.equal(isRedistributableLicense('CC-BY-ND-4.0'), true, 'an unmodified file may still be redistributed')
  assert.equal(isModificationAllowedLicense('CC-BY-ND-4.0'), false)
  assert.equal(isModificationAllowedLicense('MIT'), true)
  assert.equal(isModificationAllowedLicense('GPL-3.0-only'), true)
  assert.equal(isModificationAllowedLicense('All-Rights-Reserved'), false)
  assert.equal(isModificationAllowedLicense(''), false)
})

test('L1/L2 are local by default; non-redistributable output is marked non-exportable', () => {
  const allowed = evaluateTransform({ level: 'L1', license: { id: 'MIT', redistributable: true } })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.exportable, true)

  const localOnly = evaluateTransform({ level: 'L2', license: { id: 'All-Rights-Reserved', redistributable: false } })
  assert.equal(localOnly.allowed, true)
  assert.equal(localOnly.exportable, false)
  assert.ok(localOnly.reasons.some((reason) => /非再分发|导出/.test(reason)))
})

test('L3/L4 hard-refuse without licence permission or per-use consent', () => {
  const noLicense = evaluateTransform({ level: 'L3', license: { id: 'All-Rights-Reserved', redistributable: false }, consent: true })
  assert.equal(noLicense.allowed, false)
  assert.equal(noLicense.code, 'TRANSFORM_LICENSE_BLOCKED')
  assert.match(noLicense.message, /许可证/)

  const noConsent = evaluateTransform({ level: 'L4', license: { id: 'MIT', redistributable: true }, consent: false })
  assert.equal(noConsent.allowed, false)
  assert.equal(noConsent.code, 'TRANSFORM_CONSENT_REQUIRED')

  const ok = evaluateTransform({ level: 'L3', license: { id: 'MIT', redistributable: true }, consent: true })
  assert.equal(ok.allowed, true)
  assert.equal(ok.exportable, true)

  const analysis = evaluateTransform({ level: 'L4', license: { id: 'MIT', redistributable: true }, consent: true })
  assert.equal(analysis.allowed, true)
  assert.equal(analysis.exportable, false, 'decompiler-adjacent analysis never becomes a shippable artifact')
})

test('audit records append as JSONL and read back in order', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'modcrafting-trust-'))
  try {
    appendTransformAudit(root, {
      schemaVersion: 1,
      at: '2026-11-23T00:00:00.000Z',
      action: 'refuse',
      level: 'L3',
      entryId: 'example',
      decision: { allowed: false, exportable: false, code: 'TRANSFORM_LICENSE_BLOCKED', message: 'no permission' }
    })
    appendTransformAudit(root, {
      schemaVersion: 1,
      at: '2026-11-23T00:00:01.000Z',
      action: 'apply',
      level: 'L1',
      entryId: 'example',
      transformId: 'example-l1-abcdef123456',
      decision: { allowed: true, exportable: false, message: 'local only' }
    })
    const records = readTransformAudit(root)
    assert.equal(records.length, 2)
    assert.deepEqual(records.map((record) => record.action), ['refuse', 'apply'])
    assert.equal(TRANSFORM_AUDIT_FILE, '.modcrafting/transform-audit.jsonl')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
