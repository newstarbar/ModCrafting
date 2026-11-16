/** Test helpers: every CLI invocation runs in a throw-away HOME. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const repoRoot = path.resolve(cliRoot, '..', '..')
export const BIN = path.join(cliRoot, 'bin', 'modcrafting.mjs')
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function makeHome(label = 'home') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mc-${label}-`))
  fs.mkdirSync(path.join(root, 'AppData', 'Roaming'), { recursive: true })
  return root
}

const HOST_ENV = /^(CODEX|CLAUDE|CLAUDECODE|CURSOR|DEVIN|WINDSURF|CODEIUM|OPENCODE|PI|ZCODE|DSH|QODER|TRAE|WORKBUDDY|CODEBUDDY|COPILOT|KIMI|GITHUB_COPILOT)/

export function envFor(home, extra = {}) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (HOST_ENV.test(key)) continue
    base[key] = value
  }
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    MODCRAFTING_HOME: path.join(home, '.modcrafting'),
    MODCRAFTING_NO_NETWORK: '1',
    ...extra
  }
}

export function run(args, { home, env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: envFor(home ?? makeHome(), env),
    windowsHide: true
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status, stdout, stderr, json: tryJson(stdout) ?? tryJson(stderr) }
}

/** Async variant: required whenever the test itself serves HTTP (spawnSync would block the loop). */
export function runAsync(args, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: envFor(home ?? makeHome(), env), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr, json: tryJson(stdout) ?? tryJson(stderr) }))
  })
}

function tryJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Minimal bundle: hashes match, entry is a harmless node script. */
export function makeBundle(label = 'bundle', version = '9.9.9') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-${label}-`))
  const files = {
    'dist/mcp-server.js': 'process.stdout.write(JSON.stringify({ ok: true, fake: true }) + "\\n")\n',
    'compatibility.json': `${JSON.stringify({ contractVersion: 1, version, minecraft: '1.21.4' }, null, 2)}\n`,
    'assets/placeholder.txt': 'icon\n',
    'skills/modcrafting-start/SKILL.md': '---\nname: modcrafting-start\ndescription: test\n---\nbody\n',
    'skills/fabric-mod-development/SKILL.md': '---\nname: fabric-mod-development\ndescription: test\n---\nbody\n',
    'skills/fabric-game-validation/SKILL.md': '---\nname: fabric-game-validation\ndescription: test\n---\nbody\n'
  }
  const hashes = {}
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    hashes[relative] = sha256(Buffer.from(content))
  }
  fs.writeFileSync(path.join(dir, 'bundle.json'), `${JSON.stringify({
    bundleVersion: 1,
    name: 'modcrafting-fabric',
    version,
    minecraft: '1.21.4',
    entry: 'dist/mcp-server.js',
    skills: ['modcrafting-start', 'fabric-mod-development', 'fabric-game-validation'],
    dataPlaceholder: 'MODCRAFTING_DATA',
    files: hashes
  }, null, 2)}\n`)
  return dir
}

export function realBundle() {
  const dir = path.join(repoRoot, 'temp', 'bundle-artifacts', 'modcrafting-bundle')
  return fs.existsSync(path.join(dir, 'bundle.json')) ? dir : undefined
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
