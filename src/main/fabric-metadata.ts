import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { gunzipSync } from 'zlib'
import { loadFabricVersions } from './build-env'

export type FabricSide = 'common' | 'client'

export interface FabricMemberRecord {
  name: string
  descriptor: string
  static: boolean
}

export interface FabricClassRecord {
  name: string
  side: FabricSide
  fields: FabricMemberRecord[]
  methods: FabricMemberRecord[]
}

export interface FabricSymbolLookupRequest {
  className: string
  memberName?: string
  descriptor?: string
  memberKind?: 'method' | 'field' | 'any'
}

export interface FabricSymbolLookupResult {
  ok: boolean
  version: string
  yarnMappings: string
  class?: FabricClassRecord
  methods: FabricMemberRecord[]
  fields: FabricMemberRecord[]
  suggestions: string[]
  ambiguous?: boolean
  error?: string
}

interface FabricSymbolIndex {
  format: number
  minecraftVersion: string
  yarnMappings: string
  classes: FabricClassRecord[]
}

let cachedIndex: FabricSymbolIndex | null = null

function indexSearchPaths(): string[] {
  const version = loadFabricVersions().minecraft_version
  const file = `fabric-symbol-index-${version}.json.gz`
  return [
    path.join(process.resourcesPath || '', file),
    path.join(app.getAppPath(), 'resources', file),
    path.join(__dirname, '..', 'resources', file),
    path.join(__dirname, '..', '..', 'resources', file)
  ]
}

export function loadFabricSymbolIndex(): FabricSymbolIndex {
  if (cachedIndex) return cachedIndex
  const expected = loadFabricVersions()
  const indexPath = indexSearchPaths().find((candidate) => fs.existsSync(candidate))
  if (!indexPath) throw new Error(`Fabric symbol index ${expected.minecraft_version} is missing`)
  const parsed = JSON.parse(gunzipSync(fs.readFileSync(indexPath)).toString('utf8')) as FabricSymbolIndex
  if (
    parsed.format !== 1 ||
    parsed.minecraftVersion !== expected.minecraft_version ||
    parsed.yarnMappings !== expected.yarn_mappings ||
    !Array.isArray(parsed.classes) ||
    parsed.classes.length < 1000
  ) {
    throw new Error('Fabric symbol index version or content is invalid')
  }
  cachedIndex = parsed
  return parsed
}

function normalizeClassName(value: string): string {
  return value.trim().replaceAll('/', '.').replace(/\.class$/, '')
}

function classSuggestions(classes: FabricClassRecord[], requested: string): string[] {
  const needle = requested.toLowerCase().split('.').pop() || requested.toLowerCase()
  return classes
    .filter((entry) => {
      const simple = entry.name.toLowerCase().split('.').pop() || entry.name.toLowerCase()
      return simple.includes(needle) || needle.includes(simple)
    })
    .slice(0, 8)
    .map((entry) => entry.name)
}

export function lookupFabricSymbol(request: FabricSymbolLookupRequest): FabricSymbolLookupResult {
  const index = loadFabricSymbolIndex()
  const requestedClass = normalizeClassName(request.className || '')
  if (!requestedClass) {
    return {
      ok: false,
      version: index.minecraftVersion,
      yarnMappings: index.yarnMappings,
      methods: [],
      fields: [],
      suggestions: [],
      error: 'className is required'
    }
  }

  const exact = index.classes.filter((entry) =>
    entry.name === requestedClass || entry.name.endsWith(`.${requestedClass}`))
  if (exact.length !== 1) {
    return {
      ok: false,
      version: index.minecraftVersion,
      yarnMappings: index.yarnMappings,
      methods: [],
      fields: [],
      suggestions: exact.length > 1 ? exact.map((entry) => entry.name) : classSuggestions(index.classes, requestedClass),
      ambiguous: exact.length > 1,
      error: exact.length > 1 ? 'className is ambiguous; use a fully-qualified Yarn class name' : 'Yarn class not found'
    }
  }

  const classRecord = exact[0]
  const memberName = request.memberName?.trim()
  const descriptor = request.descriptor?.trim()
  const kind = request.memberKind || 'any'
  const methods = kind === 'field' ? [] : classRecord.methods.filter((entry) =>
    (!memberName || entry.name === memberName) && (!descriptor || entry.descriptor === descriptor))
  const fields = kind === 'method' ? [] : classRecord.fields.filter((entry) =>
    (!memberName || entry.name === memberName) && (!descriptor || entry.descriptor === descriptor))
  const candidates = [...methods, ...fields]
  const ambiguous = Boolean(memberName && !descriptor && candidates.length > 1)
  const missing = Boolean(memberName && candidates.length === 0)

  return {
    ok: !ambiguous && !missing,
    version: index.minecraftVersion,
    yarnMappings: index.yarnMappings,
    class: classRecord,
    methods,
    fields,
    suggestions: missing
      ? [...classRecord.methods, ...classRecord.fields]
          .filter((entry) => entry.name.toLowerCase().includes(memberName!.toLowerCase()))
          .slice(0, 8)
          .map((entry) => `${entry.name}${entry.descriptor}`)
      : [],
    ambiguous,
    error: ambiguous
      ? 'member is overloaded; descriptor is required'
      : missing
        ? 'member or descriptor not found on target Yarn class'
        : undefined
  }
}

export function verifyFabricSymbolIndex(): { ok: boolean; error?: string; classes?: number } {
  try {
    const index = loadFabricSymbolIndex()
    return { ok: true, classes: index.classes.length }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
