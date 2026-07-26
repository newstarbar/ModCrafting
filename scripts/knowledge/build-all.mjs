#!/usr/bin/env node
/**
 * 编排所有知识库构建步骤的顺序执行：
 *   1. fetch-minecraft-data
 *   2. fetch-mc-wiki-zh
 *   3. build-mc-data-index
 *   4. build-wiki-embeddings
 *   5. cache-transformer-model
 *
 * 用法：node scripts/knowledge/build-all.mjs [--skip-data] [--skip-wiki] [--skip-embeddings] [--skip-model]
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function parseArgs () {
  const flags = {
    skipData: false,
    skipWiki: false,
    skipEmbeddings: false,
    skipModel: false
  }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--skip-data') flags.skipData = true
    else if (arg === '--skip-wiki') flags.skipWiki = true
    else if (arg === '--skip-embeddings') flags.skipEmbeddings = true
    else if (arg === '--skip-model') flags.skipModel = true
  }
  return flags
}

function runStep (label, scriptName) {
  return new Promise((resolve, reject) => {
    console.log(`\n========== ${label} ==========`)
    const child = spawn(process.execPath, [path.join(__dirname, scriptName)], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..', '..')
    })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${scriptName} 退出码 ${code}`))
    })
    child.on('error', reject)
  })
}

async function main () {
  const flags = parseArgs()
  console.log('ModCrafting 知识库构建编排')
  console.log('跳过项:', Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(', ') || '无')

  if (!flags.skipData) await runStep('拉取 minecraft-data', 'fetch-minecraft-data.mjs')
  if (!flags.skipWiki) await runStep('抓取中文 MC 百科', 'fetch-mc-wiki-zh.mjs')
  if (!flags.skipData) await runStep('构建 minecraft-data 索引', 'build-mc-data-index.mjs')
  if (!flags.skipEmbeddings) await runStep('构建百科向量索引', 'build-wiki-embeddings.mjs')
  if (!flags.skipModel) await runStep('缓存 transformers 模型', 'cache-transformer-model.mjs')

  console.log('\n========== 全部完成 ==========')
  console.log('资源已生成：')
  console.log('  - resources/minecraft-data/<version>/')
  console.log('  - resources/mc-wiki-zh/')
  console.log('  - resources/mc-wiki-zh-index/')
  console.log('  - resources/mc-wiki-model/')
}

main().catch((err) => {
  console.error('\n[fatal]', err.message)
  process.exit(1)
})
