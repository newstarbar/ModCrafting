import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseToolCalls } from '../../src/renderer/src/harness/tools.ts'

describe('parseToolCalls', () => {
  describe('standard <tool_call>{...}</tool_call> format', () => {
    it('parses single standard tool call', () => {
      const text = 'Some text\n <tool_call>{"name":"grep","args":{"pattern":"foo","path":"src"}}</tool_call>\n more text'
      const calls = parseToolCalls(text)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'grep')
      assert.equal(calls[0].args.pattern, 'foo')
      assert.equal(calls[0].args.path, 'src')
    })

    it('parses multiple standard tool calls', () => {
      const text = '<tool_call>{"name":"a","args":{}}</tool_call><tool_call>{"name":"b","args":{"x":1}}</tool_call>'
      const calls = parseToolCalls(text)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].name, 'a')
      assert.equal(calls[1].name, 'b')
      assert.equal(calls[1].args.x, 1)
    })

    it('skips malformed JSON in standard format', () => {
      const text = '<tool_call>{"name":"a","args":{invalid}}</tool_call><tool_call>{"name":"b","args":{}}</tool_call>'
      const calls = parseToolCalls(text)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'b')
    })

    it('returns empty when no tool calls found', () => {
      assert.equal(parseToolCalls('just regular text').length, 0)
      assert.equal(parseToolCalls('').length, 0)
    })
  })

  describe('XML invoke format (MiniMax-M3 fallback)', () => {
    it('parses single invoke with string and number params', () => {
      const xml = '<invoke name="fabric_docs_search">\n<parameter name="keyword">KeyBinding ClientTickEvents</parameter>\n<parameter name="mcVersion">1.21.4</parameter>\n<parameter name="limit">5</parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'fabric_docs_search')
      assert.equal(calls[0].args.keyword, 'KeyBinding ClientTickEvents')
      // 1.21.4 含多版本号，应保留为字符串而非解析为数字 1.21
      assert.equal(calls[0].args.mcVersion, '1.21.4')
      assert.equal(calls[0].args.limit, 5)
    })

    it('parses multiple invoke blocks', () => {
      const xml = '<invoke name="grep"><parameter name="pattern">foo</parameter></invoke>\n<invoke name="list_directory"><parameter name="path">src</parameter></invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls.length, 2)
      assert.equal(calls[0].name, 'grep')
      assert.equal(calls[0].args.pattern, 'foo')
      assert.equal(calls[1].name, 'list_directory')
      assert.equal(calls[1].args.path, 'src')
    })

    it('parses invoke with boolean and JSON object params', () => {
      const xml = '<invoke name="write_file">\n<parameter name="path">src/Foo.java</parameter>\n<parameter name="overwrite">true</parameter>\n<parameter name="content">package x;\npublic class Foo {}\n</parameter>\n<parameter name="meta">{"version":2,"nested":{"a":1}}</parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].args.overwrite, true)
      assert.deepEqual(calls[0].args.meta, { version: 2, nested: { a: 1 } })
    })

    it('parses invoke with no params', () => {
      const xml = '<invoke name="list_directory"></invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'list_directory')
      assert.deepEqual(calls[0].args, {})
    })

    it('preserves multiline parameter content', () => {
      const xml = '<invoke name="write_file">\n<parameter name="content">line 1\nline 2\nline 3</parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls[0].args.content, 'line 1\nline 2\nline 3')
    })

    it('trims whitespace in parameter values', () => {
      const xml = '<invoke name="grep">\n<parameter name="pattern">\n   foo\n</parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls[0].args.pattern, 'foo')
    })

    it('handles empty parameter value', () => {
      const xml = '<invoke name="write_file">\n<parameter name="path">src/Empty.java</parameter>\n<parameter name="content"></parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls[0].args.content, '')
    })

    it('preserves 1.21.4 as string (not number 1.21)', () => {
      // 关键回归测试：MiniMax 诊断中发现 method_17851 等版本号/方法名混入，
      // 参数值不能被误判为数字。1.21.4 不是合法 JSON 数字，应保留为字符串。
      const xml = '<invoke name="fabric_meta_version_check">\n<parameter name="mcVersion">1.21.4</parameter>\n<parameter name="yarnBuild">2</parameter>\n</invoke>'
      const calls = parseToolCalls(xml)
      assert.equal(calls[0].args.mcVersion, '1.21.4')
      assert.equal(calls[0].args.yarnBuild, 2)
    })
  })

  describe('format priority', () => {
    it('prefers standard format when both present', () => {
      const text = '<tool_call>{"name":"standard","args":{"x":1}}</tool_call>\n<invoke name="xml"><parameter name="y">2</parameter></invoke>'
      const calls = parseToolCalls(text)
      // 标准格式命中后不再尝试 XML 格式
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'standard')
    })

    it('falls back to XML when standard format has no valid calls', () => {
      const text = 'no standard calls here\n<invoke name="xml"><parameter name="y">2</parameter></invoke>'
      const calls = parseToolCalls(text)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'xml')
      assert.equal(calls[0].args.y, 2)
    })
  })
})
