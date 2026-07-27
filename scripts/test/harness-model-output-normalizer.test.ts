import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripThinkTags,
  extractPlanFromXml,
  buildSubmitPlanArgs,
  ThinkTagStreamFilter
} from '../../src/renderer/src/harness/model-output-normalizer.ts'

describe('model-output-normalizer', () => {
  describe('stripThinkTags', () => {
    it('extracts <think> content and removes it from text', () => {
      const input = 'Hello world<think>internal reasoning here</think>after text'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'Hello worldafter text')
      assert.equal(result.reasoning, 'internal reasoning here')
    })

    it('handles multiple <think> blocks', () => {
      const input = 'start<think>reason 1</think>mid<think>reason 2</think>end'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'startmidend')
      assert.equal(result.reasoning, 'reason 1\n\nreason 2')
    })

    it('handles unclosed <think> tag (treats rest as reasoning)', () => {
      const input = 'text before<think>unclosed reasoning continues to end'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'text before')
      assert.equal(result.reasoning, 'unclosed reasoning continues to end')
    })

    it('handles multiline <think> content', () => {
      const input = 'visible text<think>line 1\nline 2\nline 3</think>more text'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'visible textmore text')
      assert.equal(result.reasoning, 'line 1\nline 2\nline 3')
    })

    it('returns empty reasoning when no <think> tags', () => {
      const input = 'just regular text'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'just regular text')
      assert.equal(result.reasoning, '')
    })

    it('handles case-insensitive <think> tags', () => {
      const input = 'text<THINK>reasoning</THINK>more'
      const result = stripThinkTags(input)
      assert.equal(result.text, 'textmore')
      assert.equal(result.reasoning, 'reasoning')
    })
  })

  describe('extractPlanFromXml', () => {
    it('parses <plan> XML with self-closing <step> tags', () => {
      const xml = `<plan>
<step kind="edit_file" description="Fix blur" targetPath="src/Screen.java" evidence="blur issue"/>
<step kind="mixin" description="Add Mixin" targetPath="src/Mixin.java" evidence="mixin needed"/>
</plan>`
      const steps = extractPlanFromXml(xml)
      assert.ok(steps)
      assert.equal(steps!.length, 2)
      assert.equal(steps![0].kind, 'write')
      assert.equal(steps![0].description, 'Fix blur')
      assert.equal(steps![0].targetPath, 'src/Screen.java')
      assert.equal(steps![1].kind, 'mixin')
    })

    it('filters out build and run steps (auto-appended by host)', () => {
      const xml = `<plan>
<step kind="edit_file" description="Fix code" targetPath="src/Foo.java" evidence="bug"/>
<step kind="build" description="Build project" targetPath="build.gradle" evidence="compile"/>
<step kind="run" description="Run game" targetPath="run/minecraft" evidence="test"/>
</plan>`
      const steps = extractPlanFromXml(xml)
      assert.ok(steps)
      assert.equal(steps!.length, 1)
      assert.equal(steps![0].kind, 'write')
    })

    it('maps scaffold and register_mixin to mixin kind', () => {
      const xml = `<plan>
<step kind="scaffold" description="Scaffold Mixin" targetPath="src/M.java" evidence="scaffold"/>
<step kind="register_mixin" description="Register Mixin" targetPath="mixins.json" evidence="register"/>
</plan>`
      const steps = extractPlanFromXml(xml)
      assert.ok(steps)
      assert.equal(steps!.length, 2)
      assert.equal(steps![0].kind, 'mixin')
      assert.equal(steps![1].kind, 'mixin')
    })

    it('infers kind from description when kind is non-standard', () => {
      const xml = `<plan>
<step kind="unknown" description="检查现有配置与源码" targetPath="mixins.json" evidence="inspect"/>
</plan>`
      const steps = extractPlanFromXml(xml)
      assert.ok(steps)
      assert.equal(steps![0].kind, 'inspect')
    })

    it('returns null when no <plan> XML found', () => {
      assert.equal(extractPlanFromXml('just text'), null)
      assert.equal(extractPlanFromXml('<other>content</other>'), null)
    })

    it('returns null when <plan> has no valid steps', () => {
      const xml = '<plan><step kind="build" description="build" targetPath="b" evidence="e"/></plan>'
      const steps = extractPlanFromXml(xml)
      // All steps are build/run, filtered out → null
      assert.equal(steps, null)
    })

    it('uses description as evidence fallback', () => {
      const xml = `<plan>
<step kind="edit_file" description="Fix something" targetPath="src/F.java"/>
</plan>`
      const steps = extractPlanFromXml(xml)
      assert.ok(steps)
      assert.equal(steps![0].evidence, 'Fix something')
    })
  })

  describe('buildSubmitPlanArgs', () => {
    it('builds submit_plan args from parsed steps', () => {
      const steps = [
        { kind: 'write', description: 'Fix code', targetPath: 'src/Foo.java', evidence: 'bug fix' },
        { kind: 'mixin', description: 'Add mixin', targetPath: 'src/M.java', evidence: 'mixin' }
      ]
      const args = buildSubmitPlanArgs(steps)
      assert.ok(args.steps)
      assert.equal(args.steps.length, 2)
      assert.equal(args.steps[0].kind, 'write')
      assert.equal(args.steps[0].targetPath, 'src/Foo.java')
    })

    it('provides default targetPath when missing', () => {
      const steps = [
        { kind: 'inspect', description: 'Check code', evidence: 'inspection' }
      ]
      const args = buildSubmitPlanArgs(steps)
      assert.ok(args.steps[0].targetPath)
    })
  })

  describe('ThinkTagStreamFilter', () => {
    it('routes text outside <think> to text and inside to reasoning', () => {
      const filter = new ThinkTagStreamFilter()
      const r1 = filter.process('Hello ')
      assert.equal(r1.text, 'Hello ')
      assert.equal(r1.reasoning, '')

      const r2 = filter.process('<think>reasoning')
      assert.equal(r2.text, '')
      assert.equal(r2.reasoning, 'reasoning')

      const r3 = filter.process('</think> world')
      assert.equal(r3.text, ' world')
      assert.equal(r3.reasoning, '')
    })

    it('handles <think> tag split across chunks', () => {
      const filter = new ThinkTagStreamFilter()
      const r1 = filter.process('text<th')
      assert.equal(r1.text, 'text')
      assert.equal(r1.reasoning, '')

      const r2 = filter.process('ink>hidden')
      assert.equal(r2.text, '')
      assert.equal(r2.reasoning, 'hidden')

      const r3 = filter.process('</think>more')
      assert.equal(r3.text, 'more')
      assert.equal(r3.reasoning, '')
    })

    it('flush outputs remaining buffer as text when not in think block', () => {
      const filter = new ThinkTagStreamFilter()
      // process 输出短文本时可能保留在 buffer（≤8 字符），flush 负责输出剩余
      filter.process('some text that is long enough to be output')
      const flushed = filter.flush()
      // buffer 已在 process 中清空，flush 输出空
      assert.equal(flushed.text, '')
      assert.equal(flushed.reasoning, '')
    })

    it('flush outputs remaining buffer as reasoning when in think block', () => {
      const filter = new ThinkTagStreamFilter()
      // 末尾 `<` 是 `</think>` 的部分前缀，保留在 buffer 中等待 flush
      const r = filter.process('<think>reasoning<')
      assert.equal(r.reasoning, 'reasoning')
      const flushed = filter.flush()
      assert.equal(flushed.text, '')
      assert.equal(flushed.reasoning, '<')
    })

    it('handles multiple <think> blocks in sequence', () => {
      const filter = new ThinkTagStreamFilter()
      const r = filter.process('a<think>b</think>c<think>d</think>e')
      assert.equal(r.text, 'ace')
      assert.equal(r.reasoning, 'bd')
    })
  })
})
