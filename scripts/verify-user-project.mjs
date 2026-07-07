/**
 * Simulates ensureProjectToolchain + gradlew build for a user project.
 * Run: node scripts/verify-user-project.mjs [projectPath]
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(scriptDir, '..')
const projectPath = process.argv[2] || 'D:\\project_file\\mc\\temp'
const runtimeRoot = path.join(root, 'runtime')
const jdkSrc = path.join(root, 'resources', 'jdk-21')
const gradleSrc = path.join(root, 'resources', 'gradle-9.5')
const GRADLE_RUNTIME_DIR = 'gradle-9.5'
const GRADLE_LAUNCHER = 'gradle-launcher-9.5.0.jar'

async function setup() {
  mkdirSync(runtimeRoot, { recursive: true })
  const jdkDest = path.join(runtimeRoot, 'jdk-21')
  const gradleDest = path.join(runtimeRoot, GRADLE_RUNTIME_DIR)
  if (!existsSync(jdkDest) && existsSync(jdkSrc)) cpSync(jdkSrc, jdkDest, { recursive: true })
  if (!existsSync(gradleDest) && existsSync(gradleSrc)) cpSync(gradleSrc, gradleDest, { recursive: true })

  const modGradle = path.join(projectPath, '.modcrafting', GRADLE_RUNTIME_DIR)
  if (existsSync(gradleDest)) {
    mkdirSync(path.join(projectPath, '.modcrafting'), { recursive: true })
    if (existsSync(modGradle)) rmSync(modGradle, { recursive: true })
    cpSync(gradleDest, modGradle, { recursive: true })
  }
  const legacy = path.join(projectPath, '.modcrafting', 'gradle-8.11')
  if (existsSync(legacy)) {
    try { rmSync(legacy, { recursive: true }) } catch { /* may be locked by daemon */ }
  }

  writeFileSync(path.join(projectPath, 'gradle', 'wrapper', 'gradle-wrapper.properties'), `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-9.5.0-bin.zip
networkTimeout=120000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`, 'utf-8')

  const bat = `@echo off
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set "MODCRAFTING_RUNTIME=${runtimeRoot.replace(/\\/g, '\\\\')}"
set "JAVA_HOME=%MODCRAFTING_RUNTIME%\\jdk-21"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${GRADLE_RUNTIME_DIR}"
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`
  writeFileSync(path.join(projectPath, 'gradlew.bat'), bat, 'utf-8')
  console.log('Runtime:', runtimeRoot)
}

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', '.\\gradlew.bat', 'build', '--no-daemon'], {
      cwd: projectPath,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: path.join(runtimeRoot, 'gradle-home'),
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      }
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    child.on('close', (code) => resolve({ code, out }))
  })
}

await setup()
const launcher = path.join(projectPath, '.modcrafting', GRADLE_RUNTIME_DIR, 'lib', GRADLE_LAUNCHER)
if (!existsSync(launcher)) {
  console.error('FAIL: missing', launcher, '- run npm run setup:toolchain first')
  process.exit(1)
}
console.log('Running gradlew build...')
const result = await runBuild()
console.log('\n---')
console.log('Exit code:', result.code)
console.log('Loom/Gradle API mismatch:', result.out.includes('org.gradle.plugin.api-version') ? 'YES' : 'no')
process.exit(result.code === 0 ? 0 : 1)
