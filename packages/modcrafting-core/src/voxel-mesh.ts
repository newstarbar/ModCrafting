// Pure greedy mesher shared by the Node compiler and the browser editor. No Node APIs here.
export type CuboidFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'
export interface VoxelRect { axis: 'x' | 'y' | 'z'; dir: 1 | -1; slice: number; u0: number; v0: number; u1: number; v1: number; value: number }
export interface VoxelCuboid { from: [number, number, number]; to: [number, number, number]; face: CuboidFace; value: number }

export function meshVoxel(grid: Uint8Array, size: readonly [number, number, number], merge: boolean): { rects: VoxelRect[]; exposedFaces: number } {
  const [sx, sy, sz] = size
  const at = (x: number, y: number, z: number) => x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : grid[(y * sz + z) * sx + x]
  const planes = [
    { axis: 'y' as const, slices: sy, uSize: sx, vSize: sz, cell: (slice: number, u: number, v: number) => [u, slice, v] as const, neighbor: (slice: number, u: number, v: number, d: number) => [u, slice + d, v] as const },
    { axis: 'x' as const, slices: sx, uSize: sy, vSize: sz, cell: (slice: number, u: number, v: number) => [slice, u, v] as const, neighbor: (slice: number, u: number, v: number, d: number) => [slice + d, u, v] as const },
    { axis: 'z' as const, slices: sz, uSize: sx, vSize: sy, cell: (slice: number, u: number, v: number) => [u, v, slice] as const, neighbor: (slice: number, u: number, v: number, d: number) => [u, v, slice + d] as const }
  ]
  const rects: VoxelRect[] = []
  let exposedFaces = 0
  for (const plane of planes) {
    for (const dir of [1, -1] as const) {
      for (let slice = 0; slice < plane.slices; slice += 1) {
        const mask = new Int32Array(plane.uSize * plane.vSize)
        for (let v = 0; v < plane.vSize; v += 1) {
          for (let u = 0; u < plane.uSize; u += 1) {
            const [x, y, z] = plane.cell(slice, u, v)
            const value = at(x, y, z)
            const [nx, ny, nz] = plane.neighbor(slice, u, v, dir)
            if (value && !at(nx, ny, nz)) { mask[v * plane.uSize + u] = value; exposedFaces += 1 }
          }
        }
        const used = new Uint8Array(mask.length)
        for (let v = 0; v < plane.vSize; v += 1) {
          for (let u = 0; u < plane.uSize; u += 1) {
            const position = v * plane.uSize + u
            const value = mask[position]
            if (!value || used[position]) continue
            let width = 1
            if (merge) while (u + width < plane.uSize && mask[position + width] === value && !used[position + width]) width += 1
            let height = 1
            if (merge) {
              grow: while (v + height < plane.vSize) {
                for (let step = 0; step < width; step += 1) {
                  const probe = (v + height) * plane.uSize + u + step
                  if (mask[probe] !== value || used[probe]) break grow
                }
                height += 1
              }
            }
            for (let dv = 0; dv < height; dv += 1) for (let du = 0; du < width; du += 1) used[(v + dv) * plane.uSize + u + du] = 1
            rects.push({ axis: plane.axis, dir, slice, u0: u, v0: v, u1: u + width - 1, v1: v + height - 1, value })
          }
        }
      }
    }
  }
  return { rects, exposedFaces }
}

const round4 = (value: number) => Math.round(value * 10000) / 10000

export function rectToCuboid(rect: VoxelRect, unit: number): VoxelCuboid {
  const bounds = (start: number, end: number): [number, number] => [round4(start * unit), round4((end + 1) * unit)]
  if (rect.axis === 'y') {
    const [x0, x1] = bounds(rect.u0, rect.u1), [z0, z1] = bounds(rect.v0, rect.v1), [y0, y1] = bounds(rect.slice, rect.slice)
    return { from: [x0, y0, z0], to: [x1, y1, z1], face: rect.dir === 1 ? 'up' : 'down', value: rect.value }
  }
  if (rect.axis === 'x') {
    const [y0, y1] = bounds(rect.u0, rect.u1), [z0, z1] = bounds(rect.v0, rect.v1), [x0, x1] = bounds(rect.slice, rect.slice)
    return { from: [x0, y0, z0], to: [x1, y1, z1], face: rect.dir === 1 ? 'east' : 'west', value: rect.value }
  }
  const [x0, x1] = bounds(rect.u0, rect.u1), [y0, y1] = bounds(rect.v0, rect.v1), [z0, z1] = bounds(rect.slice, rect.slice)
  return { from: [x0, y0, z0], to: [x1, y1, z1], face: rect.dir === 1 ? 'south' : 'north', value: rect.value }
}
