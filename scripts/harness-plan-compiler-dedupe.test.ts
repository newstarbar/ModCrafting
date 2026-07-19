import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compilePlanFromText,
  dedupeByPath,
  resolveCompiledStepKind,
  type CompiledPlanStep
} from '../src/renderer/src/harness/plan-compiler.ts'
import { buildEmptyToolCallInstruction } from '../src/renderer/src/harness/workflow-engine.ts'
import { normalizeWorkflowSteps } from '../src/renderer/src/harness/plan-normalizer.ts'
import type { PlanStepState } from '../src/renderer/src/harness/plan-tracker.ts'

/** Repro: inspect then write same path must keep the write step (diag 20260719). */
test('dedupeByPath: inspect + write same targetPath keeps both', () => {
  const steps: CompiledPlanStep[] = [
    {
      id: '1',
      kind: 'inspect',
      description: '读取 BackgroundRenderer.java 定位 drawTexture',
      targetPath: 'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java'
    },
    {
      id: '2',
      kind: 'inspect',
      description: '读取 Mixin 源码',
      targetPaths: [
        'src/client/java/com/example/frame_cover/mixin/TitleScreenBackgroundMixin.java',
        'src/client/java/com/example/frame_cover/mixin/TitleScreenRenderMixin.java'
      ]
    },
    {
      id: '3',
      kind: 'write',
      description: '修复 drawTexture textureWidth/textureHeight',
      targetPath: 'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java'
    }
  ]
  const out = dedupeByPath(steps)
  assert.equal(out.length, 3)
  assert.equal(out[0].kind, 'inspect')
  assert.equal(out[2].kind, 'write')
  assert.equal(
    out[2].targetPath,
    'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java'
  )
})

test('dedupeByPath: duplicate write same path keeps first only', () => {
  const steps: CompiledPlanStep[] = [
    {
      id: '1',
      kind: 'write',
      description: '写 A',
      targetPath: 'src/main/java/com/example/Foo.java'
    },
    {
      id: '2',
      kind: 'write',
      description: '再写 A',
      targetPath: 'src/main/java/com/example/Foo.java'
    }
  ]
  const out = dedupeByPath(steps)
  assert.equal(out.length, 1)
  assert.equal(out[0].description, '写 A')
})

test('resolveCompiledStepKind: inspect of Mixin.java stays inspect', () => {
  const kind = resolveCompiledStepKind({
    kind: 'inspect',
    description: '读取 TitleScreenBackgroundMixin.java 确认 drawTexture',
    targetPath: 'src/client/java/com/example/frame_cover/mixin/TitleScreenBackgroundMixin.java'
  })
  assert.equal(kind, 'inspect')
})

test('resolveCompiledStepKind: write of Mixin.java still becomes mixin', () => {
  const kind = resolveCompiledStepKind({
    kind: 'write',
    description: '新建 TitleScreenBgMixin 注入背景',
    targetPath: 'src/client/java/com/example/frame_cover/mixin/TitleScreenBgMixin.java'
  })
  assert.equal(kind, 'mixin')
})

test('compilePlanFromText: inspect+write same path survives and inspect mixin not promoted', () => {
  const text = JSON.stringify({
    steps: [
      {
        kind: 'inspect',
        description: '读取 BackgroundRenderer.java 完整源码，定位 drawTexture',
        targetPath: 'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java',
        evidence: '需确认 textureWidth'
      },
      {
        kind: 'inspect',
        description: '读取 TitleScreenBackgroundMixin.java 确认缩放逻辑',
        targetPaths: [
          'src/client/java/com/example/frame_cover/mixin/TitleScreenBackgroundMixin.java',
          'src/client/java/com/example/frame_cover/mixin/TitleScreenRenderMixin.java'
        ],
        evidence: '确认 Mixin 注入点'
      },
      {
        kind: 'write',
        description: '修复 drawTexture 参数使 UV 映射正确',
        targetPath: 'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java',
        evidence: 'textureWidth 等于实际纹理宽高'
      }
    ]
  })
  const compiled = compilePlanFromText(text)
  const kinds = compiled.map((s) => s.kind)
  assert.ok(kinds.includes('write'), `expected write step, got kinds=${kinds.join(',')}`)
  assert.ok(
    compiled.some(
      (s) =>
        s.kind === 'write' &&
        s.targetPath === 'src/client/java/com/example/frame_cover/background/BackgroundRenderer.java'
    ),
    'write step for BackgroundRenderer must survive dedupe'
  )
  const mixinInspect = compiled.find(
    (s) =>
      s.kind === 'inspect' &&
      (s.targetPaths || []).some((p) => p.includes('TitleScreenBackgroundMixin'))
  )
  assert.ok(mixinInspect, 'mixin inspect step must remain inspect')
  assert.equal(mixinInspect!.kind, 'inspect')
  assert.equal(/fabric_mixin_register/.test(mixinInspect!.description), false)
})

test('buildEmptyToolCallInstruction: inspect nudges read/complete, not write', () => {
  const steps: PlanStepState[] = [
    {
      id: '1',
      kind: 'inspect',
      description: '读取 BackgroundRenderer.java',
      targetPath: 'src/client/java/com/example/BackgroundRenderer.java',
      status: 'running'
    }
  ]
  const step = normalizeWorkflowSteps(steps)[0]
  const instruction = buildEmptyToolCallInstruction(step)
  assert.match(instruction, /read_file|grep|complete_step/)
  assert.equal(/write_file|edit_file/.test(instruction), false)
})
