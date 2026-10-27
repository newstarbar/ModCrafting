#!/usr/bin/env node
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { builtinModules } from 'node:module'
import unzipper from 'unzipper'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const plugin = path.join(root, 'plugins', 'modcrafting-fabric')
const dist = path.join(plugin, 'dist')
const manifest = JSON.parse(await readFile(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'))
const { values } = parseArgs({ options: { 'observer-jar': { type: 'string' }, 'builder-jar': { type: 'string' } } })
let observer = null
let builder = null
if (values['observer-jar']) {
  const bytes = await readFile(path.resolve(values['observer-jar']))
  // Reuse the product-stage compatibility check; do not infer compatibility from the filename.
  const archive = await unzipper.Open.buffer(bytes)
  const metadata = archive.files.find(file => file.path === 'fabric.mod.json')
  if (!metadata) throw Error('Observer has no fabric.mod.json')
  const mod = JSON.parse((await metadata.buffer()).toString('utf8'))
  if (mod.id !== 'modcrafting_observer' || mod.custom?.modcrafting?.observerProtocol !== 2 || mod.depends?.minecraft !== '~1.21.4') throw Error('Observer must declare protocol 2 and Minecraft 1.21.4')
  for (const route of ['/v2/capabilities', '/v2/test-preparation', '/v2/snapshot', '/v2/command', '/v1/screenshot']) {
    const classes = archive.files.filter(file => file.path.endsWith('.class'))
    if (!(await Promise.all(classes.map(file => file.buffer()))).some(value => value.includes(Buffer.from(route)))) throw Error(`Observer is missing ${route}`)
  }
  observer = { jarBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), version: mod.version, protocol: 2 }
}
if (values['builder-jar']) {
  const bytes = await readFile(path.resolve(values['builder-jar']))
  const archive = await unzipper.Open.buffer(bytes)
  const metadata = archive.files.find(file => file.path === 'fabric.mod.json')
  if (!metadata) throw Error('Builder has no fabric.mod.json')
  const mod = JSON.parse((await metadata.buffer()).toString('utf8'))
  if (mod.id !== 'modcrafting_builder' || mod.custom?.modcrafting?.builderProtocol !== 1 || mod.custom?.modcrafting?.studioDimension !== 'modcrafting_builder:studio' || mod.depends?.minecraft !== '~1.21.4') throw Error('Builder must declare protocol 1, the studio dimension and Minecraft 1.21.4')
  for (const route of ['/v1/studio/status', '/v1/studio/open', '/v1/studio/commit', '/v1/studio/apply']) {
    const classes = archive.files.filter(file => file.path.endsWith('.class'))
    if (!(await Promise.all(classes.map(file => file.buffer()))).some(value => value.includes(Buffer.from(route)))) throw Error(`Builder is missing ${route}`)
  }
  builder = { jarBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), version: mod.version, protocol: 1 }
}
const wrapper = { batch: (await readFile(path.join(root, 'bridge-mod/gradlew.bat'), 'utf8')).replace(/\r?\n/g, '\r\n'), properties: (await readFile(path.join(root, 'bridge-mod/gradle/wrapper/gradle-wrapper.properties'), 'utf8')).replace(/\r\n/g, '\n'), jarBase64: (await readFile(path.join(root, 'bridge-mod/gradle/wrapper/gradle-wrapper.jar'))).toString('base64') }
await mkdir(dist, { recursive: true })
// Embed the optional React view in the existing self-contained entry; Stage stays nine files.
const view = await build({ entryPoints: [path.join(root, 'packages/modcrafting-view/src/main.tsx')], absWorkingDir: root, bundle: true, platform: 'browser', format: 'esm', target: 'es2023', jsx: 'automatic', minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, write: false, metafile: true })
if (Object.values(view.metafile.outputs).some((output) => output.imports.some((entry) => entry.external))) throw Error('Browser view has an external runtime dependency')
const webAssets = {
  html: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ModCrafting · Fabric 工作台</title><link rel="stylesheet" href="/view.css"></head><body><div id="root"></div><script type="module" src="/view.js"></script></body></html>',
  js: view.outputFiles[0].text,
  css: (await readFile(path.join(root, 'packages/modcrafting-view/src/view.css'), 'utf8')).replace(/\r\n/g, '\n')
}
const bundled = await build({
  entryPoints: [path.join(plugin, 'src', 'mcp-server.ts')],
  absWorkingDir: root,
  outfile: path.join(dist, 'mcp-server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'eof',
  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version), __WEB_ASSETS__: JSON.stringify(webAssets), __PROJECT_WRAPPER__: JSON.stringify(wrapper), __OBSERVER__: JSON.stringify(observer), __BUILDER__: JSON.stringify(builder) },
  metafile: true,
  write: false
})
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
for (const output of Object.values(bundled.metafile.outputs)) {
  if (output.imports.some((entry) => entry.external && !nodeBuiltins.has(entry.path))) throw new Error('Bundle has a non-builtin external dependency')
}
await writeFile(path.join(dist, 'mcp-server.js'), bundled.outputFiles[0].contents)
await writeFile(path.join(plugin, 'compatibility.json'), JSON.stringify({ contractVersion: 1, version: manifest.version, minecraft: '1.21.4', observer: observer ? { version: observer.version, protocol: observer.protocol, sha256: observer.sha256 } : null, builder: builder ? { version: builder.version, protocol: builder.protocol, sha256: builder.sha256 } : null, coreBundleSha256: createHash('sha256').update(bundled.outputFiles[0].contents).digest('hex') }, null, 2) + '\n')
const licenses = new Map()
for (const input of [...Object.keys(bundled.metafile.inputs), ...Object.keys(view.metafile.inputs)].filter((file) => file.replace(/\\/g, '/').includes('node_modules/'))) {
  let directory = path.dirname(path.resolve(root, input))
  while (directory !== root && path.dirname(directory) !== directory) {
    const metadata = path.join(directory, 'package.json')
    if (existsSync(metadata)) {
      const pkg = JSON.parse(await readFile(metadata, 'utf8'))
      if (pkg.name && pkg.version) {
        const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map((name) => path.join(directory, name)).find(existsSync)
        if (!license) throw new Error(`Bundled package license missing: ${pkg.name}`)
        licenses.set(`${pkg.name}@${pkg.version}`, await readFile(license, 'utf8'))
        break
      }
    }
    directory = path.dirname(directory)
  }
}
licenses.set('Gradle Wrapper (Apache-2.0)', await readFile(path.join(root, 'bridge-mod/gradle/wrapper/LICENSE'), 'utf8'))
if (observer) licenses.set('ModCrafting Observer (MIT)', await readFile(path.join(root, 'bridge-mod/LICENSE'), 'utf8'))
if (builder) licenses.set('ModCrafting Builder (MIT)', await readFile(path.join(root, 'builder-mod/LICENSE'), 'utf8'))
await writeFile(path.join(plugin, 'THIRD_PARTY_NOTICES.txt'), [...licenses].map(([name, license]) => `${name}\n${license}`).join('\n\n'))
await mkdir(path.join(plugin, 'assets'), { recursive: true })
await copyFile(path.join(plugin, 'modcrafting.png'), path.join(plugin, 'assets', 'modcrafting.png'))
console.log(`Built self-contained ModCrafting Fabric MCP: ${path.relative(root, path.join(dist, 'mcp-server.js'))}`)
