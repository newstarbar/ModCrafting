#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const all = process.argv.includes('--all')

const removable = [
  'release',
  'release2',
  'out',
  'packaging/nsisbi',
  'packaging/nsisbi-electronbuilder-3.10.3.7z'
]

if (all) {
  removable.push('temp/minecraft-assets-26.1.2', 'temp/logs', 'temp/opencode-eval', 'temp/docx')
}

for (const rel of removable) {
  const abs = path.join(root, rel)
  if (!existsSync(abs)) continue
  rmSync(abs, { recursive: true, force: true })
  console.log('Removed', rel)
}

console.log('Local cleanup done (runtime/ and resources/ toolchain preserved).')
