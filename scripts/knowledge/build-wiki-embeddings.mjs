#!/usr/bin/env node
/**
 * 用 Xenova/all-MiniLM-L6-v2 计算百科 MD 切片的 embeddings，输出预计算索引。
 * 输出：
 *   - resources/mc-wiki-zh-index/embeddings.bin (Float32Array 二进制)
 *   - resources/mc-wiki-zh-index/chunks.json (元数据)
 *   - resources/mc-wiki-zh-index/manifest.json
 *
 * 用法：node scripts/knowledge/build-wiki-embeddings.mjs
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
const DIMENSION = 384
const MAX_CHUNK_CHARS = 500
const MIN_CHUNK_CHARS = 50
const BATCH_SIZE = 16

function readWikiFiles () {
  const wikiRoot = path.join(ROOT, 'resources', 'mc-wiki-zh')
  if (!fs.existsSync(wikiRoot)) {
    console.warn(`[warn] 百科目录不存在: ${wikiRoot}`)
    return []
  }
  const files = []
  const categories = fs.readdirSync(wikiRoot).filter((d) => fs.statSync(path.join(wikiRoot, d)).isDirectory())
  for (const category of categories) {
    const catDir = path.join(wikiRoot, category)
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith('.md')) continue
      files.push({ category, file, path: path.join(catDir, file) })
    }
  }
  return files
}

function parseFrontmatter (content) {
  const fm = {}
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!m) return { frontmatter: fm, body: content }
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+?)\s*$/)
    if (kv) {
      let val = kv[2]
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
      fm[kv[1]] = val
    }
  }
  return { frontmatter: fm, body: m[2] }
}

function chunkMarkdown (body) {
  // 按 H2/H3 标题切片
  const lines = body.split('\n')
  const chunks = []
  let currentHeading = ''
  let currentBuffer = []

  const flushBuffer = () => {
    const text = currentBuffer.join('\n').trim()
    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({ heading: currentHeading, text })
    }
    currentBuffer = []
  }

  for (const line of lines) {
    const h = line.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (h) {
      flushBuffer()
      currentHeading = h[2].trim()
      currentBuffer.push(line)
    } else {
      currentBuffer.push(line)
      const len = currentBuffer.join('\n').length
      if (len >= MAX_CHUNK_CHARS) flushBuffer()
    }
  }
  flushBuffer()

  // 若没有任何切片，使用整篇正文的前 MAX_CHUNK_CHARS 字符
  if (chunks.length === 0) {
    const text = body.slice(0, MAX_CHUNK_CHARS).trim()
    if (text.length >= MIN_CHUNK_CHARS) chunks.push({ heading: '概览', text })
  }
  return chunks
}

async function loadPipeline () {
  // 动态 import 避免在未安装时崩溃
  let transformers
  try {
    transformers = await import('@xenova/transformers')
  } catch (err) {
    console.error(`[fatal] 未安装 @xenova/transformers，请运行: npm i -D @xenova/transformers`)
    process.exit(2)
  }
  const { pipeline } = transformers
  console.log(`加载模型 ${MODEL_ID} ...`)
  const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true })
  console.log('模型加载完成')
  return extractor
}

async function embedBatch (extractor, texts) {
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  // output.data 是 Float32Array，长度 = texts.length * DIMENSION
  const data = output.data instanceof Float32Array ? output.data : new Float32Array(output.data)
  return data
}

async function main () {
  const outDir = path.join(ROOT, 'resources', 'mc-wiki-zh-index')
  fs.mkdirSync(outDir, { recursive: true })

  const files = readWikiFiles()
  if (files.length === 0) {
    console.error('[fatal] 未找到百科 MD 文件，请先运行 npm run knowledge:fetch-wiki')
    process.exit(1)
  }
  console.log(`待索引百科文件: ${files.length} 篇`)

  // 切片
  const chunks = []
  for (const file of files) {
    const content = fs.readFileSync(file.path, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(content)
    const slices = chunkMarkdown(body)
    for (let i = 0; i < slices.length; i++) {
      const slice = slices[i]
      chunks.push({
        id: chunks.length,
        title: frontmatter.title || path.basename(file.file, '.md'),
        category: frontmatter.category || file.category,
        standardId: frontmatter.standard_id || undefined,
        heading: slice.heading,
        text: slice.text,
        sourceFile: `${file.category}/${file.file}`
      })
    }
  }
  console.log(`切片总数: ${chunks.length}`)

  if (chunks.length === 0) {
    console.error('[fatal] 无有效切片')
    process.exit(1)
  }

  // 加载模型
  const extractor = await loadPipeline()

  // 批量计算 embeddings
  console.log(`计算 embeddings (batch=${BATCH_SIZE}) ...`)
  const allEmbeddings = new Float32Array(chunks.length * DIMENSION)
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE)
    const texts = batch.map((c) => `${c.title} ${c.heading} ${c.text}`.slice(0, 1024))
    const emb = await embedBatch(extractor, texts)
    allEmbeddings.set(emb, i * DIMENSION)
    process.stdout.write(`\r  ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`)
  }
  console.log('')

  // 写入二进制 embeddings (Int8 量化)
  // 文件布局: [scaleFactors (Float32 × N)] [int8Data (Int8 × N × D)]
  // 反量化: float32[i * D + j] = int8Data[i * D + j] * scaleFactors[i]
  const int8Data = new Int8Array(chunks.length * DIMENSION)
  const scaleFactors = new Float32Array(chunks.length)
  for (let i = 0; i < chunks.length; i++) {
    let maxAbs = 0
    const base = i * DIMENSION
    for (let j = 0; j < DIMENSION; j++) {
      maxAbs = Math.max(maxAbs, Math.abs(allEmbeddings[base + j]))
    }
    const scale = maxAbs > 0 ? maxAbs / 127 : 1
    scaleFactors[i] = scale
    for (let j = 0; j < DIMENSION; j++) {
      int8Data[base + j] = Math.round(allEmbeddings[base + j] / scale)
    }
  }
  const binPath = path.join(outDir, 'embeddings.bin')
  const buf = Buffer.concat([
    Buffer.from(scaleFactors.buffer),
    Buffer.from(int8Data.buffer)
  ])
  fs.writeFileSync(binPath, buf)
  console.log(`embeddings 已写入: ${path.relative(ROOT, binPath)} (${buf.length} bytes, int8 量化)`)

  // 写入元数据（不包含 embedding）
  const metaChunks = chunks.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    standardId: c.standardId,
    heading: c.heading,
    text: c.text,
    sourceFile: c.sourceFile
  }))
  const jsonPath = path.join(outDir, 'chunks.json')
  fs.writeFileSync(jsonPath, JSON.stringify(metaChunks, null, 2), 'utf-8')
  console.log(`chunks 元数据已写入: ${path.relative(ROOT, jsonPath)}`)

  // 写入 manifest
  const manifest = {
    model: MODEL_ID,
    dimension: DIMENSION,
    quantization: 'int8',
    chunkCount: chunks.length,
    builtAt: new Date().toISOString(),
    files: [
      { name: 'embeddings.bin', type: 'int8-quantized-binary', size: buf.length },
      { name: 'chunks.json', type: 'metadata-json' }
    ]
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  console.log(`\n[done] 索引构建完成: ${chunks.length} 切片 × ${DIMENSION} 维`)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
