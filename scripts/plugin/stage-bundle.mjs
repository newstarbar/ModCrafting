#!/usr/bin/env node
/**
 * Produce the single runtime contract consumed by every installer channel:
 * a directory with the self-contained MCP bundle, its skills and `bundle.json`.
 *
 * Input is the already-validated plugin stage, never the source tree, so a
 * half-built or private file can never leak into a published bundle.
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { validatePlugin } from './validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const source = path.join(root, 'temp/plugin-artifacts/modcrafting-fabric')
const destination = path.join(root, 'temp/bundle-artifacts/modcrafting-bundle')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const FILES = ['dist/mcp-server.js', 'assets/modcrafting.png', 'compatibility.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md']

async function walk(directory, prefix = '') {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) result.push(...await walk(path.join(directory, entry.name), `${relative}/`))
    else if (entry.isFile()) result.push(relative)
    else throw new Error(`bundle 输入含特殊文件：${relative}`)
  }
  return result.sort()
}

export async function stageBundle(output = destination) {
  if (!existsSync(source)) throw new Error('BUNDLE_STAGE_MISSING_PLUGIN: run "pnpm run plugin:build && pnpm run plugin:stage" first')
  const { manifest } = validatePlugin(source, true)
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  for (const file of FILES) {
    await mkdir(path.dirname(path.join(output, file)), { recursive: true })
    await copyFile(path.join(source, file), path.join(output, file))
  }
  const skills = (await readdir(path.join(source, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  for (const name of skills) {
    await mkdir(path.join(output, 'skills', name), { recursive: true })
    await copyFile(path.join(source, 'skills', name, 'SKILL.md'), path.join(output, 'skills', name, 'SKILL.md'))
  }
  const files = {}
  for (const file of await walk(output)) files[file] = sha256(await readFile(path.join(output, file)))
  const compatibility = JSON.parse(await readFile(path.join(output, 'compatibility.json'), 'utf8'))
  if (compatibility.version !== manifest.version) throw new Error('compatibility.json 版本与插件清单不一致')
  if (compatibility.coreBundleSha256 !== files['dist/mcp-server.js']) throw new Error('bundle 指纹与 compatibility.json 不一致')
  const bundle = {
    bundleVersion: 1,
    name: 'modcrafting-fabric',
    version: manifest.version,
    minecraft: compatibility.minecraft,
    entry: 'dist/mcp-server.js',
    skills,
    dataPlaceholder: 'MODCRAFTING_DATA',
    files
  }
  await writeFile(path.join(output, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  return { directory: output, version: bundle.version, fileCount: Object.keys(files).length + 1, coreBundleSha256: files['dist/mcp-server.js'], skills }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } })
  if (values.help) console.log('Usage: bundle:stage [--output DIR]. Builds the verified runtime bundle consumed by the installer, npm packages and the offline ZIP.')
  else console.log(JSON.stringify({ ok: true, ...await stageBundle(values.output ? path.resolve(values.output) : undefined) }))
}
