/**
 * Readable comparison output. A golden failure must name the file and the first
 * differing line, otherwise a 20-file tree diff is unreadable in CI logs.
 */
import type { CapturedTree } from './capture.ts'
import { sha256 } from './capture.ts'

function firstDifference(expected: string, actual: string): string {
  const left = expected.split('\n'), right = actual.split('\n')
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) continue
    const context = (lines: string[], from: number) => lines.slice(Math.max(0, from - 2), from + 3).map((line, offset) => `${String(Math.max(0, from - 2) + offset + 1).padStart(5)} | ${line}`).join('\n')
    return [`  期望第 ${index + 1} 行：${left[index] ?? '<缺失>'}`, `  实际第 ${index + 1} 行：${right[index] ?? '<缺失>'}`, '  期望上下文：', context(left, index), '  实际上下文：', context(right, index)].join('\n')
  }
  return '  内容相同但哈希不同（可能存在不可见字符）'
}

export function diffTrees(expected: CapturedTree, actual: CapturedTree): string[] {
  const problems: string[] = []
  const expectedText = new Map(expected.text.map((file) => [file.path, file.content]))
  const actualText = new Map(actual.text.map((file) => [file.path, file.content]))
  for (const [path, content] of expectedText) {
    const found = actualText.get(path)
    if (found === undefined) { problems.push(`缺失文件 ${path}`); continue }
    if (found !== content) problems.push(`内容变化 ${path}\n${firstDifference(content, found)}`)
  }
  for (const path of actualText.keys()) if (!expectedText.has(path)) problems.push(`新增文件 ${path}`)
  const expectedBinary = new Map(expected.binary.map((file) => [file.path, file]))
  const actualBinary = new Map(actual.binary.map((file) => [file.path, file]))
  for (const [path, record] of expectedBinary) {
    const found = actualBinary.get(path)
    if (!found) { problems.push(`缺失二进制 ${path}`); continue }
    if (found.sha256 !== record.sha256) problems.push(`二进制变化 ${path}（期望 ${record.sha256.slice(0, 12)}… 实际 ${found.sha256.slice(0, 12)}…，大小 ${record.size} → ${found.size}）`)
  }
  for (const path of actualBinary.keys()) if (!expectedBinary.has(path)) problems.push(`新增二进制 ${path}`)
  return problems
}

export function summarizeTree(tree: CapturedTree): string {
  const total = tree.text.reduce((sum, file) => sum + file.content.length, 0)
  return `${tree.text.length} 个文本（${total} 字节）+ ${tree.binary.length} 个二进制`
}

export const hashOf = sha256
