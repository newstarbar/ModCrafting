import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = join(__dirname, '..', '..')

/**
 * 轻量 .env 加载器(不引入 dotenv 依赖)。
 * 解析项目根目录的 .env 文件,注入到 process.env。
 * 已存在的环境变量不会被覆盖(系统环境变量优先)。
 *
 * @param {string} [envPath] - 自定义 .env 路径,默认为项目根目录 .env
 * @returns {Record<string, string>} 实际加载的变量(仅含从 .env 读取的)
 */
export function loadEnv(envPath) {
  const filePath = envPath || join(root, '.env')
  if (!existsSync(filePath)) {
    return {}
  }

  const text = readFileSync(filePath, 'utf-8')
  const loaded = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    // 跳过空行与注释
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim()
    if (!key) continue

    let value = line.slice(eq + 1).trim()
    // 去除包裹引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // 系统环境变量优先,不覆盖
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
    loaded[key] = process.env[key]
  }

  return loaded
}
