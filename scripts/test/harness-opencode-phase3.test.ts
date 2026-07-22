import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFileEditGate, validateJavaBraceBalance, validateJsonSyntax } from '../../src/renderer/src/harness/edit-gate.ts'
import {
  formatGradleErrorsForPrompt,
  gradleErrorSignature,
  parseGradleErrors
} from '../../src/renderer/src/harness/gradle-error-parser.ts'
import { compilePlanFromText, parseJsonPlanSteps, parseStructuredSteps } from '../../src/renderer/src/harness/plan-compiler.ts'
import { formatPlanValidationIssues, validateCompiledSteps } from '../../src/renderer/src/harness/plan-validator.ts'

test('edit-gate rejects unbalanced Java braces', () => {
  const bad = 'public class Foo {\n  void bar() {\n'
  assert.equal(validateJavaBraceBalance(bad).ok, false)
  assert.equal(validateFileEditGate('src/main/java/Foo.java', bad).ok, false)
})

test('edit-gate accepts balanced Java and valid JSON', () => {
  const java = 'public class Foo {\n  void bar() {}\n}\n'
  assert.equal(validateJavaBraceBalance(java).ok, true)
  assert.equal(validateFileEditGate('src/Foo.java', java).ok, true)
  assert.equal(validateJsonSyntax('{"a":1}').ok, true)
  assert.equal(validateFileEditGate('data/x.json', '{').ok, false)
})

test('gradle-error-parser extracts file:line:message and stable signature', () => {
  const log = [
    'src/main/java/com/example/Mod.java:12: error: cannot find symbol',
    '  symbol: class Missing',
    'BUILD FAILED'
  ].join('\n')
  const entries = parseGradleErrors(log)
  assert.ok(entries.length >= 1)
  assert.equal(entries[0].file, 'src/main/java/com/example/Mod.java')
  assert.equal(entries[0].line, 12)
  assert.match(entries[0].message, /cannot find symbol/)
  const sig = gradleErrorSignature(log)
  assert.ok(sig.includes('Mod.java:12'))
  assert.match(formatGradleErrorsForPrompt(log), /结构化编译错误/)
})

test('plan-validator flags write steps without path', () => {
  const issues = validateCompiledSteps([
    { id: '1', description: '随便改点东西', kind: 'write' },
    {
      id: '2',
      description: '写 src/main/java/com/example/A.java',
      kind: 'write',
      targetPath: 'src/main/java/com/example/A.java',
      evidence: '文件含 class A'
    }
  ])
  assert.ok(issues.some((i) => i.stepId === '1' && i.field === 'targetPath'))
  assert.ok(!issues.some((i) => i.stepId === '2' && i.field === 'targetPath'))
  assert.ok(formatPlanValidationIssues(issues).includes('步骤 #1'))
})

test('parseJsonPlanSteps accepts fenced JSON plan', () => {
  const text = `说明如下：
\`\`\`json
[
  {"kind":"write","description":"添加物品类","targetPath":"src/main/java/com/example/Item.java"},
  {"kind":"recipe","title":"泥土合成钻石","path":"data/example/recipe/dirt_diamond.json"}
]
\`\`\`
`
  const steps = parseJsonPlanSteps(text)
  assert.ok(steps)
  assert.equal(steps!.length, 2)
  assert.equal(steps![0].kind, 'write')
  assert.equal(steps![0].targetPath, 'src/main/java/com/example/Item.java')
  assert.equal(steps![1].kind, 'recipe')
})

test('compilePlanFromText prefers JSON steps and appends host terminals', () => {
  const text = JSON.stringify({
    steps: [
      { kind: 'write', description: '创建 Handler', targetPath: 'src/main/java/com/example/Handler.java' }
    ]
  })
  const compiled = compilePlanFromText(text)
  assert.ok(compiled.some((s) => s.targetPath === 'src/main/java/com/example/Handler.java'))
  assert.ok(compiled.some((s) => /构建|build/i.test(s.description)))
})

test('parseStructuredSteps falls back to tagged lines', () => {
  const steps = parseStructuredSteps('1. [write] src/main/java/com/example/A.java — 实现逻辑')
  assert.equal(steps.length, 1)
  assert.equal(steps[0].kind, 'write')
  assert.ok(steps[0].targetPath?.includes('src/main/java'))
})
