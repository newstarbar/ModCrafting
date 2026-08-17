#!/usr/bin/env node
import { build } from '../../node_modules/electron-vite/node_modules/esbuild/lib/main.js'
import { copyFile, mkdir, rm, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const plugin = path.join(root, 'plugins', 'modcrafting-fabric')
const dist = path.join(plugin, 'dist')
const temporaryOutput = path.join(dist, 'mcp-server.bundle.mjs')
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
const bundled = await build({
  entryPoints: [path.join(plugin, 'src', 'mcp-server.ts')],
  outfile: temporaryOutput,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  legalComments: 'none',
  write: false
})
await writeFile(temporaryOutput, bundled.outputFiles[0].contents)
await rm(path.join(dist, 'mcp-server.js'), { force: true })
await rename(temporaryOutput, path.join(dist, 'mcp-server.js'))
await copyFile(path.join(root, 'packaging', 'appIcon.png'), path.join(plugin, 'assets', 'modcrafting.png'))
console.log(`Built self-contained ModCrafting Fabric MCP: ${path.relative(root, path.join(dist, 'mcp-server.js'))}`)
