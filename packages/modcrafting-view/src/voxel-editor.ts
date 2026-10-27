import { encodeRle, evaluateVoxel, type VoxelDsl } from '../../modcrafting-core/src/voxel-dsl.ts'

export const cellAt = (size: readonly number[], x: number, y: number, z: number) => (y * size[2] + z) * size[0] + x

export function gridFromDsl(dsl: VoxelDsl): { grid: Uint8Array; symbols: string[] } {
  return evaluateVoxel(dsl)
}

export function layersFromGrid(grid: Uint8Array, size: readonly number[], symbols: string[]): string[] {
  const layers: string[] = []
  for (let y = 0; y < size[1]; y += 1) {
    const cells: string[] = []
    let empty = true
    for (let z = 0; z < size[2]; z += 1) {
      for (let x = 0; x < size[0]; x += 1) {
        const value = grid[cellAt(size, x, y, z)]
        const symbol = value ? symbols[value - 1] : '.'
        if (symbol !== '.') empty = false
        cells.push(symbol)
      }
    }
    layers.push(empty ? '-' : encodeRle(cells))
  }
  return layers
}

export function flattenVoxel(dsl: VoxelDsl, grid: Uint8Array, symbols: string[]): VoxelDsl {
  return { ...dsl, layers: layersFromGrid(grid, sizeOf(dsl), symbols), ops: [] }
}

export const sizeOf = (dsl: VoxelDsl): [number, number, number] => [dsl.size[0], dsl.size[1], dsl.size[2]]

export function expandSymmetry(size: readonly number[], x: number, z: number, symmetry: string): Array<[number, number]> {
  const points: Array<[number, number]> = [[x, z]]
  if (symmetry.includes('x')) points.push([size[0] - 1 - x, z])
  if (symmetry.includes('z')) {
    points.push([x, size[2] - 1 - z])
    if (symmetry.includes('x')) points.push([size[0] - 1 - x, size[2] - 1 - z])
  }
  const seen = new Set<string>()
  return points.filter(point => { const key = point.join(','); if (seen.has(key)) return false; seen.add(key); return true })
}

export function defaultVoxel(): VoxelDsl {
  return {
    version: 1,
    size: [16, 16, 16],
    palette: { a: { color: '#3a2a1a', pattern: 'noise' }, b: '#ffcc55', c: '#7a4b2a' },
    ops: [
      { op: 'box', p: 'c', from: [2, 0, 2], to: [13, 3, 13] },
      { op: 'box', p: 'b', from: [5, 4, 5], to: [10, 11, 10] },
      { op: 'box', p: 'a', from: [6, 12, 6], to: [9, 13, 9] }
    ],
    texture: { mode: 'shaded', resolution: 16 },
    optimize: { merge: true, quantize: 0, downscale: 1, removeFloating: false, maxCuboids: 1500 }
  }
}

export const paletteSymbolsOf = (dsl: VoxelDsl): string[] => Object.keys(dsl.palette).sort()
