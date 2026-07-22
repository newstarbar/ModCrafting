#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'full'

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

if (target === 'portable') {
  nodeScript('scripts/assets/generate-icon-ico.mjs', 'generate icons')
  nodeScript('scripts/packaging/verify-portable-resources.mjs', 'verify portable resources')
  process.exit(0)
}

nodeScript('scripts/assets/generate-icon-ico.mjs', 'generate icons')
nodeScript('scripts/assets/generate-installer-assets.mjs', 'generate installer assets')
npm('assets:prepare', 'prepare renderer assets')
nodeScript('scripts/toolchain/setup-toolchain.mjs', 'setup toolchain')
nodeScript('scripts/toolchain/prefetch-fabric-deps.mjs', 'prefetch fabric deps')
npm('toolchain:symbol-index', 'generate fabric symbol index')
nodeScript('scripts/toolchain/prepare-seed-for-packaging.mjs', 'prepare seed for packaging')
nodeScript('scripts/toolchain/archive-gradle-home-seed.mjs', 'archive gradle home seed')
nodeScript('scripts/packaging/setup-nsisbi.mjs', 'setup nsisbi')
nodeScript('scripts/packaging/patch-nsis-install-ui.mjs', 'patch nsis install ui')
