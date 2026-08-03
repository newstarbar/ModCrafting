#!/usr/bin/env node
/**
 * 把当前 runtime 目录打包为 zip 压缩包，用于离线分发环境配置。
 *
 * 用法：
 *   node scripts/toolchain/export-runtime-zip.mjs [输出路径]
 *
 * 默认输出到桌面 ModCrafting-runtime-env.zip。
 * 依赖 Windows 10+ 自带的 tar.exe（支持 zip 格式）。
 */
import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')

// runtime 目录位置：项目根目录下的 runtime/（dev 模式）
// 或 %LOCALAPPDATA%\ModCrafting\runtime\（安装版）
function resolveRuntimeRoot() {
  const devRuntime = path.join(projectRoot, 'runtime')
  if (fs.existsSync(devRuntime)) return devRuntime
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const installed = path.join(localAppData, 'ModCrafting', 'runtime')
    if (fs.existsSync(installed)) return installed
  }
  return null
}

// 需要排除的条目（日志、临时目录、迁移暂存）
const EXCLUDE_PATTERNS = [
  /^logs?[/\\]/i,
  /^_prefetch_project_[^/\\]+[/\\]?/i,
  /\.migration-\d+[/\\]?$/,
  /^\.modcrafting-probe-/i,
  /^caches[/\\]mk-[\w-]+[/\\]daemon$/i, // Gradle daemon 注册表（导入后会自动重建）
]

function shouldExclude(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  return EXCLUDE_PATTERNS.some((p) => p.test(normalized))
}

function getDirSize(dir) {
  let total = 0
  let count = 0
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        count++
        try { total += fs.statSync(full).size } catch { /* ignore */ }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return { totalBytes: total, fileCount: count }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

async function main() {
  const runtimeRoot = resolveRuntimeRoot()
  if (!runtimeRoot) {
    console.error('未找到 runtime 目录。请先运行 npm run dev 初始化环境，或指定路径。')
    process.exit(1)
  }

  const outputPath = process.argv[2] ||
    path.join(process.env.USERPROFILE || projectRoot, 'Desktop', 'ModCrafting-runtime-env.zip')

  console.log(`runtime 目录：${runtimeRoot}`)
  const { totalBytes, fileCount } = getDirSize(runtimeRoot)
  console.log(`总大小：${formatBytes(totalBytes)}（${fileCount} 个文件）`)

  // 检查 tar.exe 是否可用
  const tarCheck = spawnSync('tar', ['--version'], { encoding: 'utf-8', shell: true })
  if (tarCheck.error || tarCheck.status !== 0) {
    console.error('tar.exe 不可用。请确保使用 Windows 10+ 或已安装 tar。')
    process.exit(1)
  }

  // 确保输出目录存在
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // 删除已存在的输出文件
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath)
    console.log(`已删除旧的压缩包：${outputPath}`)
  }

  // 创建排除列表文件（tar --exclude-from）
  const excludeFile = path.join(require('os').tmpdir(), `modcrafting-exclude-${Date.now()}.txt`)
  const excludeLines = [
    'logs',
    'log',
    '_prefetch_project_*',
    '*.migration-*',
    '.modcrafting-probe-*',
    'caches/mk-*/daemon',
  ]
  fs.writeFileSync(excludeFile, excludeLines.join('\n'), 'utf-8')

  console.log(`正在压缩为 zip（使用 tar.exe）…`)
  console.log(`输出路径：${outputPath}`)

  // 使用 tar.exe 创建 zip 压缩包
  // tar -a -cf output.zip --exclude-from=exclude.txt -C runtimeRoot .
  const result = spawnSync('tar', [
    '-a', '-cf', outputPath,
    '--exclude-from', excludeFile,
    '-C', runtimeRoot,
    '.'
  ], {
    stdio: 'inherit',
    shell: true
  })

  // 清理临时文件
  try { fs.unlinkSync(excludeFile) } catch { /* ignore */ }

  if (result.error || result.status !== 0) {
    console.error('压缩失败：', result.error || `tar 退出码 ${result.status}`)
    process.exit(1)
  }

  const outputSize = fs.statSync(outputPath).size
  const ratio = ((1 - outputSize / totalBytes) * 100).toFixed(1)
  console.log('')
  console.log('压缩完成！')
  console.log(`  原始大小：${formatBytes(totalBytes)}`)
  console.log(`  压缩包大小：${formatBytes(outputSize)}`)
  console.log(`  压缩率：${ratio}%`)
  console.log(`  输出路径：${outputPath}`)
  console.log('')
  console.log('可将此压缩包上传到 QQ 群文件，供网络较慢的用户手动导入。')
  console.log('导入方式：在 ModCrafting 环境初始化界面选择「手动导入环境包」。')
}

main().catch((err) => {
  console.error('执行失败：', err)
  process.exit(1)
})
