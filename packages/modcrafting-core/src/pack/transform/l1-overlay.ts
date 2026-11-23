/**
 * L1: a resource/data overlay.
 *
 * The output is a resource pack that replaces assets or data paths. It is built
 * from scratch; the source jar is only read (for hash verification and for `copy`
 * operations), never rewritten. Overlay paths stop at `assets/` and `data/`: a
 * "resource pack" that carries classes or mod metadata is not an overlay, and
 * allowing one here would be the quiet path to changing executable behaviour.
 */

import { createZip, readZip, type ZipEntry } from '../zip.ts'

export interface L1Operation {
  path: string
  text?: string
  base64?: string
  copy?: boolean
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

export function overlayPathSafe(value: string): boolean {
  if (!/^(assets|data)\//.test(value)) return false
  if (value.length > 512 || value.includes('\\') || value.includes('\u0000')) return false
  if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return false
  if (/\.class$/i.test(value) || /^META-INF\//i.test(value)) return false
  return true
}

export function buildOverlayZip(input: {
  jarBytes: Buffer
  entryId: string
  operations: readonly L1Operation[]
  packFormat: number
  provenance: Record<string, unknown>
}): { archive: Buffer; files: string[] } {
  const source = new Map(readZip(input.jarBytes).map((entry) => [entry.path, entry]))
  const files = new Map<string, Buffer>()

  for (const operation of input.operations) {
    if (!overlayPathSafe(operation.path)) {
      fail('TRANSFORM_PATH_UNSAFE', `覆盖路径 ${operation.path} 不安全：只允许 assets/ 或 data/ 下的普通文件，不能是 class 或 META-INF。`)
    }
    if (files.has(operation.path)) fail('TRANSFORM_DUPLICATE_PATH', `覆盖路径 ${operation.path} 出现了两次。`)
    const modes = Number(operation.copy === true) + Number(operation.text !== undefined) + Number(operation.base64 !== undefined)
    if (modes !== 1) fail('TRANSFORM_OPERATION_INVALID', `覆盖操作 ${operation.path} 必须且只能选择 copy、text、base64 之一。`)

    if (operation.copy === true) {
      const entry: ZipEntry | undefined = source.get(operation.path)
      if (!entry) fail('TRANSFORM_SOURCE_ENTRY_MISSING', `源 jar 里没有 ${operation.path}，无法复制到覆盖层。先确认路径，或改用 text/base64 新建文件。`)
      files.set(operation.path, entry.data)
      continue
    }
    if (operation.text !== undefined) {
      files.set(operation.path, Buffer.from(operation.text, 'utf8'))
      continue
    }
    const base64 = operation.base64 ?? ''
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) fail('TRANSFORM_OPERATION_INVALID', `覆盖操作 ${operation.path} 的 base64 不合法。`)
    files.set(operation.path, Buffer.from(base64, 'base64'))
  }

  const packMeta = {
    pack: {
      pack_format: input.packFormat,
      supported_formats: { min_inclusive: 1, max_inclusive: 999 },
      description: `${input.entryId} L1 overlay（由 ModCrafting 生成）`
    }
  }
  const all = [
    { path: 'pack.mcmeta', data: `${JSON.stringify(packMeta, null, 2)}\n` },
    { path: 'modcrafting.transform.json', data: `${JSON.stringify(input.provenance, null, 2)}\n` },
    ...[...files.entries()].map(([path, data]) => ({ path, data }))
  ]
  return { archive: createZip(all), files: all.map((entry) => entry.path).sort() }
}
