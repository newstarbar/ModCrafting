import test from 'node:test'
import assert from 'node:assert/strict'
import { captureTree, contentHash, pathsetHash, sha256 } from './golden/capture.ts'
import { diffTrees } from './golden/diff.ts'
import { readBaseline, readIndex, readRepresentative } from './golden/store.ts'

test('resource golden: every mapped cell reproduces its representative byte for byte', () => {
  const index = readIndex()
  assert.ok(index, '缺少 scripts/test/golden/resources/index.json；先运行 pnpm run golden:baseline 与 pnpm run golden:update')
  const cells = Object.entries(index.cells)
  assert.ok(cells.length > 0, 'index.json 没有映射任何单元格')
  for (const [cell, version] of cells) {
    const minecraft = cell.split('@')[1]
    assert.ok(minecraft, `单元格键不合法：${cell}`)
    const record = index.representatives[version]
    assert.ok(record, `${cell} 指向不存在的代表形态 ${version}`)
    const tree = captureTree(minecraft)
    const problems = diffTrees(readRepresentative(version, index), tree)
    assert.deepEqual(problems, [], `${cell} 应与代表形态 ${version} 完全一致，实际差异：\n${problems.slice(0, 6).join('\n')}`)
    assert.equal(contentHash(tree), record.contentHash, `${cell} 内容哈希与 ${version} 不一致`)
    assert.equal(pathsetHash(tree), record.pathsetHash, `${cell} 路径集合与 ${version} 不一致`)
  }
})

test('resource golden: partially supported cells stay byte-identical where they do produce', () => {
  const index = readIndex()
  assert.ok(index)
  for (const [cell, entry] of Object.entries(index.partial ?? {})) {
    const minecraft = cell.split('@')[1]
    assert.ok(minecraft, `单元格键不合法：${cell}`)
    const tree = captureTree(minecraft)
    const representative = readRepresentative(entry.representative, index)
    // Partial means "fewer files", never "different files": filter the expectation to
    // what this cell actually produced, then demand byte equality for those paths.
    const produced = new Set([...tree.text.map((file) => file.path), ...tree.binary.map((file) => file.path)])
    const problems = diffTrees(
      { text: representative.text.filter((file) => produced.has(file.path)), binary: representative.binary.filter((file) => produced.has(file.path)) },
      tree
    )
    assert.deepEqual(problems, [], `${cell} 已产出的文件必须与 ${entry.representative} 一致：\n${problems.slice(0, 6).join('\n')}`)
    assert.ok(entry.reason.length > 0, `${cell} 的部分支持原因不能为空`)
  }
})

test('resource golden: 1.21.4 output still matches the pre-refactor baseline', () => {
  const index = readIndex(), baseline = readBaseline()
  assert.ok(index, '缺少 index.json')
  assert.ok(baseline, '缺少 baseline.json；它只能由 P2 改造前的代码捕获一次')
  const tree = captureTree('1.21.4')
  const actual = new Map<string, string>([
    ...tree.text.map((file) => [file.path, sha256(file.content)] as [string, string]),
    ...tree.binary.map((file) => [file.path, file.sha256] as [string, string])
  ])
  const changed = Object.keys(baseline.files).filter((file) => actual.get(file) !== baseline.files[file])
  const added = [...actual.keys()].filter((file) => !(file in baseline.files))
  assert.deepEqual(changed, [], `以下文件相对改造前基线发生变化：${changed.join(', ')}`)
  assert.deepEqual(added, [], `改造后新增了基线里没有的文件：${added.join(', ')}`)
  assert.equal(pathsetHash(tree), baseline.pathsetHash, '1.21.4 路径集合相对基线发生变化')
  assert.equal(contentHash(tree), baseline.contentHash, '1.21.4 内容相对基线发生变化')
})
