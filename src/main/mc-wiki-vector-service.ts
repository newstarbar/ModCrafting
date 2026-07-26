import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 中文 MC 百科向量检索服务。
 * 加载预计算的 embeddings（Float32Array 二进制）+ chunks 元数据，
 * 运行时用 transformers.js 计算查询向量并执行余弦相似度检索。
 */

export interface McWikiSearchResult {
  title: string
  category: string
  standardId?: string
  heading?: string
  snippet: string
  score: number
  sourceFile?: string
}

interface ChunkMeta {
  id: number
  title: string
  category: string
  standardId?: string
  heading?: string
  text: string
  sourceFile?: string
}

interface IndexManifest {
  model: string
  dimension: number
  chunkCount: number
  builtAt: string
}

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const EXPECTED_DIMENSION = 384

let embeddings: Float32Array | null = null
let chunks: ChunkMeta[] = []
let manifest: IndexManifest | null = null
let extractor: ((texts: string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null
let initPromise: Promise<void> | null = null
let initFailed = false
let initError: string | null = null

function bundledWikiIndexRoot (): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mc-wiki-zh-index')
  }
  return path.join(app.getAppPath(), 'resources', 'mc-wiki-zh-index')
}

function bundledModelRoot (): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mc-wiki-model')
  }
  return path.join(app.getAppPath(), 'resources', 'mc-wiki-model')
}

function loadIndexFiles (): { ok: boolean; error?: string } {
  const root = bundledWikiIndexRoot()
  const manifestPath = path.join(root, 'manifest.json')
  const binPath = path.join(root, 'embeddings.bin')
  const chunksPath = path.join(root, 'chunks.json')

  if (!fs.existsSync(manifestPath) || !fs.existsSync(binPath) || !fs.existsSync(chunksPath)) {
    return { ok: false, error: `百科向量索引缺失：${root}（请运行 npm run knowledge:build-wiki-embeddings）` }
  }

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as IndexManifest
    chunks = JSON.parse(fs.readFileSync(chunksPath, 'utf-8')) as ChunkMeta[]

    const buf = fs.readFileSync(binPath)
    const floatBuf = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

    if (floatBuf.length !== chunks.length * manifest.dimension) {
      return { ok: false, error: `索引维度不匹配：expected ${chunks.length * manifest.dimension}, got ${floatBuf.length}` }
    }
    embeddings = floatBuf
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `加载索引失败: ${String(err)}` }
  }
}

async function loadExtractor (): Promise<void> {
  // 设置 transformers.js 模型缓存目录为打包内的 mc-wiki-model/
  const modelRoot = bundledModelRoot()
  if (fs.existsSync(modelRoot)) {
    process.env.TRANSFORMERS_CACHE = modelRoot
  }

  let transformersModule: typeof import('@xenova/transformers')
  try {
    // 动态 import 避免在未安装时崩溃
    transformersModule = await import('@xenova/transformers')
  } catch (err) {
    throw new Error(`未安装 @xenova/transformers，无法加载向量模型: ${String(err)}`)
  }

  const { pipeline, env } = transformersModule
  // 指向本地模型缓存
  env.cacheDir = modelRoot

  const pipe = await pipeline('feature-extraction', MODEL_ID, { quantized: true })
  extractor = pipe as unknown as (texts: string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array }>
}

export async function initWikiVectorService (): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const loadResult = loadIndexFiles()
      if (!loadResult.ok) {
        initFailed = true
        initError = loadResult.error || 'unknown error'
        console.warn(`[mc-wiki-vector] 索引加载失败：${initError}`)
        return
      }
      await loadExtractor()
      console.log(`[mc-wiki-vector] 服务就绪：${chunks.length} 切片 × ${manifest?.dimension} 维`)
    } catch (err) {
      initFailed = true
      initError = String(err)
      console.warn(`[mc-wiki-vector] 初始化失败：${initError}`)
    }
  })()
  return initPromise
}

function cosineSimilarity (a: Float32Array, aOffset: number, b: Float32Array, dim: number): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < dim; i++) {
    const av = a[aOffset + i]
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

export async function searchMcWiki (query: string, topK = 5): Promise<McWikiSearchResult[]> {
  if (initFailed) {
    console.warn(`[mc-wiki-vector] 服务不可用：${initError}`)
    return []
  }
  if (!extractor || !embeddings || chunks.length === 0) {
    await initWikiVectorService()
    if (!extractor || !embeddings || chunks.length === 0) return []
  }

  const dim = manifest?.dimension || EXPECTED_DIMENSION
  const queryText = query.trim().slice(0, 1024)
  if (!queryText) return []

  let queryVec: Float32Array
  try {
    const output = await extractor!([queryText], { pooling: 'mean', normalize: true })
    queryVec = output.data instanceof Float32Array ? output.data : new Float32Array(output.data)
  } catch (err) {
    console.warn(`[mc-wiki-vector] 查询向量计算失败: ${String(err)}`)
    return []
  }

  if (queryVec.length !== dim) {
    console.warn(`[mc-wiki-vector] 查询向量维度 ${queryVec.length} != 索引维度 ${dim}`)
    return []
  }

  const scores: Array<{ idx: number; score: number }> = []
  for (let i = 0; i < chunks.length; i++) {
    const score = cosineSimilarity(embeddings!, i * dim, queryVec, dim)
    scores.push({ idx: i, score })
  }
  scores.sort((a, b) => b.score - a.score)

  const top = scores.slice(0, Math.max(1, Math.min(topK, scores.length)))
  return top.map(({ idx, score }) => {
    const chunk = chunks[idx]
    return {
      title: chunk.title,
      category: chunk.category,
      standardId: chunk.standardId,
      heading: chunk.heading,
      snippet: chunk.text.slice(0, 600),
      score,
      sourceFile: chunk.sourceFile
    }
  })
}

export function getWikiIndexInfo (): { ready: boolean; chunkCount: number; dimension: number; model: string; error?: string } {
  return {
    ready: !initFailed && Boolean(extractor && embeddings),
    chunkCount: chunks.length,
    dimension: manifest?.dimension || EXPECTED_DIMENSION,
    model: MODEL_ID,
    error: initFailed ? initError || undefined : undefined
  }
}
