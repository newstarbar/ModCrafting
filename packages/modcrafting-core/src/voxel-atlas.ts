// Pure deterministic texture atlas shared by the Node compiler and the browser editor. No Node APIs here.
import type { VoxelDsl } from './voxel-dsl.ts'

export type RGB = [number, number, number]
export type TileVariant = 'top' | 'side' | 'bottom' | 'all'
export interface ResolvedPalette { symbol: string; color: RGB; pattern: 'flat' | 'noise' | 'checker'; top?: RGB; side?: RGB; bottom?: RGB }
export interface AtlasTile { key: string; symbol: string; variant: TileVariant; x: number; y: number }
export interface AtlasResult { width: number; height: number; pixels: Uint8Array; tiles: AtlasTile[] }

const hex = (value: string): RGB => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)]
const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

export function resolvePalette(palette: VoxelDsl['palette']): ResolvedPalette[] {
  return Object.keys(palette).sort().map(symbol => {
    const raw = palette[symbol]
    const entry = typeof raw === 'string' ? { color: raw, pattern: 'flat' as const } : raw
    return {
      symbol,
      color: hex(entry.color),
      pattern: entry.pattern,
      ...(entry.top ? { top: hex(entry.top) } : {}),
      ...(entry.side ? { side: hex(entry.side) } : {}),
      ...(entry.bottom ? { bottom: hex(entry.bottom) } : {})
    }
  })
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash || 1
}

function variantColor(entry: ResolvedPalette, variant: TileVariant): RGB {
  const shade = (color: RGB, factor: number): RGB => [clamp(color[0] * factor), clamp(color[1] * factor), clamp(color[2] * factor)]
  if (variant === 'top') return entry.top ?? shade(entry.color, 1.12)
  if (variant === 'bottom') return entry.bottom ?? shade(entry.color, 0.85)
  return entry.side ?? entry.color
}

export function renderTile(entry: ResolvedPalette, variant: TileVariant, resolution = 16): Uint8Array {
  const pixels = new Uint8Array(resolution * resolution * 4)
  const base = variantColor(entry, variant)
  let state = hashSeed(entry.symbol + '|' + variant)
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff }
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const factor = entry.pattern === 'noise' ? 0.94 + random() * 0.12 : entry.pattern === 'checker' ? (((x >> 2) + (y >> 2)) % 2 ? 0.92 : 1.06) : 1
      const offset = (y * resolution + x) * 4
      pixels[offset] = clamp(base[0] * factor)
      pixels[offset + 1] = clamp(base[1] * factor)
      pixels[offset + 2] = clamp(base[2] * factor)
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

export function buildAtlas(entries: ResolvedPalette[], mode: 'shaded' | 'material', resolution = 16): AtlasResult {
  const variants: TileVariant[] = mode === 'shaded' ? ['top', 'side', 'bottom'] : ['all']
  const keys: Array<{ symbol: string; variant: TileVariant }> = []
  for (const entry of entries) for (const variant of variants) keys.push({ symbol: entry.symbol, variant })
  const cell = resolution + 2
  const columns = Math.min(14, Math.max(1, Math.ceil(Math.sqrt(keys.length))))
  const rows = Math.max(1, Math.ceil(keys.length / columns))
  let size = 32
  while (size < Math.max(columns, rows) * cell) size *= 2
  if (size > 256) throw new Error(`ATLAS_TOO_LARGE: ${keys.length} tiles need more than a 256x256 atlas`)
  const pixels = new Uint8Array(size * size * 4)
  const tiles: AtlasTile[] = []
  keys.forEach((key, index) => {
    const entry = entries.find(candidate => candidate.symbol === key.symbol)!
    const tile = renderTile(entry, key.variant, resolution)
    const ox = (index % columns) * cell + 1, oy = Math.floor(index / columns) * cell + 1
    for (let y = -1; y <= resolution; y += 1) {
      for (let x = -1; x <= resolution; x += 1) {
        const sx = Math.max(0, Math.min(resolution - 1, x)), sy = Math.max(0, Math.min(resolution - 1, y))
        const target = ((oy + y) * size + ox + x) * 4, source = (sy * resolution + sx) * 4
        pixels[target] = tile[source]; pixels[target + 1] = tile[source + 1]; pixels[target + 2] = tile[source + 2]; pixels[target + 3] = tile[source + 3]
      }
    }
    tiles.push({ key: `${key.symbol}:${key.variant}`, symbol: key.symbol, variant: key.variant, x: ox, y: oy })
  })
  return { width: size, height: size, pixels, tiles }
}

export function tileFor(tiles: AtlasTile[], symbol: string, variant: TileVariant): AtlasTile {
  const key = variant === 'all' ? `${symbol}:all` : `${symbol}:${variant}`
  const tile = tiles.find(candidate => candidate.key === key) ?? tiles.find(candidate => candidate.key === `${symbol}:all`)
  if (!tile) throw new Error(`ATLAS_TILE_MISSING: ${key}`)
  return tile
}

// Minecraft model UV space (0..16, v=0 at texture top).
export function tileRectUvMc(tile: AtlasTile, atlasWidth: number, atlasHeight: number, resolution = 16): [number, number, number, number] {
  const round = (value: number) => Math.round(value * 10000) / 10000
  return [
    round(tile.x / atlasWidth * 16),
    round(tile.y / atlasHeight * 16),
    round((tile.x + resolution) / atlasWidth * 16),
    round((tile.y + resolution) / atlasHeight * 16)
  ]
}

// WebGL UV space for DataTexture with flipY=false: pixel row r maps to v = r / height.
export function tileRectUvGl(tile: AtlasTile, atlasWidth: number, atlasHeight: number, resolution = 16): { u0: number; u1: number; vTop: number; vBottom: number } {
  const round = (value: number) => Math.round(value * 100000) / 100000
  return {
    u0: round(tile.x / atlasWidth),
    u1: round((tile.x + resolution) / atlasWidth),
    vTop: round(tile.y / atlasHeight),
    vBottom: round((tile.y + resolution) / atlasHeight)
  }
}
