#!/usr/bin/env node
/** Verify minimal resources exist before portable build. */
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const required = [
  'resources/gradle-wrapper.jar',
  'resources/fabric-versions.json',
  'resources/fabric-symbol-index-1.21.4.json.gz',
  'packaging/appIcon.png'
]

const missing = required.filter((rel) => !existsSync(path.join(root, rel)))
if (missing.length > 0) {
  console.error('Portable build missing:', missing.join(', '))
  process.exit(1)
}
console.log('Portable resources OK')
