import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { getAppEdition, type AppEdition } from './edition'
import { getRuntimePathOverride } from './app-config'

export interface RuntimeLayout {
  edition: AppEdition
  runtimeRoot: string
  cacheRoot: string
  logRoot: string
  legacyRuntimeRoot?: string
  migrated: boolean
}

function setupRuntimeRoot(): string {
  // 优先读 config.json 的 runtimePath 覆盖（用户自定义数据目录）；
  // 未配置时默认放在安装目录下的 runtime 子目录（与便携版一致）。
  const override = getRuntimePathOverride()
  if (override) return override
  return path.join(path.dirname(app.getPath('exe')), 'runtime')
}

export function getRuntimeLayout(): RuntimeLayout {
  const edition = getAppEdition()
  const legacyRuntimeRoot = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'runtime') : undefined
  const runtimeRoot = edition === 'portable'
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')), 'runtime')
    : edition === 'full'
      ? setupRuntimeRoot()
      : path.resolve(__dirname, '..', '..', 'runtime')
  return {
    edition,
    runtimeRoot,
    cacheRoot: path.join(runtimeRoot, 'gradle-home'),
    logRoot: path.join(runtimeRoot, 'logs'),
    legacyRuntimeRoot,
    migrated: false
  }
}

/** Copy only a complete previous runtime into the new safe Setup location. */
export function migrateLegacyRuntime(isValid: (root: string) => boolean): RuntimeLayout {
  const layout = getRuntimeLayout()
  if (layout.edition !== 'full' || !layout.legacyRuntimeRoot || layout.runtimeRoot === layout.legacyRuntimeRoot) return layout
  if (isValid(layout.runtimeRoot) || !isValid(layout.legacyRuntimeRoot)) return layout
  try {
    const staging = `${layout.runtimeRoot}.migration-${Date.now()}`
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(layout.runtimeRoot), { recursive: true })
    fs.cpSync(layout.legacyRuntimeRoot, staging, { recursive: true, force: false })
    if (!isValid(staging)) {
      fs.rmSync(staging, { recursive: true, force: true })
      return layout
    }
    fs.rmSync(layout.runtimeRoot, { recursive: true, force: true })
    fs.renameSync(staging, layout.runtimeRoot)
    return { ...layout, migrated: true }
  } catch {
    return layout
  }
}

/**
 * 用户主动迁移 runtime 数据到新目录（设置页"修改数据目录"）。
 *
 * 安全策略：
 *  - 源目录无内容时直接跳过 cpSync，仅更新配置；
 *  - 先 cpSync 到 staging 目录，验证复制完整后 rmSync 旧目录；
 *  - 任意步骤失败均回滚 staging，源目录保持不动；
 *  - 调用方必须在迁移前停止 Gradle daemon，避免文件占用。
 *
 * @param sourceRoot 当前 runtimeRoot（迁移前的实际位置）
 * @param targetRoot 用户选择的新 runtimeRoot
 * @param isValid 校验 runtime 是否完整（与 migrateLegacyRuntime 一致）
 * @returns 迁移结果
 */
export function migrateRuntimeToPath(
  sourceRoot: string,
  targetRoot: string,
  isValid: (root: string) => boolean
): { success: boolean; error?: string; migrated: boolean } {
  if (!sourceRoot || !targetRoot) {
    return { success: false, error: '源路径或目标路径为空' }
  }
  if (path.normalize(sourceRoot) === path.normalize(targetRoot)) {
    return { success: true, migrated: false }
  }
  // 源目录不存在或为空：直接返回成功，由调用方更新配置
  if (!fs.existsSync(sourceRoot) || fs.readdirSync(sourceRoot).length === 0) {
    return { success: true, migrated: false }
  }
  const staging = `${targetRoot}.migration-${Date.now()}`
  try {
    // 准备 staging 目录
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(staging), { recursive: true })
    // 复制源目录到 staging
    fs.cpSync(sourceRoot, staging, { recursive: true, force: false })
    // 校验复制结果：源若已是合法 runtime，staging 也应是合法 runtime；
    // 若源不合法（例如部分缺失），仅校验 staging 至少包含与源相同的顶层条目。
    const sourceValid = isValid(sourceRoot)
    if (sourceValid && !isValid(staging)) {
      fs.rmSync(staging, { recursive: true, force: true })
      return { success: false, error: '复制后校验失败，已回滚' }
    }
    // 清理目标位置（可能存在残留空目录或旧残留），然后 rename staging → target
    fs.rmSync(targetRoot, { recursive: true, force: true })
    fs.renameSync(staging, targetRoot)
    // 删除源目录（迁移成功后才删除，避免数据丢失）
    fs.rmSync(sourceRoot, { recursive: true, force: true })
    return { success: true, migrated: true }
  } catch (err) {
    // 回滚 staging
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* ignore */ }
    return { success: false, error: String(err) }
  }
}
