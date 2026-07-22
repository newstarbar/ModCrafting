#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const files = readdirSync(testDir)
  .filter((name) => name.startsWith('harness-') && name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(testDir, name))

if (files.length === 0) {
  console.error('No harness test files found in', testDir)
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...files],
  { stdio: 'inherit', cwd: path.join(testDir, '..', '..') }
)

process.exit(result.status ?? 1)
