#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const files = execSync('git ls-tree --name-only HEAD scripts/', { encoding: 'utf8', cwd: root })
  .split(/\r?\n/)
  .filter((f) => /scripts\/harness-.*\.test\.ts$/.test(f))

for (const f of files) {
  const name = path.basename(f)
  let content = execSync(`git show HEAD:${f}`, { encoding: 'utf8', cwd: root })
  content = content.replaceAll("'../src/", "'../../src/")
  writeFileSync(path.join(root, 'scripts/test', name), content, 'utf8')
}

console.log(`Restored ${files.length} harness test files`)
