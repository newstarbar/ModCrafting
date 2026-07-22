import test from 'node:test'
import assert from 'node:assert/strict'
import { FileSession } from '../../src/renderer/src/harness/file-session.ts'
import { guardedWriteFile } from '../../src/renderer/src/harness/guarded-write.ts'
import { validateToolCalls } from '../../src/renderer/src/harness/tool-call-validator.ts'
import {
  applyExploreToolLimit,
  isWriteArgsTruncationResult,
  LARGE_FILE_REWRITE_RECOVERY,
  MAX_WRITE_TRUNCATION_STREAK,
  nextWriteTruncationStreak,
  stepEvidenceSatisfied
} from '../../src/renderer/src/harness/workflow-engine.ts'
import type { ToolResult } from '../../src/renderer/src/harness/tools.ts'
import type { WorkflowStep } from '../../src/renderer/src/harness/workflow-types.ts'

function installWindow(api: Record<string, unknown>): () => void {
  const prior = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { api }
  return () => {
    ;(globalThis as { window?: unknown }).window = prior
  }
}

const EXISTING = 'package x;\n\npublic class One {\n  int a;\n}\n'
const SKELETON = 'package x;\n\npublic class One {\n}\n'

// ── overwrite gate ──

test('guardedWriteFile rejects overwrite of non-empty file without allowOverwrite', async () => {
  const restore = installWindow({
    readFile: async () => ({ success: true, content: EXISTING }),
    writeFile: async () => ({ success: true })
  })
  try {
    const result = await guardedWriteFile(
      { projectPath: '/proj', callId: 't' },
      'src/main/java/One.java',
      SKELETON
    )
    assert.equal(result.ok, false)
    assert.match(result.message, /aci_write_gate/)
    assert.match(result.message, /overwrite=true/)
  } finally {
    restore()
  }
})

test('guardedWriteFile allows overwrite when allowOverwrite=true', async () => {
  let written: string | undefined
  const restore = installWindow({
    readFile: async () => ({ success: true, content: EXISTING }),
    writeFile: async (_abs: string, content: string) => {
      written = content
      return { success: true }
    }
  })
  try {
    const result = await guardedWriteFile(
      { projectPath: '/proj', callId: 't' },
      'src/main/java/One.java',
      SKELETON,
      { allowOverwrite: true }
    )
    assert.equal(result.ok, true)
    assert.equal(written, SKELETON)
    assert.equal(result.fileExisted, true)
  } finally {
    restore()
  }
})

test('overwrite write path: FileSession read gate then guardedWrite allowOverwrite', async () => {
  // Mirrors write_file(overwrite=true): refuse until read, then allowOverwrite.
  const session = new FileSession()
  const relPath = 'src/main/java/One.java'
  assert.equal(session.hasRead(relPath), false)
  const gateBlocked =
    !session.hasRead(relPath)
      ? `blocked: [aci_read_gate] 覆盖写入前须先 read_file：${relPath}。`
      : null
  assert.match(String(gateBlocked), /aci_read_gate/)

  session.markRead(relPath)
  const restore = installWindow({
    readFile: async () => ({ success: true, content: EXISTING }),
    writeFile: async () => ({ success: true })
  })
  try {
    const result = await guardedWriteFile(
      { projectPath: '/proj', callId: 't', fileSession: session },
      relPath,
      SKELETON,
      { allowOverwrite: true }
    )
    assert.equal(result.ok, true)
  } finally {
    restore()
  }
})

// ── truncation recovery copy + streak ──

test('validateToolCalls truncation hint for write_file/edit_file mentions skeleton protocol', () => {
  const offered = [
    {
      name: 'write_file',
      description: 'write',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'edit_file',
      description: 'edit',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  ]
  const result = validateToolCalls(
    [
      {
        id: 'w1',
        name: 'write_file',
        args: {},
        rawArguments: '{"path":"A.java","content":"class A {{{{{'
      },
      {
        id: 'e1',
        name: 'edit_file',
        args: {},
        rawArguments: '{"path":"A.java","old_string":"x","new_string":"y'
      }
    ],
    offered
  )
  const writeOut = String(result.rejected.get('w1')?.output || '')
  const editOut = String(result.rejected.get('e1')?.output || '')
  assert.equal(result.rejected.get('w1')?.errorKind, 'invalid_tool_arguments')
  assert.match(writeOut, /大文件易截断/)
  assert.match(writeOut, /overwrite=true/)
  assert.match(writeOut, /不要 fabric_docs_search/)
  assert.match(editOut, /大文件易截断/)
  assert.match(editOut, /不要 fabric_docs_search/)
})

test('nextWriteTruncationStreak reaches MAX after consecutive same-path truncations', () => {
  const trunc = (path: string): ToolResult => ({
    id: 'c',
    toolName: 'write_file',
    ok: false,
    errorKind: 'invalid_tool_arguments',
    output: 'blocked: [invalid_tool_arguments] arguments 不是合法 JSON（大文件易截断）…',
    error: 'invalid',
    args: { path }
  })
  assert.equal(isWriteArgsTruncationResult(trunc('A.java')), true)
  let streak = 0
  let path = ''
  ;({ streak, path } = nextWriteTruncationStreak([trunc('A.java')], streak, path))
  assert.equal(streak, 1)
  assert.equal(path, 'A.java')
  ;({ streak, path } = nextWriteTruncationStreak([trunc('A.java')], streak, path))
  assert.equal(streak, MAX_WRITE_TRUNCATION_STREAK)
  assert.ok(streak >= MAX_WRITE_TRUNCATION_STREAK)
  assert.match(LARGE_FILE_REWRITE_RECOVERY, /overwrite=true/)
  assert.match(LARGE_FILE_REWRITE_RECOVERY, /不要 fabric_docs_search/)
})

test('applyExploreToolLimit stripKnowledge alone removes docs tools', () => {
  const names = [
    'write_file',
    'edit_file',
    'read_file',
    'fabric_docs_search',
    'fabric_javadoc_lookup',
    'complete_step'
  ]
  const limited = applyExploreToolLimit(names, {
    exploreExhausted: false,
    stripKnowledge: true
  })
  assert.deepEqual(limited, ['write_file', 'edit_file', 'read_file', 'complete_step'])
})

// ── disk existence alone is not write evidence ──

test('disk-style artifact alone does not satisfy write stepEvidenceSatisfied without tool write', () => {
  const step: WorkflowStep = {
    id: '1',
    title: '重写 One.java',
    kind: 'write',
    status: 'running',
    allowedTools: ['write_file', 'edit_file', 'complete_step'],
    maxAttempts: 6,
    targetPath: 'src/main/java/One.java'
  }
  // Synthetic "file already on disk" probe result — must NOT count as write evidence.
  const diskOnly: ToolResult[] = [
    {
      id: 'disk',
      toolName: 'disk_probe',
      ok: true,
      output: 'exists',
      artifactPath: 'src/main/java/One.java',
      artifactPaths: ['src/main/java/One.java'],
      args: { path: 'src/main/java/One.java' }
    }
  ]
  assert.equal(stepEvidenceSatisfied(step, diskOnly), false)

  const withWrite: ToolResult[] = [
    {
      id: 'w',
      toolName: 'write_file',
      ok: true,
      output: '已写入: src/main/java/One.java',
      artifactPath: 'src/main/java/One.java',
      artifactPaths: ['src/main/java/One.java'],
      args: { path: 'src/main/java/One.java', content: SKELETON, overwrite: true }
    }
  ]
  assert.equal(stepEvidenceSatisfied(step, withWrite), true)
})
