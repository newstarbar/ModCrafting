#!/usr/bin/env node
/**
 * 缓存 Xenova/all-MiniLM-L6-v2 onnx 模型到 resources/mc-wiki-model/，
 * 运行时从本地加载（不联网）。
 *
 * 用法：node scripts/knowledge/cache-transformer-model.mjs
 *
 * 依赖：npm i -D @xenova/transformers
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..', '..')

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

async function main () {
  let env
  try {
    ;({ env } = await import('@xenova/transformers'))
  } catch (err) {
    console.error('[fatal] 未安装 @xenova/transformers，请运行: npm i -D @xenova/transformers')
    process.exit(2)
  }

  const cacheDir = path.join(ROOT, 'resources', 'mc-wiki-model')
  fs.mkdirSync(cacheDir, { recursive: true })

  // 临时把 TransformersJS 缓存目录指向我们的目标
  process.env.TRANSFORMERS_CACHE = cacheDir
  env.cacheDir = cacheDir

  console.log(`缓存模型 ${MODEL_ID} 到 ${path.relative(ROOT, cacheDir)}`)

  // 触发模型下载（pipeline 会自动缓存到 cacheDir）
  const { pipeline } = await import('@xenova/transformers')
  console.log('下载 onnx 权重（首次约 22MB）...')
  const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true })

  // 测试推理一次确认模型可用
  const test = await extractor(['hello world'], { pooling: 'mean', normalize: true })
  const dim = test.data.length
  console.log(`模型推理测试通过：维度 = ${dim}`)

  // 列出缓存文件
  const files = listFilesRecursive(cacheDir)
  console.log(`\n缓存文件清单（${files.length} 个）：`)
  for (const f of files.slice(0, 20)) {
    console.log(`  ${path.relative(cacheDir, f)} (${fs.statSync(f).size} bytes)`)
  }
  if (files.length > 20) console.log(`  ... 还有 ${files.length - 20} 个文件`)

  // 写入 manifest
  const manifest = {
    model: MODEL_ID,
    cachedAt: new Date().toISOString(),
    cacheDir: 'resources/mc-wiki-model/',
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + fs.statSync(f).size, 0),
    dimension: dim
  }
  fs.writeFileSync(path.join(cacheDir, '.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`\n[done] 模型已缓存，manifest: ${path.relative(ROOT, path.join(cacheDir, '.manifest.json'))}`)
}

function listFilesRecursive (dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full))
    else if (!entry.name.startsWith('.')) out.push(full)
  }
  return out
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
