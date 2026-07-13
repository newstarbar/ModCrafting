/**
 * Machine-checkable verifiers for eval tasks.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { createHash } from 'crypto'

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

function matchGlob(projectDir, pattern) {
  const files = walk(projectDir).map((f) => toPosix(path.relative(projectDir, f)))
  const re = globToRegExp(pattern)
  return files.filter((f) => re.test(f)).map((f) => path.join(projectDir, f))
}

function globToRegExp(glob) {
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

export function snapshotTree(projectDir) {
  const files = walk(projectDir)
    .map((f) => toPosix(path.relative(projectDir, f)))
    .filter((f) => !f.startsWith('build/') && !f.startsWith('.gradle/') && !f.includes('node_modules'))
    .sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    try {
      hash.update(readFileSync(path.join(projectDir, rel)))
    } catch {
      hash.update('missing')
    }
    hash.update('\0')
  }
  return { files, digest: hash.digest('hex') }
}

export async function runGradleBuild(projectDir, runtimeRoot, timeoutMs = 600_000) {
  const isWin = process.platform === 'win32'
  const cmd = isWin ? 'cmd.exe' : 'bash'
  const args = isWin
    ? ['/c', 'gradlew.bat', 'build', '--no-daemon']
    : ['-lc', './gradlew build --no-daemon']

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: path.join(runtimeRoot, 'gradle-home'),
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')}${path.delimiter}${process.env.PATH || ''}`
      },
      windowsHide: true
    })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, code: -1, out: out + '\n[timeout]' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { out += d.toString() })
    child.stderr?.on('data', (d) => { out += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, out })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out: String(err) })
    })
  })
}

/**
 * @returns {Promise<{ ok: boolean, name: string, detail?: string }>}
 */
export async function runCheck(projectDir, check, ctx) {
  const name = check.type
  try {
    switch (check.type) {
      case 'fileExists': {
        const ok = existsSync(path.join(projectDir, check.path))
        return { ok, name, detail: check.path }
      }
      case 'fileContains': {
        const p = path.join(projectDir, check.path)
        if (!existsSync(p)) return { ok: false, name, detail: `missing ${check.path}` }
        const ok = readFileSync(p, 'utf-8').includes(check.contains)
        return { ok, name, detail: `${check.path} ∋ ${check.contains}` }
      }
      case 'fileNotContains': {
        const p = path.join(projectDir, check.path)
        if (!existsSync(p)) return { ok: true, name, detail: `file removed: ${check.path}` }
        const ok = !readFileSync(p, 'utf-8').includes(check.contains)
        return { ok, name, detail: `${check.path} ∌ ${check.contains}` }
      }
      case 'fileMatches': {
        const hits = matchGlob(projectDir, check.pattern)
        const ok = hits.some((f) => readFileSync(f, 'utf-8').includes(check.contains))
        return { ok, name, detail: `${check.pattern} ∋ ${check.contains} (${hits.length} files)` }
      }
      case 'globExists': {
        const hits = matchGlob(projectDir, check.pattern)
        return { ok: hits.length > 0, name, detail: `${check.pattern} → ${hits.length}` }
      }
      case 'jsonValid': {
        const p = path.join(projectDir, check.path)
        if (!existsSync(p)) return { ok: false, name, detail: `missing ${check.path}` }
        JSON.parse(readFileSync(p, 'utf-8'))
        return { ok: true, name, detail: check.path }
      }
      case 'jsonValidGlob': {
        const hits = matchGlob(projectDir, check.pattern)
        if (hits.length === 0) return { ok: false, name, detail: 'no matches' }
        for (const f of hits) JSON.parse(readFileSync(f, 'utf-8'))
        return { ok: true, name, detail: `${hits.length} json ok` }
      }
      case 'gradleBuild': {
        if (ctx.skipBuild) return { ok: true, name, detail: 'skipped (--skip-build)' }
        const res = await runGradleBuild(projectDir, ctx.runtimeRoot, ctx.buildTimeoutMs || 600_000)
        return {
          ok: res.ok,
          name,
          detail: res.ok ? 'BUILD SUCCESSFUL' : `exit ${res.code}: ${res.out.slice(-800)}`
        }
      }
      case 'agentOutputContainsAny': {
        const text = ctx.agentOutput || ''
        const ok = (check.needles || []).some((n) => text.toLowerCase().includes(String(n).toLowerCase()))
        return { ok, name, detail: `needles=${(check.needles || []).join('|')}` }
      }
      case 'noFileChanges': {
        const before = ctx.snapshotBefore
        const after = snapshotTree(projectDir)
        const ok = before && before.digest === after.digest
        return { ok, name, detail: ok ? 'unchanged' : 'files changed' }
      }
      default:
        return { ok: false, name, detail: `unknown check ${check.type}` }
    }
  } catch (err) {
    return { ok: false, name, detail: err instanceof Error ? err.message : String(err) }
  }
}

export async function runVerifiers(projectDir, checks, ctx) {
  const results = []
  for (const check of checks) {
    const r = await runCheck(projectDir, check, ctx)
    results.push(r)
    if (!r.ok && ctx.failFast) break
  }
  return {
    ok: results.every((r) => r.ok),
    results
  }
}
