/**
 * Yarn tiny v2 descriptor remapping: official (obfuscated) → named (Yarn) readable Java types.
 * Tiny header: `tiny 2 0 official intermediary named`
 * Class lines: `c\t<official>\t<intermediary>\t<named>`
 * Method/field descriptor columns reference types in the official namespace.
 */

import * as fs from 'fs'

const PRIMITIVES: Record<string, string> = {
  B: 'byte',
  C: 'char',
  D: 'double',
  F: 'float',
  I: 'int',
  J: 'long',
  S: 'short',
  Z: 'boolean',
  V: 'void'
}

/** `net/minecraft/client/toast/SystemToast$Type` → `SystemToast.Type` */
export function namedSimpleName(namedPath: string): string {
  const simple = namedPath.split('/').pop() || namedPath
  return simple.replace(/\$/g, '.')
}

/** Unmapped type (JDK / missing): strip path separators into Java-style name. */
function fallbackTypeName(official: string): string {
  return official.replace(/\//g, '.').replace(/\$/g, '.')
}

/**
 * Build official → named-simple-name map from tiny v2 class (`c`) lines.
 */
export function buildOfficialToNamedMap(yarnLines: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of yarnLines) {
    if (!line.startsWith('c\t')) continue
    const parts = line.split('\t')
    // c \t official \t intermediary \t named
    const official = parts[1]
    const named = parts[parts.length - 1]
    if (official && named) {
      map.set(official, namedSimpleName(named))
    }
  }
  return map
}

function remapTypeAt(
  desc: string,
  i: number,
  classMap: Map<string, string>
): { type: string; next: number } {
  let arrayDepth = 0
  while (desc[i] === '[') {
    arrayDepth++
    i++
  }
  const c = desc[i]
  if (!c) return { type: '?', next: i }

  if (PRIMITIVES[c]) {
    return { type: PRIMITIVES[c] + '[]'.repeat(arrayDepth), next: i + 1 }
  }

  if (c === 'L') {
    const end = desc.indexOf(';', i)
    if (end < 0) {
      return { type: desc.slice(i) + '[]'.repeat(arrayDepth), next: desc.length }
    }
    const official = desc.slice(i + 1, end)
    const named = classMap.get(official) || fallbackTypeName(official)
    return { type: named + '[]'.repeat(arrayDepth), next: end + 1 }
  }

  // Unknown token — consume one char
  return { type: c + '[]'.repeat(arrayDepth), next: i + 1 }
}

/**
 * Remap a JVM field type (`Lflk;`) or method descriptor (`(Lflk;Lwp;)V`)
 * into a readable Java signature.
 *
 * Field: `MinecraftClient`
 * Method: `(MinecraftClient, Text) -> void`
 */
export function remapDescriptor(desc: string, classMap: Map<string, string>): string {
  if (!desc) return ''

  if (desc.startsWith('(')) {
    const close = desc.indexOf(')')
    if (close < 0) return desc
    const paramsDesc = desc.slice(1, close)
    const retDesc = desc.slice(close + 1)
    const params: string[] = []
    let i = 0
    while (i < paramsDesc.length) {
      const { type, next } = remapTypeAt(paramsDesc, i, classMap)
      params.push(type)
      i = next
    }
    const { type: ret } = remapTypeAt(retDesc, 0, classMap)
    return `(${params.join(', ')}) -> ${ret}`
  }

  const { type } = remapTypeAt(desc, 0, classMap)
  return type
}

export function formatYarnField(
  namedName: string,
  desc: string,
  classMap: Map<string, string>
): string {
  return `  字段: ${namedName} : ${remapDescriptor(desc, classMap)}`
}

/**
 * Split remapped param list on commas that are not inside nested generics
 * (we don't emit generics, so plain split is fine).
 */
function splitParamTypes(paramsStr: string): string[] {
  if (!paramsStr.trim()) return []
  return paramsStr.split(', ').filter(Boolean)
}

/**
 * Format a method line. With paramNames: `create(client: MinecraftClient, ...) -> SystemToast`
 * Without: `create(MinecraftClient, ...) -> SystemToast`
 */
export function formatYarnMethod(
  namedName: string,
  desc: string,
  classMap: Map<string, string>,
  paramNames?: Array<string | undefined>
): string {
  const remapped = remapDescriptor(desc, classMap)
  if (!remapped.startsWith('(')) {
    return `  方法: ${namedName} ${remapped}`
  }

  const arrow = remapped.indexOf(') -> ')
  if (arrow < 0) {
    return `  方法: ${namedName}${remapped}`
  }

  const paramsStr = remapped.slice(1, arrow)
  const ret = remapped.slice(arrow + 5)
  const types = splitParamTypes(paramsStr)

  if (paramNames && paramNames.length > 0) {
    const labeled = types.map((t, i) => {
      const name = paramNames[i]
      return name ? `${name}: ${t}` : t
    })
    return `  方法: ${namedName}(${labeled.join(', ')}) -> ${ret}`
  }

  return `  方法: ${namedName}(${types.join(', ')}) -> ${ret}`
}

/**
 * Parse trailing `p` (parameter name) rows after a method row in tiny v2.
 * Param rows are double-indented: `["", "", "p", index, ..., name]`.
 * Returns names indexed by parameter slot, and the next line index to continue from.
 */
export function collectParamNames(
  yarnLines: string[],
  afterMethodLine: number
): { names: Array<string | undefined>; nextLine: number } {
  const names: Array<string | undefined> = []
  let j = afterMethodLine
  while (j < yarnLines.length) {
    const parts = yarnLines[j].split('\t')
    if (parts[0] === 'c') break
    // Tiny v2 nests params under methods with two leading empty columns.
    const kindIndex = parts.findIndex((p, i) => i < 3 && (p === 'p' || p === 'm' || p === 'f'))
    if (kindIndex < 0 || parts[kindIndex] !== 'p') break
    const idx = Number(parts[kindIndex + 1])
    const pname = parts[parts.length - 1] || ''
    if (!Number.isNaN(idx) && pname && pname !== 'p') {
      names[idx] = pname
    }
    j++
  }
  return { names, nextLine: j }
}

// ── File-backed cache (mtime invalidation) ──────────────────────────

let cachedMap: Map<string, string> | null = null
let cachedMtime = 0
let cachedPath = ''

/** Clear the in-memory class map cache (for tests). */
export function clearYarnClassMapCache(): void {
  cachedMap = null
  cachedMtime = 0
  cachedPath = ''
}

/**
 * Load (and cache) official→named map from a yarn-mappings.tiny file.
 */
export function getYarnOfficialToNamedMap(yarnPath: string): Map<string, string> {
  try {
    const stat = fs.statSync(yarnPath)
    if (cachedMap && cachedPath === yarnPath && cachedMtime === stat.mtimeMs) {
      return cachedMap
    }
    const lines = fs.readFileSync(yarnPath, 'utf-8').split('\n')
    cachedMap = buildOfficialToNamedMap(lines)
    cachedMtime = stat.mtimeMs
    cachedPath = yarnPath
    return cachedMap
  } catch {
    return new Map()
  }
}
