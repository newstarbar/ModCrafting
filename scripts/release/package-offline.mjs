#!/usr/bin/env node
/**
 * Self-contained offline package for QQ-group distribution:
 * CLI + verified bundle + double-click launchers + the exact Agent prompt.
 * No network, no git, no pnpm needed after download.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { zipDirectory } from './zip-dir.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundleDir = path.join(root, 'temp/bundle-artifacts/modcrafting-bundle')
const cliSource = path.join(root, 'packages/modcrafting-cli')
const outputRoot = path.join(root, 'temp/offline-artifacts')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const INSTALL_CMD = `@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 22.15 或更新版本：https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0cli\\bin\\modcrafting.mjs" install --bundle-dir "%~dp0bundle" --auto %*
if errorlevel 1 pause
`

const INSTALL_SH = `#!/usr/bin/env sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/cli/bin/modcrafting.mjs" install --bundle-dir "$DIR/bundle" --auto "$@"
`

function prompt(version) {
  return `# 让 Agent 一句话安装 ModCrafting（离线包 ${version}）

把整段话连同解压目录路径发给 Agent：

> 我下载了 ModCrafting ${version} 离线包，解压在 \`<解压目录>\`。
> 请先确认 \`node --version\` 是 22.15 或更新版本，然后运行
> \`node <解压目录>/cli/bin/modcrafting.mjs install --bundle-dir <解压目录>/bundle --auto --json\`。
> 如果返回 AMBIGUOUS_HOST，就按我当前用的编辑器加上 \`--host <id>\` 重试；
> 装完按 restartHint 重启宿主，再运行 \`doctor --json\` 确认没有 problems。

Windows 用户也可以直接双击 \`install.cmd\`（会把参数原样传给安装器）。
macOS / Linux 运行 \`./install.sh\`。

宿主 id：codex claude cursor devin devin-desktop opencode pi zcode dsh qoder trae
          workbuddy codebuddy copilot kimi generic
`
}

export async function packageOffline({ tag, output = outputRoot } = {}) {
  if (!existsSync(path.join(bundleDir, 'bundle.json'))) throw new Error('OFFLINE_MISSING_BUNDLE: run "pnpm run bundle:stage" first')
  const rootPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const bundle = JSON.parse(await readFile(path.join(bundleDir, 'bundle.json'), 'utf8'))
  const releaseTag = tag ?? `v${rootPackage.version}`
  if (releaseTag !== `v${bundle.version}`) throw new Error(`tag ${releaseTag} 与 bundle 版本 ${bundle.version} 不一致`)

  const name = `ModCrafting-Offline-${releaseTag}`
  const staging = path.join(output, `.staging-${process.pid}`)
  const target = path.join(staging, name)
  await rm(staging, { recursive: true, force: true })
  await mkdir(target, { recursive: true })

  await cp(path.join(cliSource, 'bin'), path.join(target, 'cli', 'bin'), { recursive: true })
  await cp(path.join(cliSource, 'lib'), path.join(target, 'cli', 'lib'), { recursive: true })
  await writeFile(path.join(target, 'cli', 'package.json'), `${JSON.stringify({
    name: 'modcrafting',
    version: bundle.version,
    private: true,
    type: 'module',
    bin: { modcrafting: './bin/modcrafting.mjs' }
  }, null, 2)}\n`)
  await cp(bundleDir, path.join(target, 'bundle'), { recursive: true })
  await cp(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'))
  await cp(path.join(root, 'docs/install.md'), path.join(target, 'README.md'))
  await writeFile(path.join(target, 'PROMPT.md'), prompt(bundle.version))
  await writeFile(path.join(target, 'install.cmd'), INSTALL_CMD.replace(/\n/g, '\r\n'))
  await writeFile(path.join(target, 'install.sh'), INSTALL_SH)

  const zip = path.join(output, `${name}.zip`)
  await rm(zip, { force: true })
  const packed = zipDirectory(staging, zip)
  await rm(staging, { recursive: true, force: true })
  return {
    ok: true,
    version: bundle.version,
    tag: releaseTag,
    directory: path.dirname(zip),
    file: zip,
    filename: path.basename(zip),
    bytes: packed.bytes,
    files: packed.files,
    sha256: sha256(readFileSync(zip)),
    entry: { windows: 'install.cmd', posix: 'install.sh', agent: 'PROMPT.md' }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tag: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: release:offline [--tag vX.Y.Z] [--output DIR]. Builds the self-contained offline ZIP; never uploads.')
  else console.log(JSON.stringify(await packageOffline({ tag: values.tag, output: values.output ? path.resolve(values.output) : undefined })))
}
