#!/usr/bin/env node
/**
 * Materialise the Claude Code plugin + marketplace entry that live in git, so
 * `claude plugin marketplace add newstarbar/ModCrafting` works without the
 * bundle being committed.
 *
 * The plugin is intentionally thin: it points at the published npm package
 * (`npx modcrafting-mcp@<version>`) instead of shipping dist/mcp-server.js.
 * `--check` fails instead of writing, which keeps the three committed version
 * strings from drifting.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fabric = path.join(root, 'plugins/modcrafting-fabric')
const plugin = path.join(root, 'plugins/modcrafting-claude')
const marketplace = path.join(root, '.claude-plugin/marketplace.json')

async function render() {
  const manifest = JSON.parse(await readFile(path.join(fabric, '.codex-plugin/plugin.json'), 'utf8'))
  const version = manifest.version
  const pluginManifest = {
    name: 'modcrafting-fabric',
    description: 'Develop, build and deterministically validate Minecraft Fabric 1.21.4 mods from Claude Code.',
    version,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords
  }
  const mcp = {
    mcpServers: {
      'modcrafting-fabric': {
        command: 'npx',
        args: ['-y', `modcrafting-mcp@${version}`]
      }
    }
  }
  const index = {
    name: 'modcrafting',
    owner: { name: 'newstarbar', url: 'https://github.com/newstarbar' },
    plugins: [{
      name: 'modcrafting-fabric',
      source: './plugins/modcrafting-claude',
      description: 'Fabric 1.21.4 模组开发、构建、游戏准备与测试报告（MCP + Skills）。',
      version,
      author: manifest.author,
      homepage: manifest.homepage,
      keywords: manifest.keywords,
      category: 'developer-tools'
    }]
  }
  const skills = (await readdir(path.join(fabric, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  return { version, pluginManifest, mcp, index, skills }
}

export async function stageClaude({ check = false } = {}) {
  const { version, pluginManifest, mcp, index, skills } = await render()
  const outputs = new Map([
    [path.join(plugin, '.claude-plugin/plugin.json'), `${JSON.stringify(pluginManifest, null, 2)}\n`],
    [path.join(plugin, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`],
    [path.join(plugin, 'README.md'), `# ModCrafting Fabric for Claude Code\n\n安装：\n\n\`\`\`\n/plugin marketplace add newstarbar/ModCrafting\n/plugin install modcrafting-fabric@modcrafting\n\`\`\`\n\n首次启动时 Claude Code 通过 \`npx -y modcrafting-mcp@${version}\` 拉起 MCP，技能随插件加载。\n需要绝对 node 路径、离线安装或多宿主管理时改用安装器：\n\n\`\`\`\nnpx -y github:newstarbar/ModCrafting#release install --host claude\n\`\`\`\n`],
    [marketplace, `${JSON.stringify(index, null, 2)}\n`]
  ])
  const copies = new Map()
  for (const name of skills) copies.set(path.join(plugin, 'skills', name, 'SKILL.md'), path.join(fabric, 'skills', name, 'SKILL.md'))

  // Git normalises EOL on checkout (Windows runners get CRLF), so drift is a
  // content comparison, not a byte comparison.
  const normalize = (value) => (value === undefined ? undefined : value.replace(/\r\n/g, '\n'))
  const drift = []
  for (const [file, content] of outputs) {
    if (check) {
      const current = existsSync(file) ? await readFile(file, 'utf8') : undefined
      if (normalize(current) !== normalize(content)) drift.push(path.relative(root, file))
    } else {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }
  }
  for (const [target, source] of copies) {
    if (check) {
      const current = existsSync(target) ? await readFile(target, 'utf8') : undefined
      if (normalize(current) !== normalize(await readFile(source, 'utf8'))) drift.push(path.relative(root, target))
    } else {
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(source, target)
    }
  }
  if (check && drift.length) throw new Error(`Claude 插件文件已漂移，运行 pnpm run claude:stage 重新生成：\n${drift.join('\n')}`)
  return { ok: true, version, check, files: [...outputs.keys(), ...copies.keys()].map((file) => path.relative(root, file)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: claude:stage [--check]. Generates the thin Claude Code plugin and marketplace entry (no bundle committed).')
  else console.log(JSON.stringify(await stageClaude({ check: Boolean(values.check) })))
}
