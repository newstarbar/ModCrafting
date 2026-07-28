#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'full'
const skipKnowledge = process.argv.includes('--skip-knowledge')

function run(cmd, args, label) {
  console.log(`[prebuild] ${label}`)
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function npm(script, label) {
  run('npm', ['run', script], label)
}

function nodeScript(rel, label) {
  run('node', [path.join(root, rel)], label)
}

// 知识库下载失败时仅警告但不中断 prebuild（知识库为可选增强，缺失时 agent 会返回服务不可用提示）
function tryKnowledgeDownload() {
  if (skipKnowledge) {
    console.log('[prebuild] 跳过知识库下载（--skip-knowledge）')
    return
  }
  console.log('[prebuild] download minecraft knowledge bases')
  const result = spawnSync('node', [path.join(root, 'scripts/knowledge/download-knowledge-base.mjs')], {
    stdio: 'inherit',
    cwd: root,
    shell: false
  })
  if (result.status !== 0) {
    console.warn('[prebuild][warn] 知识库下载失败，agent 将在运行时返回"服务不可用"提示。')
    console.warn('[prebuild][warn] 可稍后手动运行 `npm run knowledge:download` 重新下载。')
  }
}

if (target === 'portable') {
  nodeScript('scripts/assets/generate-icon-ico.mjs', 'generate icons')
  nodeScript('scripts/packaging/verify-portable-resources.mjs', 'verify portable resources')
  process.exit(0)
}

nodeScript('scripts/assets/generate-icon-ico.mjs', 'generate icons')
nodeScript('scripts/assets/generate-installer-assets.mjs', 'generate installer assets')
npm('assets:prepare', 'prepare renderer assets')
nodeScript('scripts/toolchain/setup-toolchain.mjs', 'setup toolchain')
nodeScript('scripts/toolchain/strip-gradle-dist.mjs', 'strip gradle dist')
nodeScript('scripts/toolchain/build-jlink-jre.mjs', 'build jlink JRE')
nodeScript('scripts/toolchain/prefetch-fabric-deps.mjs', 'prefetch fabric deps')
npm('toolchain:symbol-index', 'generate fabric symbol index')
nodeScript('scripts/toolchain/prepare-seed-for-packaging.mjs', 'prepare seed for packaging')
nodeScript('scripts/toolchain/archive-gradle-home-seed.mjs', 'archive gradle home seed (tar.xz)')
nodeScript('scripts/release/split-seed-shards.mjs', 'split seed shards')
nodeScript('scripts/packaging/setup-nsisbi.mjs', 'setup nsisbi')
nodeScript('scripts/packaging/patch-nsis-install-ui.mjs', 'patch nsis install ui')
tryKnowledgeDownload()
