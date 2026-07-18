/**
 * Project reconnaissance helpers for system-prompt injection.
 * Keeps scanning I/O in the controller; pure formatters stay unit-testable.
 */

export const MAX_JAVA_FILES_IN_PROMPT = 40

const GRADLE_SUMMARY_KEYS = [
  'minecraft_version',
  'loader_version',
  'fabric_version',
  'yarn_mappings',
  'mod_version',
  'maven_group',
  'archives_base_name'
] as const

export function toProjectRelativePath(absPath: string, projectPath: string): string {
  const normalizedAbs = absPath.replace(/\\/g, '/')
  const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const prefix = normalizedRoot + '/'
  if (normalizedAbs.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedAbs.slice(prefix.length)
  }
  return normalizedAbs
}

export function formatJavaFileList(
  relPaths: string[],
  label: string,
  max = MAX_JAVA_FILES_IN_PROMPT
): string {
  if (relPaths.length === 0) return `${label}：（无 .java 文件）\n`
  const sorted = [...relPaths].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, max)
  let out = `${label}（${sorted.length}）：${shown.join(', ')}\n`
  if (sorted.length > max) {
    out += `…另有 ${sorted.length - max} 个未列出\n`
  }
  return out
}

export function parseGradleProperties(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export function formatGradleSummary(props: Record<string, string>): string {
  const parts: string[] = []
  for (const key of GRADLE_SUMMARY_KEYS) {
    const value = props[key]
    if (value) parts.push(`${key}=${value}`)
  }
  if (parts.length === 0) return ''
  return `Gradle 属性：${parts.join(', ')}\n`
}

export type DirEntry = { name: string; isDirectory: boolean; path: string }

/** Walk a Java source root; collect package names and .java relative paths. */
export async function scanJavaSourceTree(
  rootAbs: string,
  projectPath: string,
  listDirectory: (absPath: string) => Promise<DirEntry[]>
): Promise<{ packages: string[]; javaFiles: string[] }> {
  const packages: string[] = []
  const javaFiles: string[] = []

  const walk = async (dir: string, pkgPrefix: string): Promise<void> => {
    const entries = await listDirectory(dir)
    for (const entry of entries) {
      if (entry.isDirectory) {
        const pkg = pkgPrefix ? `${pkgPrefix}.${entry.name}` : entry.name
        packages.push(pkg)
        await walk(entry.path, pkg)
      } else if (entry.name.endsWith('.java')) {
        javaFiles.push(toProjectRelativePath(entry.path, projectPath))
      }
    }
  }

  const rootEntries = await listDirectory(rootAbs)
  for (const entry of rootEntries) {
    if (entry.isDirectory) {
      packages.push(entry.name)
      await walk(entry.path, entry.name)
    } else if (entry.name.endsWith('.java')) {
      javaFiles.push(toProjectRelativePath(entry.path, projectPath))
    }
  }

  return { packages, javaFiles }
}
