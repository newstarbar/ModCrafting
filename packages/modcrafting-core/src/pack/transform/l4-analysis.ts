/**
 * L4: structural analysis, not decompilation.
 *
 * The release does not ship a decompiler. What it can do without one is the part
 * that makes a transform plan reviewable: list the classes, sizes, mixin configs
 * and declared mod metadata inside a jar. Class bytes are counted, never emitted;
 * the analysis file contains names and lengths only, and is marked non-exportable.
 */

import { readZip } from '../zip.ts'

export interface JarAnalysis {
  classes: Array<{ name: string; path: string; size: number }>
  resources: Record<string, number>
  mixinConfigs: string[]
  metadata: Record<string, unknown> | null
  totalEntries: number
  truncated: boolean
  decompiler: 'not-shipped'
}

export function analyzeJar(jarBytes: Buffer, maxClasses: number, options: { warn?: (message: string) => void } = {}): JarAnalysis {
  const entries = readZip(jarBytes)
  const classes: JarAnalysis['classes'] = []
  const resources: Record<string, number> = {}
  const mixinConfigs: string[] = []
  let metadata: Record<string, unknown> | null = null

  for (const entry of entries) {
    if (entry.path.endsWith('.class')) {
      if (classes.length < maxClasses) {
        classes.push({
          name: entry.path.slice(0, -'.class'.length).split('/').join('.'),
          path: entry.path,
          size: entry.data.length
        })
      }
      continue
    }
    if (/\.mixins?\.json$/i.test(entry.path)) mixinConfigs.push(entry.path)
    if (entry.path === 'fabric.mod.json') {
      try {
        metadata = JSON.parse(entry.data.toString('utf8')) as Record<string, unknown>
      } catch {
        options.warn?.('fabric.mod.json 不是合法 JSON，已跳过元数据解析。')
      }
    }
    if (entry.path === 'META-INF/mods.toml' || entry.path === 'META-INF/neoforge.mods.toml') {
      metadata = { ...(metadata ?? {}), loader: 'forge-family', metadataPath: entry.path }
    }
    const top = entry.path.split('/')[0]
    resources[top] = (resources[top] ?? 0) + 1
  }

  classes.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  mixinConfigs.sort()
  if (classes.length >= maxClasses) {
    options.warn?.(`类列表达到上限 ${maxClasses}，分析结果是截断的；提高 maxClasses 可看到完整清单。`)
  }

  return {
    classes,
    resources,
    mixinConfigs,
    metadata,
    totalEntries: entries.length,
    truncated: classes.length >= maxClasses,
    decompiler: 'not-shipped'
  }
}
