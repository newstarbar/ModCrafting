import test from 'node:test'
import assert from 'node:assert/strict'
import {
  groupExploreToolRuns,
  summarizeExploreGroup,
  isExploreTool,
  findExploreBursts,
  getAbsorbedEntryIndices
} from '../src/renderer/src/utils/tool-explore-group.ts'
import type { ChronoEntry, ChronoEntryTool } from '../src/renderer/src/types/display-message.ts'

function tool(
  id: string,
  name: string,
  args?: Record<string, unknown>,
  status: ChronoEntryTool['status'] = 'done',
  output?: string
): ChronoEntryTool {
  return {
    kind: 'tool',
    id,
    name,
    status,
    args,
    output,
    displayName: name
  }
}

function reasoning(content: string): ChronoEntry {
  return { kind: 'reasoning', content, done: true }
}

function text(content: string): ChronoEntry {
  return { kind: 'text', content }
}

test('groupExploreToolRuns merges consecutive read_file into project group', () => {
  const entries = [
    tool('1', 'read_file', { path: 'src/a.java' }),
    tool('2', 'read_file', { path: 'src/b.java' }),
    tool('3', 'write_file', { path: 'src/c.java' })
  ]
  const segments = groupExploreToolRuns('msg-1', entries)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'explore-group')
  if (segments[0].type === 'explore-group') {
    assert.equal(segments[0].kind, 'project')
    assert.equal(segments[0].tools.length, 2)
    assert.equal(segments[0].reasoningCount, 0)
  }
  assert.equal(segments[1].type, 'tool')
})

test('groupExploreToolRuns soft-merges read_file across reasoning gap', () => {
  const entries = [
    tool('1', 'read_file', { path: 'src/a.java' }),
    reasoning('先看结构'),
    tool('2', 'read_file', { path: 'src/b.java' })
  ]
  const segments = groupExploreToolRuns('msg-soft', entries)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'explore-group')
  if (segments[0].type === 'explore-group') {
    assert.equal(segments[0].tools.length, 2)
    assert.equal(segments[0].reasoningCount, 1)
  }
})

test('groupExploreToolRuns does not merge read_file across text gap', () => {
  const entries = [
    tool('1', 'read_file', { path: 'a.json' }),
    text('中间说明'),
    tool('2', 'read_file', { path: 'b.json' })
  ]
  const segments = groupExploreToolRuns('msg-text', entries)
  assert.equal(segments.length, 3)
  assert.equal(segments[0].type, 'tool')
  assert.equal(segments[1].type, 'entry')
  assert.equal(segments[2].type, 'tool')
})

test('groupExploreToolRuns creates knowledge group for consecutive docs search', () => {
  const entries = [
    tool('1', 'list_directory', { path: 'src' }),
    tool('2', 'fabric_docs_search', { keyword: 'Block' }),
    tool('3', 'fabric_docs_search', { keyword: 'Item' })
  ]
  const segments = groupExploreToolRuns('msg-2', entries)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].type, 'tool')
  assert.equal(segments[1].type, 'explore-group')
  if (segments[1].type === 'explore-group') {
    assert.equal(segments[1].kind, 'knowledge')
    assert.equal(segments[1].tools.length, 2)
  }
})

test('groupExploreToolRuns does not merge across kinds even with reasoning', () => {
  const entries = [
    tool('1', 'read_file', { path: 'a.json' }),
    reasoning('查文档'),
    tool('2', 'fabric_docs_search', { keyword: 'x' }),
    tool('3', 'read_file', { path: 'b.json' })
  ]
  const segments = groupExploreToolRuns('msg-3', entries)
  assert.ok(segments.every((s) => s.type !== 'explore-group'))
  assert.equal(segments.filter((s) => s.type === 'tool').length, 3)
  assert.equal(segments.filter((s) => s.type === 'entry').length, 1)
})

test('single explore tool stays as individual tool segment', () => {
  const entries = [tool('1', 'read_file', { path: 'only.json' })]
  const segments = groupExploreToolRuns('msg-4', entries)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'tool')
})

test('getAbsorbedEntryIndices marks burst reasoning and duplicate tools', () => {
  const entries = [
    tool('1', 'read_file', { path: 'a.java' }),
    reasoning('思考'),
    tool('2', 'list_directory', { path: 'src' })
  ]
  const absorbed = getAbsorbedEntryIndices(entries)
  assert.equal(absorbed.has(0), false)
  assert.equal(absorbed.has(1), true)
  assert.equal(absorbed.has(2), true)
})

test('findExploreBursts returns burst metadata', () => {
  const entries = [
    tool('1', 'read_file', { path: 'a.java' }),
    reasoning('x'),
    tool('2', 'read_file', { path: 'b.java' })
  ]
  const bursts = findExploreBursts(entries)
  assert.equal(bursts.length, 1)
  assert.deepEqual(bursts[0].toolIndices, [0, 2])
  assert.deepEqual(bursts[0].absorbedReasoningIndices, [1])
})

test('summarizeExploreGroup project stats and path preview', () => {
  const tools = [
    tool('1', 'read_file', { path: 'src/main/java/Mod.java' }, 'done', 'ok'),
    tool('2', 'list_directory', { path: 'src/main/resources' }, 'done', 'a\nb'),
    tool('3', 'read_file', { path: 'fabric.mod.json' }, 'running')
  ]
  const summary = summarizeExploreGroup('project', tools, 2)
  assert.equal(summary.title, '项目探索')
  assert.match(summary.statsLine, /2 读取/)
  assert.match(summary.statsLine, /1 目录/)
  assert.match(summary.countLabel, /探索中/)
  assert.equal(summary.hasRunning, true)
  assert.match(summary.pathPreview, /Mod\.java/)
  assert.equal(summary.thoughtHint, '· 含思考')
})

test('summarizeExploreGroup knowledge keywords', () => {
  const tools = [
    tool('1', 'fabric_docs_search', { keyword: 'ArmorItem' }, 'done', '结果：命中'),
    tool('2', 'vanilla_mc_wiki_query', { keyword: 'recipe' }, 'done', '结果：wiki')
  ]
  const summary = summarizeExploreGroup('knowledge', tools)
  assert.equal(summary.title, '文档查询')
  assert.match(summary.statsLine, /ArmorItem/)
  assert.equal(summary.thoughtHint, null)
})

test('isExploreTool identifies project and knowledge tools only', () => {
  assert.equal(isExploreTool('read_file'), true)
  assert.equal(isExploreTool('fabric_docs_search'), true)
  assert.equal(isExploreTool('write_file'), false)
})
