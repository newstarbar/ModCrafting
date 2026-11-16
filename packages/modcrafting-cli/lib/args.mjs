/** Argument parsing, help text and the exit-code contract. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXIT = { OK: 0, USAGE: 1, HOST: 2, CONFIG: 3, BUNDLE: 4, UNSUPPORTED: 5 }

export class CliError extends Error {
  constructor(message, { code = 'ERROR', exitCode = EXIT.USAGE, details } = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

export const COMMANDS = ['install', 'mcp', 'skills', 'doctor', 'update', 'uninstall', 'versions', 'version']

const BOOLEAN = new Set(['auto', 'all-detected', 'dry-run', 'json', 'no-network', 'project', 'force', 'delegate', 'print-snippet', 'remove', 'help', 'quiet', 'offline', 'create-dirs', 'yes'])
const REPEATABLE = new Set(['host'])
const VALUE = new Set(['host', 'from-zip', 'bundle-dir', 'node', 'data-root', 'config-path', 'bundle-version', 'profile', 'timeout'])

const ALIASES = { h: 'help', v: 'version', y: 'yes' }

export function parseArgs(argv) {
  const options = { hosts: [], flags: new Set(), values: new Map(), positionals: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      options.positionals.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      options.positionals.push(token)
      continue
    }
    const trimmed = token.replace(/^--?/, '')
    const [rawKey, inline] = trimmed.split('=')
    const key = ALIASES[rawKey] ?? rawKey
    if (key === 'version' && inline === undefined && !VALUE.has(key)) {
      options.flags.add('cli-version')
      continue
    }
    if (BOOLEAN.has(key) || key.startsWith('no-')) {
      const name = key.startsWith('no-') ? key.slice(3) : key
      const value = key.startsWith('no-') ? false : inline === undefined ? true : !/^(false|0|no)$/i.test(inline)
      if (value) options.flags.add(name)
      else options.flags.delete(name)
      options.values.set(name, value)
      continue
    }
    if (VALUE.has(key)) {
      const value = inline ?? argv[index + 1]
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new CliError(`参数 --${key} 需要一个值`, { code: 'USAGE' })
      }
      if (inline === undefined) index += 1
      if (REPEATABLE.has(key)) {
        if (key === 'host') options.hosts.push(...String(value).split(',').map((item) => item.trim()).filter(Boolean))
        else options.values.set(key, [...(options.values.get(key) ?? []), value])
      } else {
        options.values.set(key, value)
      }
      continue
    }
    throw new CliError(`未知参数：${token}（运行 modcrafting help 查看用法）`, { code: 'USAGE' })
  }
  options.fromZip = options.values.get('from-zip')
  options.bundleDir = options.values.get('bundle-dir')
  options.bundleVersion = options.values.get('bundle-version')
  return options
}

export function exitFor(error) {
  if (error instanceof CliError) return error.exitCode
  switch (error?.code) {
    case 'CONFIG_INVALID':
    case 'CONFIG_CONFLICT':
      return EXIT.CONFIG
    case 'BUNDLE_INVALID':
    case 'NETWORK':
      return EXIT.BUNDLE
    case 'UNSUPPORTED_HOST':
      return EXIT.UNSUPPORTED
    default:
      return EXIT.USAGE
  }
}

export function cliVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [path.join(here, '..', '..', '..', 'package.json'), path.join(here, '..', 'package.json')]) {
    try {
      const data = JSON.parse(readFileSync(candidate, 'utf8'))
      if (data.name === 'modcrafting' && data.version) return data.version
    } catch { /* keep looking */ }
  }
  return '0.0.0'
}

export const HELP = `ModCrafting Fabric 安装器

用法：
  modcrafting install [--host <id>|--auto|--all-detected] [选项]
  modcrafting mcp     [--host <id>] [--remove]
  modcrafting skills  [--host <id>] [--remove] [--project]
  modcrafting doctor  [--host <id>] [--json]
  modcrafting update  [--bundle-version <v>]
  modcrafting uninstall [--host <id>|--all-detected]
  modcrafting versions
  modcrafting verify [<bundle 目录>]
  modcrafting help

宿主（--host）：codex claude cursor devin devin-desktop opencode pi zcode dsh
                qoder trae workbuddy codebuddy copilot kimi generic

获取 bundle：
  --from-zip <file>        从本地 ZIP 安装（离线包/QQ 群包）
  --bundle-dir <dir>       使用已解包的 bundle 目录（含 bundle.json）
  --bundle-version <v>     指定版本（默认最新 Release 或已缓存的最新版）
  --no-network             不联网；必须配合 --from-zip 或 --bundle-dir

写入控制：
  --dry-run                只打印将要做的改动，不写任何文件
  --json                   机器可读输出（给 Agent 用）
  --force                  覆盖非本工具写入的同名配置条目
  --print-snippet          只输出配置片段，不写宿主配置
  --delegate               优先调用宿主自带 CLI（claude/codex/copilot/kimi/dsh）
  --config-path <file>     generic 宿主的配置文件路径
  --node <path>            覆盖写入配置的 node 可执行文件
  --data-root <abs>        覆盖 MODCRAFTING_DATA（默认 ~/.modcrafting/data/<host>）
  --project                技能装到当前项目的项目级目录

退出码：0 成功｜1 用法错误｜2 宿主歧义或未检测到｜3 配置冲突｜4 下载或校验失败｜5 宿主不支持
`
