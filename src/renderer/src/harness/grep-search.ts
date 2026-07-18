/**
 * Project-local ripgrep-like search for agent observation (SWE-agent style).
 */
import type { ToolContext } from './tools.ts'
import { FileSession } from './file-session.ts'

const DEFAULT_MAX_MATCHES = 40
const MAX_FILE_BYTES = 256 * 1024
const SKIP_DIRS = new Set(['build', '.gradle', 'run', 'node_modules', '.git', 'out', 'dist'])

function globToRegExp(glob: string): RegExp {
  let s = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      s += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (ch === '*') s += '[^/]*'
    else if ('.+^$()[]{}|'.includes(ch)) s += '\\' + ch
    else s += ch
  }
  return new RegExp('^' + s + '$', 'i')
}

async function walkFiles(
  projectPath: string,
  rel: string,
  acc: string[],
  depth: number
): Promise<void> {
  if (depth > 10 || acc.length > 800) return
  try {
    const entries = await window.api.listDirectory(rel ? `${projectPath}/${rel}` : projectPath)
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const norm = FileSession.normalize(childRel)
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walkFiles(projectPath, norm, acc, depth + 1)
      } else if (/\.(java|json|gradle|properties|toml|md|txt|accesswidener)$/i.test(entry.name)) {
        acc.push(norm)
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Locate files under `src/` whose basename matches `basename` (case-insensitive).
 * Used by read_file's ENOENT fallback so a wrong package path (or main/client mix-up)
 * still resolves to the real file instead of failing with raw ENOENT.
 */
export async function findFilesByBasename(
  projectPath: string,
  basename: string,
  limit = 8
): Promise<string[]> {
  if (!projectPath || !basename) return []
  const target = basename.replace(/\\/g, '/').split('/').pop() || basename
  const targetLower = target.toLowerCase()
  const files: string[] = []
  await walkFiles(projectPath, 'src', files, 0)
  const matches = files.filter((f) => (f.split('/').pop() || '').toLowerCase() === targetLower)
  return matches.slice(0, limit)
}

export async function grepInProject(
  ctx: ToolContext,
  pattern: string,
  options?: { path?: string; glob?: string; maxMatches?: number; caseInsensitive?: boolean }
): Promise<string> {
  if (!ctx.projectPath) return 'No project open'
  if (!pattern) return 'Error: pattern 不能为空'

  let re: RegExp
  try {
    re = new RegExp(pattern, options?.caseInsensitive === false ? 'g' : 'gi')
  } catch (err) {
    return `Error: 无效正则：${err instanceof Error ? err.message : String(err)}`
  }

  const rootRel = FileSession.normalize(options?.path || 'src')
  const files: string[] = []
  await walkFiles(ctx.projectPath, rootRel === '.' ? '' : rootRel, files, 0)

  const globRe = options?.glob ? globToRegExp(options.glob.replace(/\\/g, '/')) : null
  const filtered = globRe ? files.filter((f) => globRe.test(f) || globRe.test(f.split('/').pop() || '')) : files
  const max = Math.min(options?.maxMatches || DEFAULT_MAX_MATCHES, 100)
  const hits: string[] = []

  for (const rel of filtered) {
    if (hits.length >= max) break
    try {
      const res = await window.api.readFile(`${ctx.projectPath}/${rel}`)
      if (!res.success || res.content == null) continue
      if (res.content.length > MAX_FILE_BYTES) continue
      const lines = res.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= max) break
        re.lastIndex = 0
        if (re.test(lines[i])) {
          const snippet = lines[i].length > 200 ? lines[i].slice(0, 200) + '…' : lines[i]
          hits.push(`${rel}:${i + 1} | ${snippet}`)
        }
      }
    } catch {
      // skip
    }
  }

  if (hits.length === 0) {
    return `无匹配：pattern=${pattern} path=${rootRel}${options?.glob ? ` glob=${options.glob}` : ''}（扫描 ${filtered.length} 个文件）`
  }
  return `找到 ${hits.length} 处（上限 ${max}，扫描 ${filtered.length} 文件）：\n${hits.join('\n')}`
}
