#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const versions = JSON.parse(readFileSync(path.join(root, 'resources', 'fabric-versions.json'), 'utf8'))
const seedRoot = path.join(root, 'resources', 'gradle-home-seed', 'caches', 'fabric-loom', 'minecraftMaven')
const outputPath = path.join(root, 'resources', `fabric-symbol-index-${versions.minecraft_version}.json.gz`)

function walk(dir, predicate, result = []) {
  if (!existsSync(dir)) return result
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, predicate, result)
    else if (predicate(full, entry.name)) result.push(full)
  }
  return result
}

function findNamedJar(prefix) {
  const matches = walk(seedRoot, (_full, name) =>
    name.startsWith(`${prefix}-`) && name.endsWith('.jar') && !name.includes('intermediary'))
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function findJarTool() {
  const candidates = [
    path.join(root, 'resources', 'jdk-21', 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar'),
    path.join(root, 'resources', '_prefetch_runtime', 'jdk-21', 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar'),
    'jar'
  ]
  return candidates.find((candidate) => candidate === 'jar' || existsSync(candidate))
}

function findJavapTool() {
  const candidates = [
    path.join(root, 'resources', 'jdk-21', 'bin', process.platform === 'win32' ? 'javap.exe' : 'javap'),
    path.join(root, 'resources', '_prefetch_runtime', 'jdk-21', 'bin', process.platform === 'win32' ? 'javap.exe' : 'javap'),
    'javap'
  ]
  return candidates.find((candidate) => candidate === 'javap' || existsSync(candidate))
}

function listClasses(jarTool, jarPath) {
  const output = execFileSync(jarTool, ['tf', jarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return output.split(/\r?\n/)
    .filter((name) => name.startsWith('net/minecraft/') && name.endsWith('.class') && !name.endsWith('module-info.class'))
    .map((name) => name.slice(0, -6).replaceAll('/', '.'))
}

function parseJavap(output, side, records) {
  let current = null
  let pending = null
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const classMatch = line.match(/(?:class|interface|enum|record)\s+([\w.$]+)(?:\s|\{|<|extends|implements)/)
    if (classMatch && classMatch[1].startsWith('net.minecraft.')) {
      const name = classMatch[1]
      current = records.get(name) || { name, side, fields: [], methods: [] }
      if (current.side !== 'common') current.side = side
      records.set(name, current)
      pending = null
      continue
    }
    if (!current) continue
    if (line === '}') {
      current = null
      pending = null
      continue
    }
    if (line.startsWith('descriptor:') && pending) {
      const descriptor = line.slice('descriptor:'.length).trim()
      const bucket = pending.kind === 'method' ? current.methods : current.fields
      if (!bucket.some((entry) => entry.name === pending.name && entry.descriptor === descriptor)) {
        bucket.push({ name: pending.name, descriptor, static: pending.static })
      }
      pending = null
      continue
    }
    if (!line.endsWith(';') || line.startsWith('descriptor:')) continue
    const isStatic = /\bstatic\b/.test(line)
    const methodMatch = line.match(/([\w$]+)\([^;]*\);$/)
    if (methodMatch) {
      const simpleClass = current.name.split('.').pop()?.split('$').pop()
      if (methodMatch[1] !== simpleClass) {
        pending = { kind: 'method', name: methodMatch[1], static: isStatic }
      }
      continue
    }
    const fieldMatch = line.match(/([\w$]+);$/)
    if (fieldMatch) pending = { kind: 'field', name: fieldMatch[1], static: isStatic }
  }
}

function indexJar(javapTool, jarPath, side, records) {
  const classes = listClasses(findJarTool(), jarPath)
  const batchSize = process.platform === 'win32' ? 40 : 120
  for (let i = 0; i < classes.length; i += batchSize) {
    const batch = classes.slice(i, i + batchSize)
    try {
      const output = execFileSync(javapTool, ['-p', '-s', '-classpath', jarPath, ...batch], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      })
      parseJavap(output, side, records)
    } catch (error) {
      const stdout = error?.stdout ? String(error.stdout) : ''
      if (stdout) parseJavap(stdout, side, records)
    }
    if (i % (batchSize * 10) === 0) {
      console.log(`[fabric-index] ${side}: ${Math.min(i + batchSize, classes.length)}/${classes.length}`)
    }
  }
}

function main() {
  const commonJar = findNamedJar('minecraft-common')
  const clientJar = findNamedJar('minecraft-clientonly')
  const javapTool = findJavapTool()
  if (!commonJar || !clientJar) throw new Error('Named Minecraft JARs are missing; run npm run prefetch:deps first')
  if (!javapTool) throw new Error('JDK javap is missing; run npm run setup:toolchain first')

  if (!process.argv.includes('--force') && existsSync(outputPath)) {
    try {
      const current = JSON.parse(gunzipSync(readFileSync(outputPath)).toString('utf8'))
      const newestInput = Math.max(statSync(commonJar).mtimeMs, statSync(clientJar).mtimeMs, statSync(path.join(root, 'resources', 'fabric-versions.json')).mtimeMs)
      if (
        statSync(outputPath).mtimeMs >= newestInput &&
        current.minecraftVersion === versions.minecraft_version &&
        current.yarnMappings === versions.yarn_mappings &&
        Array.isArray(current.classes) && current.classes.length > 1000
      ) {
        console.log(`[fabric-index] up to date: ${outputPath}`)
        return
      }
    } catch {
      // Regenerate invalid/corrupt index.
    }
  }

  const records = new Map()
  indexJar(javapTool, commonJar, 'common', records)
  indexJar(javapTool, clientJar, 'client', records)

  const payload = {
    format: 1,
    minecraftVersion: versions.minecraft_version,
    yarnMappings: versions.yarn_mappings,
    generatedAt: new Date().toISOString(),
    classes: [...records.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }))
  console.log(`[fabric-index] wrote ${payload.classes.length} classes to ${outputPath}`)
}

main()
