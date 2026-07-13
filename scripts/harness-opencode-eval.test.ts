import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { scaffoldEvalProject, wipeDir } from './eval/scaffold.mjs'
import { applySetups } from './eval/setups.mjs'
import { runVerifiers, snapshotTree } from './eval/verify.mjs'

test('scaffold creates fabric.mod.json and main class', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-scaffold-'))
  try {
    const meta = scaffoldEvalProject(dir, { projectName: 'evalmod', groupId: 'com.example' })
    assert.equal(meta.modId, 'evalmod')
    assert.ok(fs.existsSync(path.join(dir, 'src/main/resources/fabric.mod.json')))
    assert.ok(fs.existsSync(path.join(dir, 'src/main/java/com/example/eval_mod/EvalMod.java')))
    assert.ok(fs.existsSync(path.join(dir, 'gradlew.bat')))
  } finally {
    wipeDir(dir)
  }
})

test('T04 injectCompileError makes fileNotContains fail until fixed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-t04-'))
  try {
    scaffoldEvalProject(dir, { projectName: 'evalmod', groupId: 'com.example' })
    applySetups(dir, ['injectCompileError'])
    const broken = path.join(dir, 'src/main/java/com/example/eval_mod/BrokenHelper.java')
    assert.ok(fs.existsSync(broken))
    assert.match(fs.readFileSync(broken, 'utf-8'), /MissingClassThatDoesNotExist/)

    const before = await runVerifiers(
      dir,
      [{ type: 'fileNotContains', path: 'src/main/java/com/example/eval_mod/BrokenHelper.java', contains: 'MissingClassThatDoesNotExist' }],
      { runtimeRoot: path.join(dir, '..'), skipBuild: true }
    )
    assert.equal(before.ok, false)

    fs.writeFileSync(
      broken,
      'package com.example.eval_mod;\npublic class BrokenHelper { public static void boom() {} }\n',
      'utf-8'
    )
    const after = await runVerifiers(
      dir,
      [{ type: 'fileNotContains', path: 'src/main/java/com/example/eval_mod/BrokenHelper.java', contains: 'MissingClassThatDoesNotExist' }],
      { runtimeRoot: path.join(dir, '..'), skipBuild: true }
    )
    assert.equal(after.ok, true)
  } finally {
    wipeDir(dir)
  }
})

test('noFileChanges detects mutation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-snap-'))
  try {
    scaffoldEvalProject(dir, { projectName: 'evalmod', groupId: 'com.example' })
    const snap = snapshotTree(dir)
    const ok1 = await runVerifiers(dir, [{ type: 'noFileChanges' }], {
      runtimeRoot: dir,
      skipBuild: true,
      snapshotBefore: snap,
      agentOutput: ''
    })
    assert.equal(ok1.ok, true)

    fs.writeFileSync(path.join(dir, 'touched.txt'), 'x', 'utf-8')
    const ok2 = await runVerifiers(dir, [{ type: 'noFileChanges' }], {
      runtimeRoot: dir,
      skipBuild: true,
      snapshotBefore: snap,
      agentOutput: ''
    })
    assert.equal(ok2.ok, false)
  } finally {
    wipeDir(dir)
  }
})

test('agentOutputContainsAny is case-insensitive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-out-'))
  try {
    scaffoldEvalProject(dir, { projectName: 'evalmod', groupId: 'com.example' })
    const r = await runVerifiers(
      dir,
      [{ type: 'agentOutputContainsAny', needles: ['com.example.eval_mod.EvalMod'] }],
      {
        runtimeRoot: dir,
        skipBuild: true,
        agentOutput: '入口是 COM.EXAMPLE.EVAL_MOD.EVALMOD'
      }
    )
    assert.equal(r.ok, true)
  } finally {
    wipeDir(dir)
  }
})
