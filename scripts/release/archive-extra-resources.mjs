#!/usr/bin/env node
/**
 * 把 agent-knowledge / fabric-symbol-index / _base_mods 三类辅助资源
 * 分别打成 zip，输出到 resources/extra-zips/，供上传到 GitHub/Gitee Release。
 *
 * 瘦包二期：这些资源从 Setup.exe 的 extraResources 移除，改为用户首启
 * 从应用自身 Release（与 jre/seed 同 tag）下载 zip 解压到 runtime/knowledge/。
 *
 * 产物清单：
 *   resources/extra-zips/agent-knowledge.zip        ← resources/agent-knowledge/ 下的 .md 文件
 *   resources/extra-zips/fabric-symbol-index.zip    ← resources/fabric-symbol-index-1.21.4.json.gz
 *   resources/extra-zips/base-mods.zip              ← resources/_base_mods/ 下的 .jar 文件
 *
 * 运行：node scripts/release/archive-extra-resources.mjs
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const RESOURCES_DIR = path.join(ROOT, 'resources')
const OUTPUT_DIR = path.join(RESOURCES_DIR, 'extra-zips')

// 产物映射：(zip 文件名, 源目录/文件, zip 内根目录名)
// - agent-knowledge：源目录打包，zip 内顶层保留 agent-knowledge/...
// - fabric-symbol-index：源是单个 .json.gz，zip 内顶层目录 fabric-symbol-index/ 含该 .json.gz
// - base-mods：源目录打包，zip 内顶层目录 _base_mods/...
const TARGETS = [
  {
    zip: 'agent-knowledge.zip',
    sourceDir: path.join(RESOURCES_DIR, 'agent-knowledge'),
    internalDir: 'agent-knowledge',
    filter: '**/*.md'
  },
  {
    zip: 'fabric-symbol-index.zip',
    sourceDir: null, // 单文件，特殊处理
    sourceFile: path.join(RESOURCES_DIR, 'fabric-symbol-index-1.21.4.json.gz'),
    internalDir: 'fabric-symbol-index'
  },
  {
    zip: 'base-mods.zip',
    sourceDir: path.join(RESOURCES_DIR, '_base_mods'),
    internalDir: '_base_mods',
    filter: '**/*.jar'
  }
]

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`PowerShell exit ${code}: ${stderr}`))
    })
  })
}

async function makeZipFromDir({ zip, sourceDir, internalDir, filter }) {
  if (!existsSync(sourceDir)) {
    console.warn(`[archive-extra] skip ${zip}: source ${sourceDir} 不存在`)
    return false
  }
  const zipPath = path.join(OUTPUT_DIR, zip)
  if (existsSync(zipPath)) rmSync(zipPath, { force: true })

  // 用 Compress-Archive 打包整个目录到 zip（zip 内顶层即 internalDir/...）
  // PowerShell 7+ 支持 -Path 指定通配，但 Compress-Archive 默认会保留目录结构
  // 我们在临时目录里建一个 internalDir 子目录，复制内容进去后打包，确保 zip 内顶层是 internalDir/
  const staging = path.join(OUTPUT_DIR, `.staging-${internalDir}`)
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  mkdirSync(path.join(staging, internalDir), { recursive: true })

  // 复制源目录内容到 staging/internalDir/
  await runPowerShell([
    `Copy-Item -Path '${sourceDir}\\*' -Destination '${path.join(staging, internalDir)}' -Recurse -Force`
  ])

  // 打包
  await runPowerShell([
    `Compress-Archive -Path '${path.join(staging, internalDir)}' -DestinationPath '${zipPath}' -Force`
  ])

  // 清理 staging
  rmSync(staging, { recursive: true, force: true })

  const size = statSync(zipPath).size
  console.log(`[archive-extra] ✓ ${zip} (${(size / 1024 / 1024).toFixed(2)} MB)`)
  return true
}

async function makeZipFromSingleFile({ zip, sourceFile, internalDir }) {
  if (!existsSync(sourceFile)) {
    console.warn(`[archive-extra] skip ${zip}: source ${sourceFile} 不存在`)
    return false
  }
  const zipPath = path.join(OUTPUT_DIR, zip)
  if (existsSync(zipPath)) rmSync(zipPath, { force: true })

  // 临时目录里建 internalDir/ 子目录，放 .json.gz 文件
  const staging = path.join(OUTPUT_DIR, `.staging-${internalDir}`)
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  mkdirSync(path.join(staging, internalDir), { recursive: true })

  const fileName = path.basename(sourceFile)
  await runPowerShell([
    `Copy-Item -Path '${sourceFile}' -Destination '${path.join(staging, internalDir, fileName)}' -Force`
  ])

  await runPowerShell([
    `Compress-Archive -Path '${path.join(staging, internalDir)}' -DestinationPath '${zipPath}' -Force`
  ])

  rmSync(staging, { recursive: true, force: true })

  const size = statSync(zipPath).size
  console.log(`[archive-extra] ✓ ${zip} (${(size / 1024 / 1024).toFixed(2)} MB)`)
  return true
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('[archive-extra] 当前脚本仅支持 Windows（依赖 PowerShell Compress-Archive）')
    process.exit(1)
  }

  if (existsSync(OUTPUT_DIR)) {
    rmSync(OUTPUT_DIR, { recursive: true, force: true })
  }
  mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log(`[archive-extra] 输出目录: ${OUTPUT_DIR}`)
  console.log('')

  let okCount = 0
  for (const target of TARGETS) {
    const ok = target.sourceDir
      ? await makeZipFromDir(target)
      : await makeZipFromSingleFile(target)
    if (ok) okCount++
  }

  console.log('')
  console.log(`[archive-extra] 完成 ${okCount}/${TARGETS.length} 个 zip`)
  if (okCount === 0) {
    console.error('[archive-extra] 没有生成任何 zip，请检查 resources/ 下源文件是否存在')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[archive-extra] fatal:', err.message || err)
  process.exit(1)
})
