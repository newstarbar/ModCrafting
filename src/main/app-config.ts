import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 应用级配置（与 API/Agent 配置分离）。
 * 当前仅存放 runtime 数据目录的覆盖路径；后续可扩展。
 */

export interface AppConfig {
  /** runtime 数据目录绝对路径；为空时使用默认位置（C 盘 LocalAppData） */
  runtimePath?: string
}

const DEFAULT_CONFIG: AppConfig = {}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

/** 读取应用配置；文件不存在或损坏时返回默认值 */
export function loadAppConfig(): AppConfig {
  try {
    const p = configPath()
    if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
    if (parsed && typeof parsed === 'object') {
      const cfg: AppConfig = {}
      if (typeof parsed.runtimePath === 'string' && parsed.runtimePath.trim()) {
        cfg.runtimePath = path.normalize(parsed.runtimePath.trim())
      }
      return cfg
    }
  } catch {
    /* 损坏的配置文件直接忽略 */
  }
  return { ...DEFAULT_CONFIG }
}

/** 写入完整应用配置 */
function writeAppConfig(cfg: AppConfig): { success: boolean; error?: string } {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf-8')
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** 获取当前生效的 runtime 路径覆盖（已校验非空且可访问父目录）；未配置返回 null */
export function getRuntimePathOverride(): string | null {
  const cfg = loadAppConfig()
  if (!cfg.runtimePath) return null
  // 路径合法性校验：必须是绝对路径
  if (!path.isAbsolute(cfg.runtimePath)) return null
  return cfg.runtimePath
}

/** 设置 runtime 路径覆盖；传入空字符串或 null 清除覆盖 */
export function setRuntimePath(target: string | null): { success: boolean; error?: string } {
  const cfg = loadAppConfig()
  const trimmed = (target ?? '').trim()
  if (!trimmed) {
    delete cfg.runtimePath
  } else {
    if (!path.isAbsolute(trimmed)) {
      return { success: false, error: '路径必须是绝对路径' }
    }
    cfg.runtimePath = path.normalize(trimmed)
  }
  return writeAppConfig(cfg)
}

/** 建议默认 runtime 路径：检测非 C 盘根目录，回退到 LocalAppData */
export function suggestDefaultRuntimePath(): string {
  try {
    // Windows 下检测非 C 盘可用盘符
    if (process.platform === 'win32') {
      const drives = ['D', 'E', 'F', 'G']
      for (const letter of drives) {
        const root = `${letter}:\\`
        if (fs.existsSync(root)) {
          // 简单写入测试：尝试在根目录创建临时目录
          const candidate = path.join(root, 'ModCrafting-Data', 'runtime')
          try {
            fs.mkdirSync(path.dirname(candidate), { recursive: true })
            // 清理空目录，让首次启动引导时再创建
            try { fs.rmdirSync(path.join(root, 'ModCrafting-Data', 'runtime'), { recursive: true }) } catch { /* ignore */ }
            try { fs.rmdirSync(path.join(root, 'ModCrafting-Data')) } catch { /* ignore */ }
            return candidate
          } catch {
            // 该盘不可写，继续尝试下一个
          }
        }
      }
    }
  } catch { /* ignore */ }
  // 回退到默认 C 盘位置
  const localAppData = process.env.LOCALAPPDATA || path.dirname(app.getPath('userData'))
  return path.join(localAppData, 'ModCrafting', 'runtime')
}
