import test from 'node:test'
import assert from 'node:assert/strict'
import {
  groupExploreToolRuns,
  summarizeExploreGroup,
  isExploreTool
} from '../src/renderer/src/utils/tool-explore-group.ts'
import type { ChronoEntryTool } from '../src/renderer/src/types/display-message.ts'

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
  }
  assert.equal(segments[1].type, 'tool')
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

test('groupExploreToolRuns does not merge across kinds', () => {
  const entries = [
    tool('1', 'read_file', { path: 'a.json' }),
    tool('2', 'fabric_docs_search', { keyword: 'x' }),
    tool('3', 'read_file', { path: 'b.json' })
  ]
  const segments = groupExploreToolRuns('msg-3', entries)
  assert.equal(segments.length, 3)
  assert.ok(segments.every((s) => s.type === 'tool'))
})

test('single explore tool stays as individual tool segment', () => {
  const entries = [tool('1', 'read_file', { path: 'only.json' })]
  const segments = groupExploreToolRuns('msg-4', entries)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].type, 'tool')
})

test('summarizeExploreGroup project stats and path preview', () => {
  const tools = [
    tool('1', 'read_file', { path: 'src/main/java/Mod.java' }, 'done', 'ok'),
    tool('2', 'list_directory', { path: 'src/main/resources' }, 'done', 'a\nb'),
    tool('3', 'read_file', { path: 'fabric.mod.json' }, 'running')
  ]
  const summary = summarizeExploreGroup('project', tools)
  assert.equal(summary.title, '项目探索')
  assert.match(summary.statsLine, /2 读取/)
  assert.match(summary.statsLine, /1 目录/)
  assert.match(summary.countLabel, /探索中/)
  assert.equal(summary.hasRunning, true)
  assert.match(summary.pathPreview, /Mod\.java/)
})

test('summarizeExploreGroup knowledge keywords', () => {
  const tools = [
    tool('1', 'fabric_docs_search', { keyword: 'ArmorItem' }, 'done', '结果：命中'),
    tool('2', 'vanilla_mc_wiki_query', { keyword: 'recipe' }, 'done', '结果：wiki')
  ]
  const summary = summarizeExploreGroup('knowledge', tools)
  assert.equal(summary.title, '文档查询')
  assert.match(summary.statsLine, /ArmorItem/)
})

test('isExploreTool identifies project and knowledge tools only', () => {
  assert.equal(isExploreTool('read_file'), true)
  assert.equal(isExploreTool('fabric_docs_search'), true)
  assert.equal(isExploreTool('write_file'), false)
})
