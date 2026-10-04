/**
 * Mixin precheck tests — targeted at the AW/Mixin semantic validations that
 * javac can't perform (annotation processing is disabled for speed).
 *
 * Targets: src/main/mixin-precheck.ts
 *   - @Mixin target class resolution
 *   - @Inject / @Redirect / @Overwrite / @Accessor / @Invoker target methods
 *   - @Shadow targets
 *   - Overloaded method ambiguity (soft warning)
 *   - mixins.json cross-side reference (client class in common config)
 *   - AW widening validation feeding back into the diagnostics
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runMixinPrecheck } from '../../src/main/mixin-precheck.ts'
import type { ProjectProfile } from '../../src/shared/harness-runtime.ts'

function makeProfile(overrides: Partial<ProjectProfile> = {}): ProjectProfile {
  return {
    version: 1,
    projectPath: '/proj',
    fingerprint: 'test',
    sourceSets: ['main', 'client'],
    splitEnvironment: false,
    entrypoints: { main: [], client: [], server: [] },
    mixinConfigs: [],
    accessWideners: [],
    dependencies: [],
    gradleTasks: [],
    javaFiles: [],
    resourceFiles: [],
    registeredSymbols: [],
    eventHandlers: [],
    symbolIndex: { available: false },
    warnings: [],
    ...overrides
  }
}

test('flags missing @Mixin target class as hard', () => {
  // We can't actually call lookupFabricSymbol without the index; the precheck
  // uses it but its absence marks the entry as missing — that's exactly what
  // we want to verify here.
  const profile = makeProfile()
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [{
      path: '/proj/src/main/java/com/example/MyMixin.java',
      content: `package com.example;\n@Mixin(net.minecraft.ghost.AbcEntity.class)\nabstract class MyMixin {}\n`
    }],
    mixinConfigs: []
  })
  const targetMissing = result.diagnostics.find((d) => d.id.startsWith('mixin_target_missing_'))
  assert.ok(targetMissing, `expected mixin_target_missing_ diagnostic, got: ${result.diagnostics.map((d) => d.id).join(', ')}`)
  assert.equal(targetMissing.severity, 'hard')
  assert.match(targetMissing.message, /net\.minecraft\.ghost\.AbcEntity/)
})

test('reports @Mixin with missing target literal as hard', () => {
  const profile = makeProfile()
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [{
      path: '/proj/src/main/java/com/example/NoTarget.java',
      content: 'package com.example;\n@Mixin\nabstract class NoTarget {}\n'
    }],
    mixinConfigs: []
  })
  const noTarget = result.diagnostics.find((d) => d.id.startsWith('mixin_no_target_'))
  assert.ok(noTarget, 'expected mixin_no_target_ diagnostic')
  assert.equal(noTarget.severity, 'hard')
})

test('flags client class referenced in a common mixin config when splitEnvironment', () => {
  const profile = makeProfile({ splitEnvironment: true })
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [],
    mixinConfigs: [{
      path: '/proj/src/main/resources/modid.mixins.json',
      content: JSON.stringify({ package: 'com.example.mixin', mixins: ['net.minecraft.client.gui.GhostMixin'] })
    }]
  })
  const split = result.diagnostics.find((d) => d.id === 'mixin_split_net.minecraft.client.gui.GhostMixin')
  assert.ok(split, 'expected mixin_split_ diagnostic')
  assert.equal(split.severity, 'hard')
})

test('softens splitEnvironment cross-side warning when splitEnvironment is disabled', () => {
  const profile = makeProfile({ splitEnvironment: false })
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [],
    mixinConfigs: [{
      path: '/proj/src/main/resources/modid.mixins.json',
      content: JSON.stringify({ package: 'com.example.mixin', mixins: ['net.minecraft.client.gui.GhostMixin'] })
    }]
  })
  const split = result.diagnostics.find((d) => d.message.includes('客户端命名空间') || d.message.includes('client-class'))
  assert.ok(split, `expected a cross-side diagnostic, got: ${result.diagnostics.map((d) => d.id).join(', ')}`)
  assert.equal(split.severity, 'soft')
})

test('no issues when mixin config lists only common classes', () => {
  const profile = makeProfile()
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [],
    mixinConfigs: [{
      path: '/proj/src/main/resources/modid.mixins.json',
      content: JSON.stringify({ package: 'com.example.mixin', mixins: ['com.example.mixin.MyMixin'] })
    }]
  })
  assert.equal(result.diagnostics.length, 0)
})

test('source-path projects route severity through tiered verdict', () => {
  // The harness invariant: every diagnostic from mixin precheck has a severity
  // field applied. Verify that even when the only diagnostics are soft, the
  // resulting array still carries severity tags.
  const profile = makeProfile({ splitEnvironment: true })
  const result = runMixinPrecheck({
    projectPath: '/proj',
    profile,
    projectProfile: profile,
    sources: [],
    mixinConfigs: [{
      path: '/proj/src/main/resources/modid.mixins.json',
      content: JSON.stringify({ package: 'com.example.mixin', mixins: ['net.minecraft.client.gui.GhostMixin'] })
    }]
  })
  for (const d of result.diagnostics) {
    assert.ok(d.severity === 'hard' || d.severity === 'soft', `diagnostic ${d.id} missing severity`)
  }
})