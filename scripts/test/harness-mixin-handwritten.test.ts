import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRegisterableMixin,
  hasMixinAnnotation,
  inferSideFromSourcePath,
  isAcceptableHandwrittenMixinPath,
  isMixinRegisteredInConfig,
  parseJavaIdentity,
  relativeMixinClassName,
  sideToConfigKey,
  validateHandwrittenMixin
} from '../../src/renderer/src/harness/mixin-registration.ts'
import { recordsStepEvidence } from '../../src/renderer/src/harness/workflow-engine.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'
import type { ToolResult } from '../../src/renderer/src/harness/tools.ts'

const HANDWRITTEN_MOUSE = `package com.example.frame_cover.mixin;

import net.minecraft.client.Mouse;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Mouse.class)
public abstract class MouseMixin {
    @Inject(method = "onMouseButton(JIII)V", at = @At("HEAD"), cancellable = true)
    private void modcrafting$inject(long window, int button, int action, int mods, CallbackInfo ci) {
        if (frozen) ci.cancel();
    }
}
`

const PLAIN_CLASS = `package com.example.frame_cover;

public class Helper {
    public static void noop() {}
}
`

test('hasMixinAnnotation detects @Mixin', () => {
  assert.equal(hasMixinAnnotation(HANDWRITTEN_MOUSE), true)
  assert.equal(hasMixinAnnotation(PLAIN_CLASS), false)
})

test('parseJavaIdentity extracts package and class', () => {
  const id = parseJavaIdentity(HANDWRITTEN_MOUSE)
  assert.ok(id)
  assert.equal(id!.packageName, 'com.example.frame_cover.mixin')
  assert.equal(id!.className, 'MouseMixin')
  assert.equal(id!.fqn, 'com.example.frame_cover.mixin.MouseMixin')
})

test('inferSideFromSourcePath maps client/main/server', () => {
  assert.equal(
    inferSideFromSourcePath('src/client/java/com/example/frame_cover/mixin/MouseMixin.java'),
    'client'
  )
  assert.equal(
    inferSideFromSourcePath('src/main/java/com/example/mixin/Foo.java'),
    'common'
  )
  assert.equal(
    inferSideFromSourcePath('src/server/java/com/example/mixin/Bar.java'),
    'server'
  )
})

test('assertRegisterableMixin allows handwritten with @Mixin, rejects plain class', () => {
  assert.equal(assertRegisterableMixin(HANDWRITTEN_MOUSE, false), null)
  assert.equal(assertRegisterableMixin(HANDWRITTEN_MOUSE, true), null)
  const err = assertRegisterableMixin(PLAIN_CLASS, false)
  assert.ok(err)
  assert.match(err!, /缺少 @Mixin/)
})

test('isMixinRegisteredInConfig finds entry in preferred or any side array', () => {
  const config = {
    package: 'com.example.frame_cover.mixin',
    client: ['TitleScreenBgInjector', 'MouseMixin'],
    mixins: []
  }
  assert.deepEqual(
    isMixinRegisteredInConfig(config, 'MouseMixin', 'client'),
    { registered: true, key: 'client' }
  )
  assert.equal(
    isMixinRegisteredInConfig(config, 'MissingMixin', 'client').registered,
    false
  )
  // Preferred mixins missing, but present in client — still registered via fallback scan
  assert.equal(
    isMixinRegisteredInConfig(config, 'MouseMixin', 'mixins').registered,
    true
  )
})

test('validateHandwrittenMixin passes for registered client MouseMixin', () => {
  const identity = parseJavaIdentity(HANDWRITTEN_MOUSE)!
  const sourcePath = 'src/client/java/com/example/frame_cover/mixin/MouseMixin.java'
  const config = {
    package: 'com.example.frame_cover.mixin',
    client: ['TitleScreenBgInjector', 'TitleScreenUiAdjuster', 'MouseMixin'],
    mixins: []
  }
  const result = validateHandwrittenMixin({
    source: HANDWRITTEN_MOUSE,
    sourcePath,
    identity,
    config,
    configName: 'frame-cover.mixins.json',
    refs: ['frame-cover.mixins.json'],
    preferredSide: 'client'
  })
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.equal(result.relativeClass, 'MouseMixin')
  assert.equal(result.side, 'client')
})

test('validateHandwrittenMixin fails when not registered', () => {
  const identity = parseJavaIdentity(HANDWRITTEN_MOUSE)!
  const result = validateHandwrittenMixin({
    source: HANDWRITTEN_MOUSE,
    sourcePath: 'src/client/java/com/example/frame_cover/mixin/MouseMixin.java',
    identity,
    config: {
      package: 'com.example.frame_cover.mixin',
      client: ['TitleScreenBgInjector'],
      mixins: []
    },
    configName: 'frame-cover.mixins.json',
    refs: ['frame-cover.mixins.json'],
    preferredSide: 'client'
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /未注册/.test(e)))
})

test('validateHandwrittenMixin fails without @Mixin', () => {
  const identity = parseJavaIdentity(PLAIN_CLASS)!
  const result = validateHandwrittenMixin({
    source: PLAIN_CLASS,
    sourcePath: 'src/main/java/com/example/frame_cover/Helper.java',
    identity,
    config: { package: 'com.example.frame_cover', mixins: ['Helper'] },
    configName: 'mod.mixins.json',
    refs: ['mod.mixins.json']
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => /@Mixin/.test(e)))
})

test('isAcceptableHandwrittenMixinPath accepts client and main', () => {
  const fqn = 'com.example.frame_cover.mixin.MouseMixin'
  assert.equal(
    isAcceptableHandwrittenMixinPath(
      'src/client/java/com/example/frame_cover/mixin/MouseMixin.java',
      fqn
    ),
    true
  )
  assert.equal(
    isAcceptableHandwrittenMixinPath(
      'src/main/java/com/example/frame_cover/mixin/MouseMixin.java',
      fqn
    ),
    true
  )
  assert.equal(
    isAcceptableHandwrittenMixinPath('wrong/MouseMixin.java', fqn),
    false
  )
})

test('relativeMixinClassName and sideToConfigKey helpers', () => {
  const id = {
    packageName: 'com.example.frame_cover.mixin',
    className: 'MouseMixin',
    fqn: 'com.example.frame_cover.mixin.MouseMixin'
  }
  assert.equal(relativeMixinClassName(id, 'com.example.frame_cover.mixin'), 'MouseMixin')
  assert.equal(sideToConfigKey('client'), 'client')
  assert.equal(sideToConfigKey('common'), 'mixins')
})

test('recordsStepEvidence accepts lightweight mixin validation result', () => {
  const step: WorkflowStep = {
    id: '4',
    title: '将 MouseMixin 注册到 frame-cover.mixins.json',
    kind: 'mixin',
    status: 'running',
    allowedTools: ['fabric_mixin_register', 'fabric_mixin_validate'],
    maxAttempts: 4,
    targetPath: 'src/main/resources/frame-cover.mixins.json'
  }
  const result: ToolResult = {
    output: 'Mixin 轻量校验通过（手写 Mixin）: com.example.frame_cover.mixin.MouseMixin',
    durationMs: 10,
    ok: true,
    toolName: 'fabric_mixin_validate',
    validation: {
      kind: 'mixin',
      valid: true,
      version: '1.21.4',
      targetPath: 'src/client/java/com/example/frame_cover/mixin/MouseMixin.java',
      checkedAt: Date.now()
    }
  }
  assert.equal(recordsStepEvidence(step, result), true)
})
