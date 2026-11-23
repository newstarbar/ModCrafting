import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { stageQoder, createPortableZip } from '../plugin/stage-qoder.mjs'
import { stageHosts } from '../plugin/stage-hosts.mjs'
import { zipDirectory } from './zip-dir.mjs'
import { packageOffline } from './package-offline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) }
const { values } = parseArgs({ options: {
  'candidate-json': { type: 'string' }, 'output-root': { type: 'string' }, tag: { type: 'string' }, help: { type: 'boolean' }
} })

if (values.help) {
  console.log('Usage: release:package --candidate-json ABSOLUTE-CANDIDATE-JSON --output-root ABSOLUTE-OUTPUT [--tag vX.Y.Z]')
  process.exit(0)
}
if (!values['candidate-json'] || !path.isAbsolute(values['candidate-json'])) throw Error('--candidate-json must be an absolute path')
if (!values['output-root'] || !path.isAbsolute(values['output-root'])) throw Error('--output-root must be an absolute path')

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const tag = values.tag || `v${packageJson.version}`
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw Error('Release tag must use vMAJOR.MINOR.PATCH with an optional prerelease suffix')
if (tag !== `v${packageJson.version}`) throw Error(`Tag ${tag} does not match package.json version v${packageJson.version}`)

const candidateFile = await realpath(values['candidate-json'])
const candidate = JSON.parse(await readFile(candidateFile, 'utf8'))
if (candidate.ok !== true || !candidate.product || !candidate.distribution) throw Error('Candidate receipt must identify a complete product and host distribution')
const product = path.resolve(candidate.product), distribution = path.resolve(candidate.distribution)
if (!path.isAbsolute(candidate.product) || !path.isAbsolute(candidate.distribution)) throw Error('Candidate product and distribution paths must be absolute')
for (const directory of [product, distribution]) {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error(`Candidate path is not an ordinary directory: ${directory}`)
}
const productManifest = JSON.parse(await readFile(path.join(product, 'manifest.json'), 'utf8'))
const pluginIdentity = JSON.parse(await readFile(path.join(product, 'plugin/.codex-plugin/plugin.json'), 'utf8'))
if (pluginIdentity.name !== 'modcrafting-fabric' || pluginIdentity.version !== packageJson.version) throw Error('Candidate plugin version does not match package.json')
if (productManifest.target?.platform !== 'win32-x64' || productManifest.target?.observerProtocol !== 2) throw Error('Candidate is not the current Windows x64 / Observer V2 product')
if (candidate.coreBundleSha256 !== productManifest.files?.['plugin/dist/mcp-server.js']) throw Error('Candidate bundle fingerprint does not match its product manifest')
const observerSha256 = productManifest.files?.['observer/modcrafting-observer.jar']
if (!/^[a-f0-9]{64}$/.test(observerSha256 || '')) throw Error('Candidate Observer fingerprint is missing')

const outputRoot = path.resolve(values['output-root'])
if (inside(product, outputRoot) || inside(distribution, outputRoot) || inside(path.dirname(candidateFile), outputRoot)) throw Error('Release output must be outside candidate inputs')
await mkdir(outputRoot, { recursive: true })
if ((await lstat(outputRoot)).isSymbolicLink()) throw Error('Release output must not be a junction or symlink')
const bundleDirectory = path.join(root, 'temp/bundle-artifacts/modcrafting-bundle')
const bundleManifestFile = path.join(bundleDirectory, 'bundle.json')
if (!existsSync(bundleManifestFile)) throw Error('Missing runtime bundle: run "pnpm run bundle:stage" after plugin:stage')
const bundleManifest = JSON.parse(await readFile(bundleManifestFile, 'utf8'))
if (bundleManifest.version !== packageJson.version) throw Error('Bundle version does not match package.json')
if (bundleManifest.files?.['dist/mcp-server.js'] !== candidate.coreBundleSha256) throw Error('Bundle fingerprint does not match the candidate receipt')

const outputDirectory = await mkdtemp(path.join(outputRoot, 'modcrafting-release-'))
const stagingRoot = await mkdtemp(path.join(outputRoot, '.modcrafting-stage-'))

const qoderZip = path.join(outputDirectory, `ModCrafting-Fabric-Qoder-Plugin-${tag}.zip`)
const hostsZip = path.join(outputDirectory, `ModCrafting-Fabric-Multi-Host-${tag}.zip`)
const mcpZip = path.join(outputDirectory, `ModCrafting-MCP-${tag}.zip`)
const skillsZip = path.join(outputDirectory, `ModCrafting-Skills-${tag}.zip`)
let offline
try {
  const qoder = await stageQoder({ source: path.join(product, 'plugin'), outputRoot: path.join(stagingRoot, 'qoder') })
  const hosts = await stageHosts(product, path.join(stagingRoot, 'hosts'))
  await cp(qoder.zip, qoderZip, { errorOnExist: true, force: false })
  createPortableZip(hosts.directory, hostsZip)
  zipDirectory(bundleDirectory, mcpZip)
  const skillsStage = path.join(stagingRoot, 'skills')
  await cp(path.join(bundleDirectory, 'skills'), path.join(skillsStage, 'skills'), { recursive: true })
  const index = []
  for (const name of bundleManifest.skills) {
    const markdown = await readFile(path.join(bundleDirectory, 'skills', name, 'SKILL.md'), 'utf8')
    const description = /^description:\s*(.+)$/m.exec(markdown)?.[1]?.trim() ?? ''
    index.push({ name, description, path: `skills/${name}/SKILL.md`, sha256: sha256(Buffer.from(markdown)) })
  }
  await writeFile(path.join(skillsStage, 'index.json'), `${JSON.stringify({ name: 'modcrafting-fabric', version: bundleManifest.version, skills: index }, null, 2)}\n`)
  await cp(path.join(bundleDirectory, 'LICENSE'), path.join(skillsStage, 'LICENSE'))
  zipDirectory(skillsStage, skillsZip)
  offline = await packageOffline({ tag, output: path.join(stagingRoot, 'offline') })
  await cp(offline.file, path.join(outputDirectory, offline.filename), { errorOnExist: true, force: false })
} finally {
  await rm(stagingRoot, { recursive: true })
}

const sourceCommit = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const githubActionsRun = Boolean(process.env.GITHUB_RUN_ID)
const releaseInfo = {
  releaseManifestVersion: 1,
  tag,
  productVersion: packageJson.version,
  sourceCommit,
  target: productManifest.target,
  observer: { version: productManifest.observer?.version, protocol: productManifest.observer?.declaredProtocol, sha256: observerSha256 },
  coreBundleSha256: candidate.coreBundleSha256,
  packages: {
    qoder: path.basename(qoderZip),
    multiHost: path.basename(hostsZip),
    mcp: path.basename(mcpZip),
    skills: path.basename(skillsZip),
    offline: path.basename(path.join(outputDirectory, offline.filename))
  },
  validation: {
    githubActions: githubActionsRun ? `checks passed in run ${process.env.GITHUB_RUN_ID}` : 'not verified by local packaging',
    minecraftGameplay: 'not run by this workflow',
    qoderAuthenticatedChat: 'not run by this workflow'
  }
}
const infoFile = path.join(outputDirectory, `ModCrafting-Fabric-Release-Info-${tag}.json`)
await writeFile(infoFile, `${JSON.stringify(releaseInfo, null, 2)}\n`, { flag: 'wx' })
const assets = [qoderZip, hostsZip, mcpZip, skillsZip, path.join(outputDirectory, offline.filename), infoFile]
const sums = (await Promise.all(assets.map(async file => `${sha256(await readFile(file))}  ${path.basename(file)}`))).join('\n') + '\n'
const checksums = path.join(outputDirectory, `ModCrafting-Fabric-SHA256SUMS-${tag}.txt`)
await writeFile(checksums, sums, { flag: 'wx' })

const prerelease = tag.includes('-')
const notesFile = path.join(outputDirectory, 'release-notes.md')
// A hand-written note for this tag wins over the generic template, so a
// release page can describe the actual changes without changing the packager.
const customNotesFile = path.join(root, 'docs/releases', `${tag}.md`)
const customNotes = existsSync(customNotesFile) ? await readFile(customNotesFile, 'utf8') : undefined
const verificationSummary = githubActionsRun
  ? 'GitHub Actions 已通过静态检查、插件回归、MCP 协议 Smoke、离线 Fabric-Bench 和 Windows 候选包构建。'
  : '此文件由本地打包器生成，尚未代表 GitHub Actions 检查通过。'
const notes = customNotes ?? (`# ModCrafting Fabric ${tag}\n\n` +
  '此版本属于 `release` 发布主线，面向 Fabric 1.21.4，提供 Qoder 桌面 Plugin 和跨宿主插件包。\n\n' +
  '## 下载与安装\n\n' +
  `- **Qoder 桌面版**：下载 \`${path.basename(qoderZip)}\`，在 Qoder Plugin 管理界面导入。\n` +
  `- **一句话安装（推荐）**：\`npx -y github:newstarbar/ModCrafting#${tag} install --auto --json\`\n` +
  `- **Codex / Claude Code / Qoder CLI**：下载 \`${path.basename(hostsZip)}\`，按压缩包中的 README 和宿主目录配置。\n` +
  `- **仅 MCP / 仅技能**：\`${path.basename(mcpZip)}\`、\`${path.basename(skillsZip)}\`。\n` +
  `- **离线安装（QQ 群）**：\`${offline.filename}\`，解压后双击 install.cmd 或把包内 PROMPT.md 发给 Agent。\n` +
  `- **校验**：\`${path.basename(checksums)}\` 包含全部资产与构建信息的 SHA-256。\n\n` +
  '## 验收范围\n\n' +
  `${verificationSummary} 该工作流不登录 Qoder、不启动交互式 Minecraft；真实宿主聊天与实机玩法结果需按仓库的候选验收记录单独确认。\n`)
await writeFile(notesFile, notes, { flag: 'wx' })

const result = { ok: true, tag, version: packageJson.version, prerelease, directory: outputDirectory, qoderZip, hostsZip, mcpZip, skillsZip, offlineZip: path.join(outputDirectory, offline.filename), infoFile, checksums, notesFile }
console.log(JSON.stringify(result))
