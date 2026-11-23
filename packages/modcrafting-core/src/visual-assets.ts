import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FABRIC_TARGET } from './domain.ts'
import type { RuntimePaths } from './contracts.ts'
import { deriveResourceLayout } from './resources/layout.ts'
import { visualGradleHomes } from './storage.ts'
import { getRegistry } from './version/registry.ts'

const resource = /^[a-z0-9_.-]+:[a-z0-9_/-]+$/
const versionId = /^\d+\.\d+(?:\.\d+)?$/
const valid = (id: string) => resource.test(id) && id.split(/[:/]/).every(part => part && part !== '.' && part !== '..')
type ReadCache = { files: Map<string, Buffer | undefined>; checked: Set<string> }
const newCache = (): ReadCache => ({ files: new Map(), checked: new Set() })
function safe(file: string, checked?: Set<string>) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (checked?.has(current)) return file
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw Error('素材路径不能经过链接或 junction')
    checked?.add(current)
    if (path.dirname(current) === current) return file
  }
}
function bytes(file: string, cache?: ReadCache) {
  if (cache?.files.has(file)) return cache.files.get(file)
  safe(file, cache?.checked)
  if (!existsSync(file)) return undefined
  const stat = lstatSync(file)
  const data = stat.isFile() && stat.size <= 1024 * 1024 ? readFileSync(file) : undefined
  cache?.files.set(file, data); return data
}
const textureRoot = (paths: RuntimePaths) => path.join(paths.assetsRoot, 'minecraft-textures')
const cacheRoot = (paths: RuntimePaths, version: string) => path.join(textureRoot(paths), version)

function asset(paths: RuntimePaths, project: string, id: string, category: string, extension: string, cache: ReadCache | undefined, version: string) {
  if (!valid(id)) return undefined
  const [ns, name] = id.split(':')
  const relative = path.join('assets', ns, category, name + extension)
  return bytes(path.join(project, 'src/main/resources', relative), cache) ?? (ns === 'minecraft' ? bytes(path.join(cacheRoot(paths, version), relative), cache) : undefined)
}
function json(paths: RuntimePaths, project: string, id: string, category: string, cache: ReadCache | undefined, version: string): Record<string, any> | undefined {
  try { const data = asset(paths, project, id, category, '.json', cache, version); return data ? JSON.parse(data.toString('utf8')) : undefined } catch { return undefined }
}
export function textureImage(paths: RuntimePaths, project: string, id: string, cache = newCache(), version: string = FABRIC_TARGET.minecraft): string | undefined {
  const png = asset(paths, project, id, 'textures', '.png', cache, version)
  return png?.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'data:image/png;base64,' + png.toString('base64') : undefined
}
const qualify = (id: string, ns = 'minecraft') => id.includes(':') ? id : `${ns}:${id}`

/** Resolve actual model inheritance/texture variables instead of guessing item filenames. */
export function itemImage(paths: RuntimePaths, project: string, id: string, cache = newCache(), version: string = FABRIC_TARGET.minecraft): string | undefined {
  if (!valid(id)) return undefined
  const ns = id.split(':')[0]
  // Item model definitions only exist from 1.21.4; probing them on older caches is a guaranteed miss.
  const usesDefinitions = deriveResourceLayout(version, getRegistry()).itemModelDefinition === 'assets-items'
  const definition = usesDefinitions ? json(paths, project, id, 'items', cache, version)?.model : undefined
  // Use the explicit fallback or a representative frame; this is a texture preview, not a game renderer.
  let model = definition
  for (let depth = 0; model && depth < 8 && typeof model.model !== 'string'; depth++) model = model.fallback ?? model.on_false ?? model.cases?.[0]?.model ?? model.entries?.[0]?.model ?? model.base
  let modelId = typeof model === 'string' ? qualify(model) : typeof model?.model === 'string' ? qualify(model.model) : `${ns}:item/${id.split(':')[1]}`
  const textures: Record<string, string> = {}, seen = new Set<string>()
  for (let depth = 0; depth < 16 && !seen.has(modelId); depth++) {
    seen.add(modelId)
    const value = json(paths, project, modelId, 'models', cache, version); if (!value) break
    for (const [key, valueId] of Object.entries(value.textures || {})) if (typeof valueId === 'string' && !(key in textures)) textures[key] = valueId.startsWith('#') ? valueId : qualify(valueId)
    if (typeof value.parent !== 'string') break
    modelId = qualify(value.parent)
  }
  for (const key of ['layer0', 'all', 'particle', 'top', 'side', 'front', 'north', ...Object.keys(textures)]) {
    let texture = textures[key]; const refs = new Set<string>()
    while (texture?.startsWith('#') && !refs.has(texture)) { refs.add(texture); texture = textures[texture.slice(1)] }
    if (texture && !texture.startsWith('#')) { const image = textureImage(paths, project, texture, cache, version); if (image) return image }
  }
  return textureImage(paths, project, `${ns}:item/${id.split(':')[1]}`, cache, version)
}

function markerOf(root: string): { schema?: number; version?: string; archive?: string } | undefined {
  try {
    const file = path.join(root, '.visuals-ready.json')
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as { schema?: number; version?: string; archive?: string }
  } catch { return undefined }
}

/** Versions whose local client assets were fully extracted. Unmarked dirs are not trusted. */
export function availableVisualVersions(paths: RuntimePaths): string[] {
  const base = textureRoot(paths)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && versionId.test(entry.name))
    .filter((entry) => markerOf(path.join(base, entry.name))?.version === entry.name)
    .map((entry) => entry.name)
}

/**
 * Pick the assets version to render with: exact when available, otherwise the
 * nearest extracted version so the workbench still shows *something* — but the
 * caller must surface `exact:false`, because wrong-version art is misleading.
 */
export function resolveVisualVersion(paths: RuntimePaths, minecraft?: string): { version: string; exact: boolean; available: string[] } {
  const available = availableVisualVersions(paths)
  const requested = minecraft?.trim()
  if (requested && available.includes(requested)) return { version: requested, exact: true, available }
  if (!available.length) return { version: requested && versionId.test(requested) ? requested : FABRIC_TARGET.minecraft, exact: Boolean(requested && versionId.test(requested)), available }
  const registry = getRegistry()
  const rank = new Map(registry.order.map((id, index) => [id, index]))
  const target = requested ? rank.get(requested) : undefined
  const chosen = target === undefined
    ? [...available].sort((left, right) => registry.compare(right, left))[0]
    : [...available].sort((left, right) => {
      const leftRank = rank.get(left), rightRank = rank.get(right)
      const distance = (value: number | undefined) => value === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(value - target)
      return distance(leftRank) - distance(rightRank) || (leftRank ?? 0) - (rightRank ?? 0)
    })[0]
  return { version: chosen, exact: false, available }
}

const preparations = new Map<string, Promise<{ ready: boolean; message?: string }>>()
/** Use the installed Windows ZIP implementation, never download or depend on Desktop assets. */
export function prepareVisualAssets(paths: RuntimePaths, version: string = FABRIC_TARGET.minecraft): Promise<{ ready: boolean; message?: string }> {
  if (!versionId.test(version)) return Promise.resolve({ ready: false, message: `无法识别的 Minecraft 版本：${version}` })
  const root = safe(cacheRoot(paths, version)), marker = path.join(root, '.visuals-ready.json')
  // A marker from another version must not be treated as ready: it would show the wrong art.
  if (markerOf(root)?.version === version) return Promise.resolve({ ready: true })
  const existing = preparations.get(root); if (existing) return existing
  const work = (async () => {
    const candidates = [
      ...visualGradleHomes(paths.dataRoot).map(home => path.join(home, 'caches/fabric-loom', version, 'minecraft-client.jar')),
      path.join(process.env.APPDATA || os.homedir(), '.minecraft/versions', version, version + '.jar')
    ]
    const archive = candidates.find(file => { try { return existsSync(safe(file)) && lstatSync(file).isFile() } catch { return false } })
    if (!archive || process.platform !== 'win32') return { ready: false, message: `未找到 ${version} 客户端素材。请使用该版本的工程构建缓存（GRADLE_USER_HOME），或安装 ${version} 原版客户端后重试。不会自动下载。` }
    mkdirSync(root, { recursive: true })
    // Paths are environment data, never interpolated shell code. Only whitelisted PNG/JSON entries are copied.
    const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:MODCRAFTING_VISUAL_JAR)
try {
 $entry=$zip.GetEntry('version.json'); if(-not $entry){throw 'Missing client version'}
 $reader=New-Object IO.StreamReader($entry.Open()); try {$v=$reader.ReadToEnd()|ConvertFrom-Json} finally {$reader.Dispose()}
 if($v.id -ne '${version}'){throw 'Wrong Minecraft version'}
 $total=0; $count=0; $checked=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $zip.Entries){
  if($entry.FullName -cnotmatch '^assets/minecraft/(textures/[a-z0-9_/-]+\\.png|(?:models|items)/[a-z0-9_/-]+\\.json)$'){continue}
  $total+=$entry.Length; $count++; if($entry.Length -gt 1048576 -or $total -gt 67108864 -or $count -gt 20000){throw 'Client asset limit exceeded'}
  $target=Join-Path $env:MODCRAFTING_VISUAL_ROOT $entry.FullName
  $dir=[IO.Path]::GetDirectoryName($target)
  for($p=$dir; $p; $p=[IO.Path]::GetDirectoryName($p)){if(-not $checked.Add($p)){break};if([IO.Directory]::Exists($p) -and ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint)){throw 'Linked asset path'}}
  [IO.Directory]::CreateDirectory($dir)|Out-Null
  if([IO.File]::Exists($target)){if([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint){throw 'Linked asset file'};continue}
  $inputStream=$entry.Open();try{$outputStream=[IO.File]::Open($target,[IO.FileMode]::CreateNew);try{$inputStream.CopyTo($outputStream)}finally{$outputStream.Dispose()}}finally{$inputStream.Dispose()}
 }
 if($count -eq 0){throw 'Client assets missing'}
}finally{$zip.Dispose()}`
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, shell: false, env: { ...process.env, MODCRAFTING_VISUAL_JAR: archive, MODCRAFTING_VISUAL_ROOT: root } })
      let error = ''; const timer = setTimeout(() => { child.kill(); reject(Error('素材准备超时，请重试')) }, 60000)
      child.stdout.resume(); child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000) })
      child.on('error', cause => { clearTimeout(timer); reject(cause) }); child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('素材准备失败：' + error)) })
    })
    writeFileSync(safe(marker), JSON.stringify({ schema: 1, version, source: 'local-client', archive }), { flag: 'w' })
    return { ready: true }
  })().catch(cause => ({ ready: false, message: String(cause) })).finally(() => preparations.delete(root))
  preparations.set(root, work); return work
}

export async function visualAssets(paths: RuntimePaths, project: string, itemIds: string[], textureIds: string[], minecraft?: string) {
  const resolved = resolveVisualVersion(paths, minecraft)
  const status = await prepareVisualAssets(paths, resolved.version), cache = newCache()
  return {
    ok: true,
    ...status,
    version: resolved.version,
    exact: resolved.exact,
    availableVersions: resolved.available,
    ...(resolved.exact ? {} : { warning: `未找到 ${minecraft ?? resolved.version} 的客户端素材，图标使用 ${resolved.version} 的缓存渲染，可能与游戏内表现不一致。` }),
    items: Object.fromEntries(itemIds.map(id => [id, itemImage(paths, project, id, cache, resolved.version) ?? null])),
    textures: Object.fromEntries(textureIds.map(id => [id, textureImage(paths, project, id, cache, resolved.version) ?? null]))
  }
}
