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
// Runtime JDK, Gradle and Fabric caches are intentionally downloaded on first
// launch into the edition-specific runtime directory. Do not create a JRE,
// Gradle/Fabric seed or any Gitee shards while building a release.
nodeScript('scripts/packaging/setup-nsisbi.mjs', 'setup nsisbi')
nodeScript('scripts/packaging/patch-nsis-install-ui.mjs', 'patch nsis install ui')
tryKnowledgeDownload()
