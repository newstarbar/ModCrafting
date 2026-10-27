import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { offline: { type: 'boolean' }, help: { type: 'boolean' } } })
if (values.help) { console.log('Usage: candidate:build [--offline]. Requires JAVA_HOME=JDK21 and optionally GRADLE_USER_HOME. Builds MCP/Bench and Observer from this checkout, then stages the complete three-host distribution. No publish/install/account changes.'); process.exit(0) }
const javaHome = process.env.JAVA_HOME
if (!javaHome || !path.isAbsolute(javaHome)) throw Error('Set absolute JAVA_HOME to a system JDK 21 before building a complete candidate')
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
const checked = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true })
if (checked.status !== 0 || !/version "21\./.test(checked.stderr + checked.stdout)) throw Error('JAVA_HOME must provide JDK 21')
const outputRoot = path.join(root, 'temp/candidate-artifacts'); mkdirSync(outputRoot, { recursive: true })
const directory = mkdtempSync(path.join(outputRoot, 'run-'))
function run(label, command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(path.join(directory, `${label}.log`), (result.stdout || '') + (result.stderr || ''), { flag: 'wx' })
  if (result.error || result.status !== 0) throw Error(`${label} failed; see ${path.join(directory, `${label}.log`)}: ${result.error?.message || `exit ${result.status}`}`)
  console.log(`[candidate:build] ${label} passed`)
  return result.stdout
}
const script = (label, file, args = []) => run(label, process.execPath, [path.join(root, file), ...args])
const lastJson = (text) => JSON.parse(text.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).at(-1))
const bench = lastJson(script('bench-build', 'scripts/bench/build.mjs')).outputDirectory
if (process.platform !== 'win32') throw Error('Observer candidate build currently supports Windows x64 only')
const builder = lastJson(script('builder-build', 'scripts/plugin/build-builder.mjs', values.offline ? ['--offline'] : []))
run('observer-build', 'cmd.exe', ['/d', '/s', '/c', '.\\gradlew.bat', 'build', '--no-daemon', ...(values.offline ? ['--offline'] : [])], path.join(root, 'bridge-mod'))
const properties = readFileSync(path.join(root, 'bridge-mod/gradle.properties'), 'utf8')
const version = properties.match(/^mod_version=([\w.+-]+)$/m)?.[1], name = properties.match(/^archives_base_name=([\w-]+)$/m)?.[1]
if (!version || !name) throw Error('Invalid Observer artifact identity')
const observer = path.join(root, 'bridge-mod/build/libs', `${name}-${version}.jar`), sources = path.join(root, 'bridge-mod/build/libs', `${name}-${version}-sources.jar`)
if (!existsSync(observer) || !existsSync(sources)) throw Error('Observer build did not produce runtime and source jars')
script('plugin-build', 'scripts/plugin/build.mjs', ['--observer-jar', observer, '--builder-jar', builder.jar]); script('plugin-stage', 'scripts/plugin/stage.mjs')
const product = lastJson(script('product-stage', 'scripts/plugin/stage-product.mjs', ['--bench-dir', bench, '--observer-jar', observer, '--observer-sources', sources])).directory
const distribution = lastJson(script('host-stage', 'scripts/plugin/stage-hosts.mjs', ['--product-dir', product]))
const result = { ok: true, directory, product, distribution: distribution.directory, coreBundleSha256: distribution.coreBundleSha256, builder: { version: builder.version, sha256: builder.sha256 }, offlineGradle: Boolean(values.offline), sourcePolicy: 'current checkout only; no historical temp artifacts', nativeHostAcceptance: false }
writeFileSync(path.join(directory, 'candidate.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(result))
