#!/usr/bin/env node
/**
 * Build the three publishable npm tarballs from the verified bundle:
 *   modcrafting        — the installer CLI (root package, same code as npx github:)
 *   modcrafting-mcp    — the self-contained MCP server + its bundle manifest
 *   modcrafting-skills — the portable SKILL.md set
 *
 * Versions are injected from the root package.json, so there is no fourth
 * file to bump by hand. Output: temp/npm-artifacts/*.tgz plus receipt.json.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundleDir = path.join(root, 'temp/bundle-artifacts/modcrafting-bundle')
const outputRoot = path.join(root, 'temp/npm-artifacts')
const cliSource = path.join(root, 'packages/modcrafting-cli')

const MCP_SHIM = `#!/usr/bin/env node
/** Start the packaged ModCrafting MCP server with a stable per-install data directory. */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, '..', 'dist', 'mcp-server.js')
const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir()
const env = { ...process.env, MODCRAFTING_DATA: process.env.MODCRAFTING_DATA ?? path.join(home, '.modcrafting', 'data', 'mcp') }
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit', env })
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
`

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function pack(directory, destination) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const raw = execFileSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: directory,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024
  })
  const start = raw.indexOf('[')
  if (start < 0) throw new Error(`npm pack 没有返回 JSON：${raw.slice(0, 200)}`)
  const [report] = JSON.parse(raw.slice(start))
  const file = path.join(destination, report.filename)
  return { file, filename: report.filename, bytes: report.size, files: report.entryCount }
}

function packageJson({ name, version, description, bin, files, keywords }) {
  return {
    name,
    version,
    description,
    type: 'module',
    license: 'GPL-3.0',
    author: 'newstarbar',
    homepage: 'https://github.com/newstarbar/ModCrafting',
    repository: { type: 'git', url: 'https://github.com/newstarbar/ModCrafting.git' },
    bugs: { url: 'https://github.com/newstarbar/ModCrafting/issues' },
    engines: { node: '>=22.15.0' },
    keywords,
    ...(bin ? { bin } : {}),
    files
  }
}

export async function packageNpm({ output = outputRoot } = {}) {
  if (!existsSync(path.join(bundleDir, 'bundle.json'))) throw new Error('NPM_MISSING_BUNDLE: run "pnpm run bundle:stage" first')
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const bundle = JSON.parse(await readFile(path.join(bundleDir, 'bundle.json'), 'utf8'))
  if (bundle.version !== rootPackage.version) throw new Error(`bundle ${bundle.version} 与 package.json ${rootPackage.version} 不一致；先重新 bundle:stage`)
  const version = bundle.version

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  const work = path.join(output, '.work')

  // 1. CLI: pack the repository root with its `files` allowlist.
  const cliPack = await pack(root, output)

  // 2. MCP: bundle payload + a launcher shim.
  const mcpDir = path.join(work, 'modcrafting-mcp')
  await mkdir(path.join(mcpDir, 'bin'), { recursive: true })
  for (const entry of ['dist', 'assets', 'skills']) await cp(path.join(bundleDir, entry), path.join(mcpDir, entry), { recursive: true })
  for (const file of ['bundle.json', 'compatibility.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) await cp(path.join(bundleDir, file), path.join(mcpDir, file))
  await writeFile(path.join(mcpDir, 'bin/modcrafting-mcp.mjs'), MCP_SHIM)
  await writeFile(path.join(mcpDir, 'README.md'), [
    '# modcrafting-mcp', '',
    'ModCrafting Fabric 的自包含 MCP 服务器（stdio）。', '',
    '```', 'npx -y modcrafting-mcp@' + version, '```', '',
    '宿主配置示例：', '', '```json',
    JSON.stringify({ mcpServers: { 'modcrafting-fabric': { command: 'npx', args: ['-y', `modcrafting-mcp@${version}`], env: { MODCRAFTING_DATA: '<绝对路径>' } } } }, null, 2),
    '```', '',
    '推荐直接用安装器，它会写绝对 node 路径、装技能并记账：', '',
    '```', 'npx -y github:newstarbar/ModCrafting#release install --auto', '```', ''
  ].join('\n'))
  await writeFile(path.join(mcpDir, 'package.json'), `${JSON.stringify(packageJson({
    name: 'modcrafting-mcp',
    version,
    description: 'Self-contained ModCrafting Fabric MCP server (stdio) for Codex, Claude Code, Cursor and other agents.',
    bin: { 'modcrafting-mcp': './bin/modcrafting-mcp.mjs' },
    files: ['bin/', 'dist/', 'assets/', 'skills/', 'bundle.json', 'compatibility.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md'],
    keywords: ['minecraft', 'fabric', 'mcp', 'modding']
  }), null, 2)}\n`)

  // 3. Skills: portable SKILL.md set plus a machine readable index.
  const skillsDir = path.join(work, 'modcrafting-skills')
  await cp(path.join(bundleDir, 'skills'), path.join(skillsDir, 'skills'), { recursive: true })
  const index = []
  for (const name of bundle.skills) {
    const markdown = await readFile(path.join(bundleDir, 'skills', name, 'SKILL.md'), 'utf8')
    const description = /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
    index.push({ name, description, path: `skills/${name}/SKILL.md`, sha256: sha256(Buffer.from(markdown)) })
  }
  await writeFile(path.join(skillsDir, 'index.json'), `${JSON.stringify({ name: 'modcrafting-fabric', version, skills: index }, null, 2)}\n`)
  await writeFile(path.join(skillsDir, 'README.md'), [
    '# modcrafting-skills', '',
    'ModCrafting 的可移植 Agent Skills（SKILL.md 格式）。', '',
    '安装到任意支持 Agent Skills 的宿主：', '',
    '```', `npx -y github:newstarbar/ModCrafting#release skills --host <id>`, '```', '',
    '技能列表：', '', ...index.map((item) => `- \`${item.name}\` — ${item.description}`), ''
  ].join('\n'))
  await writeFile(path.join(skillsDir, 'package.json'), `${JSON.stringify(packageJson({
    name: 'modcrafting-skills',
    version,
    description: 'Portable ModCrafting Agent Skills (SKILL.md) for Fabric mod development and game validation.',
    files: ['skills/', 'index.json', 'README.md', 'LICENSE'],
    keywords: ['agent-skills', 'minecraft', 'fabric', 'modding']
  }), null, 2)}\n`)
  await cp(path.join(bundleDir, 'LICENSE'), path.join(skillsDir, 'LICENSE'))

  const packages = [
    { name: 'modcrafting', role: 'cli', ...cliPack },
    { name: 'modcrafting-mcp', role: 'mcp', ...await pack(mcpDir, output) },
    { name: 'modcrafting-skills', role: 'skills', ...await pack(skillsDir, output) }
  ]
  await rm(work, { recursive: true, force: true })

  const result = {
    ok: true,
    version,
    directory: output,
    packages: packages.map((item) => ({ ...item, sha256: sha256(readFileSync(item.file)) }))
  }
  await writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: release:npm [--output DIR]. Builds modcrafting / modcrafting-mcp / modcrafting-skills tarballs; never publishes.')
  else console.log(JSON.stringify(await packageNpm(values.output ? { output: path.resolve(values.output) } : {})))
}
