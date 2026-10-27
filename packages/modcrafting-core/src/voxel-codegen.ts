import { CoreError } from './runtime.ts'
import type { GeneratedAsset, GeneratedFile } from './template-codegen.ts'
import { evaluateVoxel, formatVoxelIssues, validateVoxel, voxelLimits, type VoxelDsl } from './voxel-dsl.ts'
import { meshVoxel, rectToCuboid, type VoxelRect } from './voxel-mesh.ts'
import { buildAtlas, renderTile, resolvePalette, tileFor, tileRectUvMc, type AtlasResult, type ResolvedPalette } from './voxel-atlas.ts'
import { encodePng } from './voxel-png.ts'
import type { ContentObject } from './content-model.ts'

export interface VoxelStats {
  voxels: number
  solid: number
  exposedFaces: number
  cuboids: number
  triangles: number
  atlas: string
  modelBytes: number
  compileMs: number
  paletteSymbols: number
}

export interface VoxelAnalysis {
  grid: Uint8Array
  size: [number, number, number]
  symbols: string[]
  entries: ResolvedPalette[]
  rects: VoxelRect[]
  exposedFaces: number
  atlas: AtlasResult
  stats: VoxelStats
  warnings: string[]
}

const fail = (code: string, message: string): never => { throw new CoreError(code, message) }
const usageOf = (grid: Uint8Array): number[] => {
  const usage = new Array<number>(27).fill(0)
  for (const value of grid) usage[value] += 1
  return usage
}

export function analyzeVoxel(dsl: VoxelDsl): VoxelAnalysis {
  const started = Date.now()
  const warnings: string[] = []
  const { grid: evaluated, symbols } = evaluateVoxel(dsl)
  const [sx, sy, sz] = dsl.size
  let grid = evaluated, size: [number, number, number] = [sx, sy, sz]
  const solid = grid.reduce((sum, value) => sum + (value ? 1 : 0), 0)
  if (!solid) fail('VOXEL_EMPTY', '模型没有任何体素；请添加 layers 或 ops')

  let entries = resolvePalette(dsl.palette)
  if (dsl.optimize.quantize > 0 && symbols.length > dsl.optimize.quantize) {
    const usage = usageOf(grid)
    const kept = symbols.map((symbol, index) => ({ symbol, index: index + 1, usage: usage[index + 1] }))
      .sort((a, b) => b.usage - a.usage || a.symbol.localeCompare(b.symbol))
      .slice(0, dsl.optimize.quantize)
    const colorOf = (value: number) => entries[value - 1].color
    const remap = new Map<number, number>()
    for (const symbol of symbols) {
      const value = symbols.indexOf(symbol) + 1
      if (kept.some(candidate => candidate.index === value)) { remap.set(value, value); continue }
      let best = kept[0], bestDistance = Infinity
      for (const candidate of kept) {
        const a = colorOf(value), b = colorOf(candidate.index)
        const distance = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
        if (distance < bestDistance) { bestDistance = distance; best = candidate }
      }
      remap.set(value, best.index)
    }
    for (let index = 0; index < grid.length; index += 1) grid[index] = remap.get(grid[index]) ?? 0
    warnings.push(`调色板从 ${symbols.length} 色压缩到 ${kept.length} 色`)
  }

  if (dsl.optimize.downscale === 2) {
    if (size[0] % 2 || size[1] % 2 || size[2] % 2) {
      warnings.push('downscale=2 需要 size 各轴为偶数，已跳过降采样')
    } else {
      const next: [number, number, number] = [size[0] / 2, size[1] / 2, size[2] / 2]
      const reduced = new Uint8Array(next[0] * next[1] * next[2])
      for (let y = 0; y < next[1]; y += 1)
        for (let z = 0; z < next[2]; z += 1)
          for (let x = 0; x < next[0]; x += 1) {
            const counts = new Map<number, number>()
            for (let dy = 0; dy < 2; dy += 1)
              for (let dz = 0; dz < 2; dz += 1)
                for (let dx = 0; dx < 2; dx += 1) {
                  const value = grid[((y * 2 + dy) * size[2] + z * 2 + dz) * size[0] + x * 2 + dx]
                  if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
                }
            let best = 0, bestCount = 0
            for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
              if (count > bestCount) { best = value; bestCount = count }
            }
            reduced[(y * next[2] + z) * next[0] + x] = best
          }
      grid = reduced; size = next
      warnings.push(`模型降采样至 ${next[0]}x${next[1]}x${next[2]}`)
    }
  }

  if (dsl.optimize.removeFloating) {
    const labels = new Int32Array(grid.length)
    const sizes: number[] = []
    const neighbors = (index: number): number[] => {
      const x = index % size[0], z = Math.floor(index / size[0]) % size[2], y = Math.floor(index / (size[0] * size[2]))
      const list: number[] = []
      if (x > 0) list.push(index - 1)
      if (x < size[0] - 1) list.push(index + 1)
      if (z > 0) list.push(index - size[0])
      if (z < size[2] - 1) list.push(index + size[0])
      if (y > 0) list.push(index - size[0] * size[2])
      if (y < size[1] - 1) list.push(index + size[0] * size[2])
      return list
    }
    for (let start = 0; start < grid.length; start += 1) {
      if (!grid[start] || labels[start]) continue
      const label = sizes.length + 1
      let count = 0
      const stack = [start]
      labels[start] = label
      while (stack.length) {
        const index = stack.pop()!
        count += 1
        for (const next of neighbors(index)) {
          if (grid[next] && !labels[next]) { labels[next] = label; stack.push(next) }
        }
      }
      sizes.push(count)
    }
    if (sizes.length > 1) {
      const keep = sizes.indexOf(Math.max(...sizes)) + 1
      let removed = 0
      for (let index = 0; index < grid.length; index += 1) {
        if (grid[index] && labels[index] !== keep) { grid[index] = 0; removed += 1 }
      }
      warnings.push(`移除悬浮体素 ${removed} 个`)
    }
  }

  const usedSymbols = new Set<number>()
  for (const value of grid) if (value) usedSymbols.add(value)
  const atlasEntries = entries.filter((_, index) => usedSymbols.has(index + 1))
  for (const [index, symbol] of symbols.entries()) {
    if (!usedSymbols.has(index + 1)) warnings.push(`调色板符号 ${symbol} 未被使用`)
  }
  const atlas = buildAtlas(atlasEntries, dsl.texture.mode, voxelLimits.resolution)
  const { rects, exposedFaces } = meshVoxel(grid, size, dsl.optimize.merge)
  if (rects.length > dsl.optimize.maxCuboids) {
    fail('VOXEL_TOO_COMPLEX', `模型需要 ${rects.length} 个 cuboid，超过上限 ${dsl.optimize.maxCuboids}；建议开启 merge、降低 quantize、downscale=2 或提高 maxCuboids（硬上限 ${voxelLimits.maxCuboids}）`)
  }
  const finalSolid = grid.reduce((sum, value) => sum + (value ? 1 : 0), 0)
  return {
    grid, size, symbols, entries, rects, exposedFaces, atlas,
    stats: {
      voxels: size[0] * size[1] * size[2],
      solid: finalSolid,
      exposedFaces,
      cuboids: rects.length,
      triangles: rects.length * 2,
      atlas: `${atlas.width}x${atlas.height}`,
      modelBytes: 0,
      compileMs: Date.now() - started,
      paletteSymbols: atlasEntries.length
    },
    warnings
  }
}

const itemDisplay = {
  gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] },
  ground: { translation: [0, 3, 0], scale: [0.25, 0.25, 0.25] },
  fixed: { rotation: [0, 180, 0], scale: [0.5, 0.5, 0.5] },
  thirdperson_righthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
  thirdperson_lefthand: { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [0.375, 0.375, 0.375] },
  firstperson_righthand: { rotation: [0, 45, 0], scale: [0.4, 0.4, 0.4] },
  firstperson_lefthand: { rotation: [0, 225, 0], scale: [0.4, 0.4, 0.4] }
}
const variantOf = (face: string) => face === 'up' ? 'top' as const : face === 'down' ? 'bottom' as const : 'side' as const

export function compileVoxel(value: ContentObject): { models: GeneratedFile[]; assets: GeneratedAsset[]; previewPng: Buffer; stats: VoxelStats; warnings: string[] } {
  if (!value.voxel) fail('VOXEL_DSL_MISSING', '内容对象没有体素模型')
  const check = validateVoxel(value.voxel)
  if (!check.ok) fail('VOXEL_DSL_INVALID', '体素 DSL 校验失败：' + formatVoxelIssues(check.errors))
  const analysis = analyzeVoxel(check.value)
  const [modId, name] = value.id.split(':')
  const isBlock = value.kind === 'block'
  const kindDir = isBlock ? 'block' : 'item'
  const atlasId = `${modId}:${kindDir}/${name}_atlas`
  const unit = 16 / Math.max(...analysis.size)
  const elements = analysis.rects.map(rect => {
    const cuboid = rectToCuboid(rect, unit)
    const symbol = analysis.symbols[cuboid.value - 1]
    const tile = tileFor(analysis.atlas.tiles, symbol, variantOf(cuboid.face))
    return {
      from: cuboid.from,
      to: cuboid.to,
      faces: { [cuboid.face]: { uv: tileRectUvMc(tile, analysis.atlas.width, analysis.atlas.height), texture: '#0' } }
    }
  })
  const model = isBlock
    ? { parent: 'block/block', textures: { '0': atlasId, particle: `${modId}:block/${name}_particle` }, elements }
    : { textures: { '0': atlasId }, display: itemDisplay, elements }
  const modelPath = `src/main/resources/assets/${modId}/models/${kindDir}/${name}.json`
  const modelContent = JSON.stringify(model, null, 2) + '\n'
  const atlasPng = encodePng(analysis.atlas.width, analysis.atlas.height, analysis.atlas.pixels)
  const assets: GeneratedAsset[] = [{ path: `src/main/resources/assets/${modId}/textures/${kindDir}/${name}_atlas.png`, content: atlasPng }]
  if (isBlock) {
    const usage = usageOf(analysis.grid)
    let dominant = 1
    for (let candidate = 2; candidate <= analysis.symbols.length; candidate += 1) {
      if ((usage[candidate] ?? 0) > (usage[dominant] ?? 0)) dominant = candidate
    }
    const dominantEntry = analysis.entries[dominant - 1]
    if (dominantEntry) {
      const particleTile = renderTile(dominantEntry, 'side', voxelLimits.resolution)
      assets.push({ path: `src/main/resources/assets/${modId}/textures/block/${name}_particle.png`, content: encodePng(voxelLimits.resolution, voxelLimits.resolution, particleTile) })
    }
  }
  const stats: VoxelStats = { ...analysis.stats, modelBytes: Buffer.byteLength(modelContent) }
  return { models: [{ path: modelPath, content: modelContent }], assets, previewPng: atlasPng, stats, warnings: analysis.warnings }
}
