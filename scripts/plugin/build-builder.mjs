#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { offline: { type: 'boolean' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: builder:build [--offline]. Requires JAVA_HOME=JDK21 and the repository Gradle wrapper. Builds builder-mod only; no game launch, publish or install.')
  process.exit(0)
}
const javaHome = process.env.JAVA_HOME
if (!javaHome || !path.isAbsolute(javaHome)) throw Error('Set absolute JAVA_HOME to a system JDK 21 before building the builder mod')
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
const checked = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true })
if (checked.status !== 0 || !/version "21\./.test(checked.stderr + checked.stdout)) throw Error('JAVA_HOME must provide JDK 21')
if (process.platform !== 'win32') throw Error('Builder candidate build currently supports Windows x64 only')
const directory = path.join(root, 'builder-mod')
const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '.\\gradlew.bat', 'build', '--no-daemon', ...(values.offline ? ['--offline'] : [])], { cwd: directory, env: process.env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
if (result.error || result.status !== 0) {
  process.stderr.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  throw Error(`builder-mod build failed: ${result.error?.message || `exit ${result.status}`}`)
}
const properties = readFileSync(path.join(directory, 'gradle.properties'), 'utf8')
const version = properties.match(/^mod_version=([\w.+-]+)$/m)?.[1]
const name = properties.match(/^archives_base_name=([\w-]+)$/m)?.[1]
if (!version || !name) throw Error('Invalid builder artifact identity')
const jar = path.join(directory, 'build', 'libs', `${name}-${version}.jar`)
const sources = path.join(directory, 'build', 'libs', `${name}-${version}-sources.jar`)
if (!existsSync(jar) || !existsSync(sources)) throw Error('Builder build did not produce runtime and source jars')
const sha256 = createHash('sha256').update(readFileSync(jar)).digest('hex')
console.log(JSON.stringify({ ok: true, jar, sources, version, sha256, offlineGradle: Boolean(values.offline) }))
