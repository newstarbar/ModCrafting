#!/usr/bin/env node
/**
 * PostToolUse hook: remember the active session, hand the workbench URL to the host browser, and
 * keep oversized tool text out of the context window.
 *
 * Contract notes:
 *  - `isError` results are never rewritten; the model must see the real code and message.
 *  - `updatedToolOutput` is emitted as a content ARRAY, so only the content blocks are replaced.
 *    structuredContent (and therefore any inline widget) keeps the full data.
 *  - image blocks are passed through untouched.
 */
import { dataRoot, guarded, readPayload } from './lib/context.mjs'
import { writeState } from './lib/tools.mjs'

const TEXT_BUDGET = 8000
const KEEP_HEAD = 1200
const KEEP_TAIL = 600

function toolName(raw) {
  if (typeof raw !== 'string') return ''
  const index = raw.lastIndexOf('__')
  return index >= 0 ? raw.slice(index + 2) : raw
}

function decode(response) {
  if (!response || typeof response !== 'object') return undefined
  if (response.structuredContent && typeof response.structuredContent === 'object') return response.structuredContent
  const blocks = Array.isArray(response.content) ? response.content : []
  const text = blocks.find((block) => block?.type === 'text')?.text
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

guarded(async () => {
  const payload = await readPayload()
  const name = toolName(payload.tool_name ?? payload.toolName)
  const response = payload.tool_response ?? payload.toolResponse ?? payload.tool_output ?? payload.result
  if (!name || !response || typeof response !== 'object') return
  if (response.isError === true) return

  const value = decode(response)

  if (name === 'modcrafting_session') {
    const session = value?.session
    if (session?.sessionId) writeState(dataRoot(), { sessionId: session.sessionId, projectPath: session.projectPath, name: session.name, at: new Date().toISOString() })
  }

  let additionalContext
  if (name === 'modcrafting_open_workbench') {
    const url = value?.browserUrl
    if (typeof url === 'string' && url.startsWith('http')) {
      additionalContext = `工作台已就绪：${url}\n请用 present_files 直接打开这个 URL（宿主内置浏览器）。不要用 Shell、Start-Process 或另起一个服务去打开；在用户确认看到页面之前，不要说“已打开”。`
    }
  }

  let updatedToolOutput
  const blocks = Array.isArray(response.content) ? response.content : []
  const total = blocks.reduce((size, block) => size + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0), 0)
  if (total > TEXT_BUDGET) {
    updatedToolOutput = blocks.map((block) => {
      if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= TEXT_BUDGET) return block
      const omitted = block.text.length - KEEP_HEAD - KEEP_TAIL
      return { type: 'text', text: `${block.text.slice(0, KEEP_HEAD)}\n…（已省略 ${omitted} 字符；完整数据见 structuredContent，或用 minecraft_log_read 分页读取）…\n${block.text.slice(-KEEP_TAIL)}` }
    })
  }

  if (!additionalContext && !updatedToolOutput) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...(updatedToolOutput ? { updatedToolOutput } : {}),
      ...(additionalContext ? { additionalContext } : {})
    }
  }))
})
