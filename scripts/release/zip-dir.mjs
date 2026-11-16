#!/usr/bin/env node
/** Deterministic, dependency-free ZIP of a directory (store method). */
import fs from 'node:fs'
import path from 'node:path'
import { createZip } from '../../packages/modcrafting-cli/lib/zip.mjs'

export function zipDirectory(directory, target, { prefix = '' } = {}) {
  const entries = []
  const walk = (current, relative = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name)
      const name = `${relative}${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`打包输入含符号链接：${name}`)
      if (entry.isDirectory()) walk(file, `${name}/`)
      else if (entry.isFile()) entries.push([`${prefix}${name}`, fs.readFileSync(file)])
      else throw new Error(`打包输入含特殊文件：${name}`)
    }
  }
  walk(directory)
  if (!entries.length) throw new Error(`目录为空：${directory}`)
  const buffer = createZip(entries)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buffer, { flag: 'wx' })
  return { file: target, bytes: buffer.length, files: entries.length }
}
