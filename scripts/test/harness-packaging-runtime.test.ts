import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const afterPack = fs.readFileSync('scripts/packaging/afterpack-clean-runtime.mjs', 'utf8')
const buildEnv = fs.readFileSync('src/main/build-env.ts', 'utf8')
const prefetch = fs.readFileSync('src/main/portable-prefetch.ts', 'utf8')
const toolchain = fs.readFileSync('src/main/toolchain-download.ts', 'utf8')

test('packaging keeps Electron runtime files and uses canonical artifact names', () => {
  assert.doesNotMatch(afterPack, /filesToDelete|chrome_100_percent\.pak.*rmSync|dxcompiler\.dll.*rmSync/s)
  assert.equal(packageJson.build.nsis.artifactName, '${productName}-Setup-${version}.${ext}')
  assert.match(fs.readFileSync('electron-builder.portable.json', 'utf8'), /\$\{productName\}-\$\{version\}-Portable/)
})

test('toolchain requires a full pinned JDK and no Gitee shard bootstrap', () => {
  assert.match(toolchain, /JDK_VERSION = '21\.0\.12\+8'/)
  assert.match(toolchain, /javac/)
  assert.match(toolchain, /downloadFileResumable/)
  assert.doesNotMatch(buildEnv, /downloadAndExtractSeedShards/)
  assert.doesNotMatch(buildEnv, /downloadAndExtractGradleShards/)
})

test('Fabric warmup verifies assets and an offline build before writing its receipt', () => {
  assert.match(prefetch, /loom_resources_base/)
  assert.match(prefetch, /downloadAssets/)
  assert.match(prefetch, /'build', '--offline', '--no-daemon'/)
  const assetCall = prefetch.indexOf("['downloadAssets'")
  const receipt = prefetch.indexOf('writeSeedMarker()')
  assert.ok(assetCall >= 0 && receipt > assetCall)
  assert.match(buildEnv, /receiptVersion: 1/)
  assert.match(buildEnv, /isEnvironmentReady/)
})
