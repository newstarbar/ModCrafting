import type { ToolContext } from './tools.ts'
import { validateFileEditGate } from './edit-gate.ts'
import { FileSession } from './file-session.ts'

export interface GuardedWriteOptions {
  /** When false (default), refuse to overwrite any existing file including empty. */
  allowOverwrite?: boolean
}

export interface GuardedWriteResult {
  ok: boolean
  message: string
  fileExisted: boolean
  oldContent: string
}

/**
 * Central write gate: optional create-only ACI + syntax edit-gate, then writeFile.
 */
export async function guardedWriteFile(
  ctx: ToolContext,
  relPath: string,
  content: string,
  options?: GuardedWriteOptions
): Promise<GuardedWriteResult> {
  if (!ctx.projectPath) {
    return { ok: false, message: 'No project open', fileExisted: false, oldContent: '' }
  }

  const normalized = FileSession.normalize(relPath)
  const abs = `${ctx.projectPath}/${normalized}`
  let oldContent = ''
  let fileExisted = false

  try {
    const old = await window.api.readFile(abs)
    if (old.success && old.content !== undefined) {
      oldContent = old.content
      fileExisted = true
    }
  } catch {
    // new file
  }

  const allowOverwrite = options?.allowOverwrite === true
  // Empty / whitespace-only stubs count as "not really there" so scaffold/move can proceed.
  const isEmptyStub = fileExisted && oldContent.trim().length === 0
  if (fileExisted && !allowOverwrite && !isEmptyStub) {
    return {
      ok: false,
      message:
        `blocked: [aci_write_gate] 文件已存在：${normalized}。` +
        `小改用 edit_file；整文件重写请 write_file(overwrite=true)（须先 read_file），内容过长则先写短骨架再分段 edit_file。` +
        `迁移到新路径：先 write_file 写新文件，再用 delete_file 删除旧文件。`,
      fileExisted,
      oldContent
    }
  }

  const gate = validateFileEditGate(normalized, content)
  if (!gate.ok) {
    return {
      ok: false,
      message: `blocked: [edit_gate] ${gate.reason}。请修正内容后重试。`,
      fileExisted,
      oldContent
    }
  }

  try {
    const res = await window.api.writeFile(abs, content)
    if (!res.success) {
      return {
        ok: false,
        message: `Error: ${res.error}`,
        fileExisted,
        oldContent
      }
    }
    ctx.fileSession?.markRead(normalized)
    return {
      ok: true,
      message: `已写入: ${normalized} (${content.length} bytes)`,
      fileExisted,
      oldContent
    }
  } catch (err) {
    return {
      ok: false,
      message: `Error writing file: ${err}`,
      fileExisted,
      oldContent
    }
  }
}
