/** Tool classification used by pre-tool-use.mjs. Keep in sync with the registered tool list. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Tools that require an explicit task session. Missing ids are filled from current-session.json. */
export const NEEDS_SESSION = new Set([
  'fabric_build_start', 'fabric_job_status', 'minecraft_log_read', 'fabric_job_stop',
  'minecraft_run_client', 'minecraft_runtime_status', 'minecraft_stop_client', 'minecraft_snapshot',
  'minecraft_entity_query', 'minecraft_widgets', 'minecraft_entity_nbt', 'minecraft_screenshot',
  'minecraft_command', 'minecraft_input', 'minecraft_test_start', 'minecraft_test_status', 'minecraft_build_studio'
])

/**
 * Tools that can destroy user-visible state or leave the machine. The reason string is shown in
 * the host permission dialog, so it must say what will happen, not name internal codes.
 */
export const HIGH_RISK = {
  fabric_job_stop: '将立即终止本次构建或测试任务；已生成的文件和报告会保留，但结果可能不完整。',
  minecraft_stop_client: '将关闭本任务的 Minecraft 客户端；未保存的游戏内状态会丢失。',
  minecraft_test_start: '将在测试世界的预留区域执行动作并清理方块；请确认目标世界正确。',
  minecraft_command: '将向当前游戏世界执行原版命令，可能改变或破坏方块与实体。',
  minecraft_build_studio: '将在测试世界中放置或清除建筑结构，并可能把你传送过去。',
  fabric_project_scaffold: '将在目标空目录写入新的 Gradle 工程与 Wrapper。',
  modcrafting_prepare_assets: '将联网下载 Minecraft / Fabric 知识资料到工程或数据目录。',
  minecraft_run_client: '将启动 Minecraft 客户端（独立游戏目录），首次启动可能下载依赖。'
}

export const isUuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

const statePath = (root) => path.join(root, 'workbuddy', 'current-session.json')

export function readState(root) {
  try {
    const value = JSON.parse(readFileSync(statePath(root), 'utf8'))
    if (!isUuid(value?.sessionId)) return undefined
    return value
  } catch { return undefined }
}

/** Atomic, 0600. A failed write is not fatal: the hook simply has no cached session next time. */
export function writeState(root, value) {
  try {
    const file = statePath(root)
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    renameSync(temporary, file)
  } catch { /* advisory cache only */ }
}

/** The cached session is only usable while its record still exists and is not ended. */
export function usableSession(root, sessionId) {
  if (!isUuid(sessionId)) return false
  try {
    const record = JSON.parse(readFileSync(path.join(root, 'sessions', `${sessionId}.json`), 'utf8'))
    return record?.schemaVersion === 1 && record.status === 'active'
  } catch { return false }
}
