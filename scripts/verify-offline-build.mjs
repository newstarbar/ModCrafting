/**
 * Verifies offline Gradle build using bundled gradle-home-seed.
 * Run: node scripts/verify-offline-build.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { setupPrefetchProject, generateGradleWrapperProperties } from './fabric-template.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(scriptDir, '..')
const runtimeRoot = path.join(root, 'runtime')
const seedSrc = path.join(root, 'resources', 'gradle-home-seed')
const seedMarker = path.join(seedSrc, '.modcrafting-seed.json')
const projectPath = path.join(root, 'resources', '_offline_verify_project')
const jdkSrc = path.join(root, 'resources', 'jdk-21')
const gradleSrc = path.join(root, 'resources', 'gradle-9.5')
const GRADLE_RUNTIME_DIR = 'gradle-9.5'
const GRADLE_LAUNCHER = 'gradle-launcher-9.5.0.jar'

if (!existsSync(seedMarker)) {
  console.error('FAIL: gradle-home-seed missing. Run: npm run prefetch:deps')
  process.exit(1)
}

mkdirSync(runtimeRoot, { recursive: true })
const jdkDest = path.join(runtimeRoot, 'jdk-21')
const gradleDest = path.join(runtimeRoot, GRADLE_RUNTIME_DIR)
const gradleHome = path.join(runtimeRoot, 'gradle-home')

if (!existsSync(jdkDest) && existsSync(jdkSrc)) cpSync(jdkSrc, jdkDest, { recursive: true })
if (!existsSync(gradleDest) && existsSync(gradleSrc)) cpSync(gradleSrc, gradleDest, { recursive: true })
if (existsSync(gradleHome)) rmSync(gradleHome, { recursive: true, force: true })
cpSync(seedSrc, gradleHome, { recursive: true })

await setupPrefetchProject(projectPath, runtimeRoot, gradleSrc)

writeFileSync(
  path.join(projectPath, 'gradle.properties'),
  readFileSync(path.join(projectPath, 'gradle.properties'), 'utf-8') + '\norg.gradle.offline=true\n',
  'utf-8'
)
writeFileSync(path.join(projectPath, 'gradle', 'wrapper', 'gradle-wrapper.properties'), generateGradleWrapperProperties(), 'utf-8')

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

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'gradlew.bat', '--offline', 'build', '--no-daemon'], {
      cwd: projectPath,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: gradleHome,
        ORG_GRADLE_PROJECT_org_gradle_offline: 'true',
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      },
      shell: true
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    child.on('close', (code) => resolve({ code, out }))
  })
}

console.log('Running offline build verification...')
const result = await runBuild()
console.log('\n---')
console.log('Exit code:', result.code)
if (result.out.match(/Could not resolve|No cached version|offline mode/i)) {
  console.log('Offline resolution issue detected in output')
}
process.exit(result.code === 0 ? 0 : 1)
