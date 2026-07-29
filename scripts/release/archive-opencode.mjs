#!/usr/bin/env node
/**
 * 把 node_modules/opencode-ai/bin/opencode.exe 打成 tar.xz 压缩包，
 * 输出到 resources/extra-zips/opencode-windows-x64.tar.xz，供上传到
 * GitHub/Gitee Release。
 *
 * 瘦包三期：opencode.exe（约 184MB 未压缩）从 Setup.exe 移除，改为用户
 * 首启从应用自身 Release（与 jre/seed 同 tag）下载 tar.xz 解压到
 * runtime/opencode/opencode.exe。
 *
 * 产物：resources/extra-zips/opencode-windows-x64.tar.xz
 *   - tar 内顶层即 opencode.exe（无目录包裹）
 *   - 解压方：opencode-downloader.ts 的 extractTarXz() 用 `tar -xJf -C destDir`
 *
 * 运行：node scripts/release/archive-opencode.mjs
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const SOURCE_EXE = path.join(ROOT, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
const OUTPUT_DIR = path.join(ROOT, 'resources', 'extra-zips')
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'opencode-windows-x64.tar.xz')

function main() {
  if (!existsSync(SOURCE_EXE)) {
    console.error(`[archive-opencode] 源文件不存在: ${SOURCE_EXE}`)
    console.error('[archive-opencode] 请先运行 npm ci 安装 opencode-ai 依赖')
    process.exit(1)
  }

  const srcSize = statSync(SOURCE_EXE).size
  console.log(`[archive-opencode] 源文件: ${SOURCE_EXE}`)
  console.log(`[archive-opencode] 源大小: ${(srcSize / 1024 / 1024).toFixed(1)} MB`)

  // 准备输出目录
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
  }
  // 清理旧产物
  if (existsSync(OUTPUT_FILE)) {
    rmSync(OUTPUT_FILE, { force: true })
  }

  console.log('[archive-opencode] 正在压缩为 tar.xz（xz 压缩，可能需要一两分钟）…')
  // tar -acf archive.tar.xz -C <dirname> <basename>
  // 这样 tar 内顶层即 basename（opencode.exe），无目录包裹
  const result = spawnSync(
    'tar',
    ['-acf', OUTPUT_FILE, '-C', path.dirname(SOURCE_EXE), path.basename(SOURCE_EXE)],
    { stdio: 'inherit', shell: false }
  )
  if (result.status !== 0) {
    console.error(`[archive-opencode] tar 失败，退出码 ${result.status ?? 'unknown'}`)
    process.exit(1)
  }

  const outSize = statSync(OUTPUT_FILE).size
  const ratio = ((1 - outSize / srcSize) * 100).toFixed(1)
  console.log(`[archive-opencode] ✓ 产物: ${OUTPUT_FILE}`)
  console.log(`[archive-opencode] ✓ 压缩后: ${(outSize / 1024 / 1024).toFixed(1)} MB（压缩率 ${ratio}%）`)

  if (outSize > 100 * 1024 * 1024) {
    console.warn(`[archive-opencode] ⚠ 警告：产物超过 100MB（Gitee 单文件限制），可能需要改为分片`)
  }
}

main()
