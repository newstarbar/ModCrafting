import { z } from 'zod'

// Pure voxel model DSL shared by the Node compiler and the browser editor. No Node APIs here.
export const voxelLimits = {
  maxAxis: 32,
  maxVoxels: 32768,
  maxPalette: 26,
  maxLayers: 32,
  maxOps: 64,
  maxBytes: 65536,
  maxCuboids: 4000,
  defaultCuboids: 1500,
  resolution: 16
} as const

export type VoxelIssue = { path: string; message: string; expected?: string }

const hexColor = z.string().regex(/^#[0-9a-f]{6}$/, '颜色需要 #rrggbb 十六进制格式')
const paletteEntry = z.union([
  hexColor,
  z.object({
    color: hexColor,
    pattern: z.enum(['flat', 'noise', 'checker']).default('flat'),
    top: hexColor.optional(),
    side: hexColor.optional(),
    bottom: hexColor.optional()
  }).strict()
])
// Arrays with .length(3) instead of z.tuple: the project typechecks without strictNullChecks,
// under which zod tuple inference degrades to optional-element tuples.
const triple = z.array(z.number().int().min(0).max(voxelLimits.maxAxis - 1)).length(3)
const sizeTriple = z.array(z.number().int().min(1).max(voxelLimits.maxAxis)).length(3)

export const voxelDslSchema = z.object({
  version: z.literal(1),
  size: sizeTriple,
  palette: z.record(z.string().regex(/^[a-z]$/, '调色板符号必须是小写字母'), paletteEntry),
  layers: z.array(z.string().max(voxelLimits.maxAxis * voxelLimits.maxAxis * 5)).max(voxelLimits.maxLayers).optional(),
  ops: z.array(z.object({
    op: z.literal('box'),
    p: z.string().regex(/^[a-z]$/, 'box 的 p 必须是调色板符号'),
    from: triple,
    to: triple,
    hollow: z.boolean().optional(),
    mirror: z.enum(['x', 'z', 'xz']).optional()
  }).strict()).max(voxelLimits.maxOps).optional(),
  texture: z.object({ mode: z.enum(['shaded', 'material']), resolution: z.literal(voxelLimits.resolution) }).strict(),
  optimize: z.object({
    merge: z.boolean().default(true),
    quantize: z.number().int().min(0).max(8).default(0),
    downscale: z.union([z.literal(1), z.literal(2)]).default(1),
    removeFloating: z.boolean().default(false),
    maxCuboids: z.number().int().min(1).max(voxelLimits.maxCuboids).default(voxelLimits.defaultCuboids)
  }).strict().prefault({})
}).strict().superRefine((value, context) => {
  if (value.size[0] * value.size[1] * value.size[2] > voxelLimits.maxVoxels) {
    context.addIssue({ code: 'custom', path: ['size'], message: `体素总数 ${value.size[0] * value.size[1] * value.size[2]} 超过上限 ${voxelLimits.maxVoxels}` })
  }
  const symbols = Object.keys(value.palette)
  if (symbols.length < 1) context.addIssue({ code: 'custom', path: ['palette'], message: '调色板至少需要 1 个符号' })
  if (symbols.length > voxelLimits.maxPalette) context.addIssue({ code: 'custom', path: ['palette'], message: `调色板最多 ${voxelLimits.maxPalette} 个符号` })
  const [sx, sy, sz] = value.size
  const cells = sx * sz
  if (value.layers !== undefined) {
    if (value.layers.length !== sy) {
      context.addIssue({ code: 'custom', path: ['layers'], message: `layers 需要 ${sy} 层（与 size 的 Y 轴一致），当前 ${value.layers.length}`, expected: `${sy} layers` })
    }
    value.layers.forEach((layer, index) => {
      if (layer === '-') return
      const tokens = parseRle(layer)
      if (!tokens) {
        context.addIssue({ code: 'custom', path: ['layers', index], message: 'RLE 语法无效：每段是 可选数字 + 单个字母或点；数字为 1～9999 且不能为 0', expected: '例如 "3a2.b" 或 "-"' })
        return
      }
      const total = tokens.reduce((sum, token) => sum + token.count, 0)
      if (total !== cells) {
        context.addIssue({ code: 'custom', path: ['layers', index], message: `本层展开 ${total} 格，应为 ${cells} 格（x*z）`, expected: `${cells} cells` })
      }
      for (const token of tokens) {
        if (token.symbol !== '.' && !value.palette[token.symbol]) {
          context.addIssue({ code: 'custom', path: ['layers', index], message: `符号 ${token.symbol} 不在调色板中`, expected: symbols.join(' ') + ' 或 .' })
          break
        }
      }
    })
  }
  ;(value.ops ?? []).forEach((op, index) => {
    ;([['from', op.from], ['to', op.to]] as const).forEach(([field, point]) => {
      point.forEach((part, axis) => {
        const axisLimit = [sx, sy, sz][axis] - 1
        if (part > axisLimit) {
          context.addIssue({ code: 'custom', path: ['ops', index, field, axis], message: `坐标超出第 ${axis} 轴上限 ${axisLimit}`, expected: `0..${axisLimit}` })
        }
      })
    })
    if (op.from.some((part, axis) => part > op.to[axis])) {
      context.addIssue({ code: 'custom', path: ['ops', index], message: 'from 必须逐轴小于等于 to', expected: 'from <= to' })
    }
    if (!value.palette[op.p]) {
      context.addIssue({ code: 'custom', path: ['ops', index, 'p'], message: `符号 ${op.p} 不在调色板中`, expected: symbols.join(' ') })
    }
  })
  const hasContent = (value.layers ?? []).some(layer => layer !== '-') || (value.ops ?? []).length > 0
  if (!hasContent) context.addIssue({ code: 'custom', path: ['ops'], message: '模型为空：layers 与 ops 至少需要一个非空' })
})
export type VoxelDsl = z.infer<typeof voxelDslSchema>
export type VoxelPaletteEntry = Exclude<z.infer<typeof paletteEntry>, string> & { color: string }

export function parseRle(layer: string): Array<{ count: number; symbol: string }> | null {
  const tokens: Array<{ count: number; symbol: string }> = []
  let position = 0
  while (position < layer.length) {
    let digits = ''
    while (position < layer.length && layer[position] >= '0' && layer[position] <= '9' && digits.length < 4) { digits += layer[position]; position += 1 }
    if (position >= layer.length || !/[a-z.]/.test(layer[position])) return null
    const count = digits ? Number(digits) : 1
    if (!Number.isInteger(count) || count < 1) return null
    tokens.push({ count, symbol: layer[position] })
    position += 1
  }
  return tokens
}

export function encodeRle(cells: Array<string>): string {
  if (!cells.length) return '-'
  let output = '', runSymbol = cells[0], runLength = 0
  const flush = () => { if (runLength) output += (runLength > 1 ? String(runLength) : '') + runSymbol }
  for (const symbol of cells) {
    if (symbol === runSymbol) runLength += 1
    else { flush(); runSymbol = symbol; runLength = 1 }
  }
  flush()
  return output
}

export function paletteSymbols(dsl: VoxelDsl): string[] {
  return Object.keys(dsl.palette).sort()
}

// Value 0 = empty; 1..N = palette index of paletteSymbols(dsl).
export function evaluateVoxel(dsl: VoxelDsl): { grid: Uint8Array; symbols: string[] } {
  const [sx, sy, sz] = dsl.size
  const symbols = paletteSymbols(dsl)
  const indexOf = new Map(symbols.map((symbol, position) => [symbol, position + 1]))
  const grid = new Uint8Array(sx * sy * sz)
  const cell = (x: number, y: number, z: number) => (y * sz + z) * sx + x
  if (dsl.layers) {
    for (let y = 0; y < Math.min(dsl.layers.length, sy); y += 1) {
      const layer = dsl.layers[y]
      if (layer === '-') continue
      let cursor = 0
      for (const token of parseRle(layer)!) {
        for (let step = 0; step < token.count; step += 1) {
          const x = cursor % sx, z = Math.floor(cursor / sx)
          if (token.symbol !== '.') grid[cell(x, y, z)] = indexOf.get(token.symbol)!
          cursor += 1
        }
      }
    }
  }
  const applyBox = (from: number[], to: number[], value: number, hollow?: boolean) => {
    for (let x = from[0]; x <= to[0]; x += 1)
      for (let y = from[1]; y <= to[1]; y += 1)
        for (let z = from[2]; z <= to[2]; z += 1) {
          if (hollow && x > from[0] && x < to[0] && y > from[1] && y < to[1] && z > from[2] && z < to[2]) continue
          grid[cell(x, y, z)] = value
        }
  }
  for (const op of dsl.ops ?? []) {
    const value = indexOf.get(op.p)!
    const mirrors: Array<'x' | 'z'> = op.mirror === 'xz' ? ['x', 'z'] : op.mirror ? [op.mirror] : []
    const variants: Array<Array<'x' | 'z'>> = [[], ...mirrors.map(axis => [axis] as Array<'x' | 'z'>), ...(mirrors.length === 2 ? [['x', 'z'] as Array<'x' | 'z'>] : [])]
    for (const mirror of variants) {
      const map = (point: number[]): number[] => [
        mirror.includes('x') ? sx - 1 - point[0] : point[0],
        point[1],
        mirror.includes('z') ? sz - 1 - point[2] : point[2]
      ]
      const from = map(op.from), to = map(op.to)
      applyBox(
        [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])],
        [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])],
        value, op.hollow
      )
    }
  }
  return { grid, symbols }
}

export function voxelAsciiViews(grid: Uint8Array, size: readonly number[], symbols: string[]): { top: string[]; front: string[]; side: string[] } {
  const [sx, sy, sz] = size
  const at = (x: number, y: number, z: number) => {
    const value = grid[(y * sz + z) * sx + x]
    return value ? symbols[value - 1] : '.'
  }
  const top: string[] = [], front: string[] = [], side: string[] = []
  for (let z = 0; z < sz; z += 1) {
    let row = ''
    for (let x = 0; x < sx; x += 1) {
      let found = '.'
      for (let y = sy - 1; y >= 0; y -= 1) if (at(x, y, z) !== '.') { found = at(x, y, z); break }
      row += found
    }
    top.push(row)
  }
  for (let y = sy - 1; y >= 0; y -= 1) {
    let row = ''
    for (let x = 0; x < sx; x += 1) {
      let found = '.'
      for (let z = sz - 1; z >= 0; z -= 1) if (at(x, y, z) !== '.') { found = at(x, y, z); break }
      row += found
    }
    front.push(row)
  }
  for (let y = sy - 1; y >= 0; y -= 1) {
    let row = ''
    for (let z = 0; z < sz; z += 1) {
      let found = '.'
      for (let x = sx - 1; x >= 0; x -= 1) if (at(x, y, z) !== '.') { found = at(x, y, z); break }
      row += found
    }
    side.push(row)
  }
  return { top, front, side }
}

export function validateVoxel(raw: unknown): { ok: true; value: VoxelDsl; errors?: undefined } | { ok: false; value?: undefined; errors: VoxelIssue[] } {
  const parsed = voxelDslSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(issue => ({ path: issue.path.map(part => String(part)).join('.'), message: issue.message }))
    }
  }
  const bytes = JSON.stringify(raw)?.length ?? 0
  if (bytes > voxelLimits.maxBytes) {
    return { ok: false, errors: [{ path: '', message: `DSL 序列化 ${bytes} 字节，超过上限 ${voxelLimits.maxBytes}；请合并图层或简化形状`, expected: `<= ${voxelLimits.maxBytes} bytes` }] }
  }
  return { ok: true, value: parsed.data }
}

export function formatVoxelIssues(errors: VoxelIssue[]): string {
  return errors.slice(0, 6).map(issue => `${issue.path || 'dsl'}: ${issue.message}`).join('；') + (errors.length > 6 ? `（共 ${errors.length} 条）` : '')
}
