#!/usr/bin/env node
/**
 * SessionStart hook: inject a short "where am I" preamble into the conversation.
 * SessionStart stdout is appended to context, so the budget is hard: keep it under 1.4KB and
 * never include tokens, absolute user paths beyond the user's own project path, or log bodies.
 */
import path from 'node:path'
import { activeSessions, dataRoot, guarded, processAlive, readJson, readPayload } from './lib/context.mjs'

const LIMIT = 1400

guarded(async () => {
  await readPayload()
  const root = dataRoot()
  const lines = []
  const sessions = activeSessions(root)
  const live = sessions.filter((record) => processAlive(record.ownerPid))
  const resumable = sessions.filter((record) => !processAlive(record.ownerPid))
  const recent = live[0] || resumable[0]

  if (recent) {
    lines.push(`最近任务会话：${recent.name || '未命名'}｜阶段：${recent.phase || '未知'}｜工程：${recent.projectPath || '未绑定'}｜sessionId：${recent.sessionId}`)
    if (live[0] === recent) lines.push('该会话可能正被另一个窗口使用；同一会话不能同时被两个后端占用。')
    const others = resumable.filter((record) => record !== recent).length
    if (others) lines.push(`另有 ${others} 个可恢复的旧会话，用 modcrafting_session 的 resume 继续。`)
  } else {
    lines.push('ModCrafting 目前没有进行中的任务会话。')
  }

  const toolchain = readJson(path.join(root, 'toolchain.json'))
  if (toolchain?.javaHome) lines.push(`已保存的 JDK 21：${toolchain.javaHome}`)
  if (!toolchain?.javaHome && process.env.JAVA_HOME?.trim()) lines.push(`当前 JAVA_HOME：${process.env.JAVA_HOME}`)

  lines.push(recent
    ? '继续这个任务前先 resume 它；新任务先 create 一个新会话。每次构建、游戏、测试、截图、停止操作都要带这个 sessionId。'
    : '新任务请先 modcrafting_session create；没有工程时先选一个空目录或已有 Fabric 工程，再查环境。')

  const output = lines.join('\n')
  process.stdout.write(output.length > LIMIT ? `${output.slice(0, LIMIT)}…` : output)
})
