import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { GRADLE_LAUNCHER_JAR, GRADLE_RUNTIME_FOLDER } from './toolchain-download'

type FabricVersions = {
  minecraft_version: string
  loader_version: string
  fabric_version: string
  yarn_mappings: string
  loom_version: string
  gradle_version: string
}

export type PrefetchProgressPayload = {
  phase: 'checking' | 'jdk' | 'gradle' | 'deps' | 'project' | 'ready' | 'error'
  message: string
  percent: number
  error?: string
}

type ProgressSender = (input: string | PrefetchProgressPayload) => void

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function writeGradlewBat(projectDir: string, runtimeRoot: string): void {
  const rt = runtimeRoot.replace(/\\/g, '\\\\')
  const content = `@echo off
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set "MODCRAFTING_RUNTIME=${rt}"
set "JAVA_HOME=%MODCRAFTING_RUNTIME%\\jdk-21"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${GRADLE_RUNTIME_FOLDER}"
"%JAVA_HOME%\\bin\\java" -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER_JAR}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`
  fs.writeFileSync(path.join(projectDir, 'gradlew.bat'), content, 'utf-8')
}

function setupPrefetchProject(
  projectDir: string,
  runtimeRoot: string,
  gradleSrc: string,
  wrapperJar: string,
  v: FabricVersions
): void {
  const projectName = 'prefetch-mod'
  const groupId = 'com.example'
  const pkg = projectName.replace(/-/g, '_')
  const modId = projectName
  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${pkg}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${pkg}`

  if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true })

  fs.mkdirSync(path.join(projectDir, javaPath), { recursive: true })
  fs.mkdirSync(path.join(projectDir, clientJavaPath), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'src/main/resources'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'src/client/resources'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'gradle/wrapper'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, '.modcrafting'), { recursive: true })

  const buildGradle = `plugins { id 'fabric-loom' version '${v.loom_version}'; id 'maven-publish' }
version = project.mod_version; group = "${groupId}"
base { archivesName = "${projectName}" }
repositories { mavenCentral() }
loom { splitEnvironmentSourceSets()
  mods { "${modId}" { sourceSet sourceSets.main; sourceSet sourceSets.client } } }
dependencies {
  minecraft "com.mojang:minecraft:\${project.minecraft_version}"
  mappings "net.fabricmc:yarn:\${project.yarn_mappings}:v2"
  modImplementation "net.fabricmc:fabric-loader:\${project.loader_version}"
  modImplementation "net.fabricmc.fabric-api:fabric-api:\${project.fabric_version}" }
processResources { filesMatching("fabric.mod.json") { expand "version": project.version } }
tasks.withType(JavaCompile).configureEach { it.options.encoding = "UTF-8"; it.options.release = 21 }
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }`

  const settingsGradle = `pluginManagement {
  repositories {
    maven { name = 'Fabric'; url = uri('https://maven.fabricmc.net/') }
    mavenCentral()
    gradlePluginPortal()
  }
}
rootProject.name = "${projectName}"
`

  const gradleProperties = `minecraft_version=${v.minecraft_version}
loader_version=${v.loader_version}
fabric_version=${v.fabric_version}
yarn_mappings=${v.yarn_mappings}
mod_version=1.0.0
maven_group=com.example
java_version=21
`

  const fabricModJson = JSON.stringify({
    schemaVersion: 1,
    id: modId,
    version: '1.0.0',
    name: 'Prefetch Mod',
    description: 'ModCrafting prefetch',
    authors: ['ModCrafting'],
    license: 'MIT',
    environment: '*',
    entrypoints: {
      main: [`${groupId}.${pkg}.${capitalize(pkg)}`],
      client: [`${groupId}.${pkg}.${capitalize(pkg)}Client`]
    },
    depends: { fabricloader: `>=${v.loader_version}`, minecraft: '~1.21.4', java: '>=21' }
  }, null, 2)

  const mainJava = `package ${groupId}.${pkg};
import net.fabricmc.api.ModInitializer;
public class ${capitalize(pkg)} implements ModInitializer {
  @Override public void onInitialize() {}
}
`

  const clientJava = `package ${groupId}.${pkg};
import net.fabricmc.api.ClientModInitializer;
public class ${capitalize(pkg)}Client implements ClientModInitializer {
  @Override public void onInitializeClient() {}
}
`

  const wrapperProps = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-${v.gradle_version}-bin.zip
networkTimeout=120000
validateDistributionUrl=false
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`

  fs.writeFileSync(path.join(projectDir, 'build.gradle'), buildGradle, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'settings.gradle'), settingsGradle, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'gradle.properties'), gradleProperties, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'src/main/resources/fabric.mod.json'), fabricModJson, 'utf-8')
  fs.writeFileSync(path.join(projectDir, `${javaPath}/${capitalize(pkg)}.java`), mainJava, 'utf-8')
  fs.writeFileSync(path.join(projectDir, `${clientJavaPath}/${capitalize(pkg)}Client.java`), clientJava, 'utf-8')
  fs.writeFileSync(path.join(projectDir, 'gradle/wrapper/gradle-wrapper.properties'), wrapperProps, 'utf-8')

  writeGradlewBat(projectDir, runtimeRoot)

  if (fs.existsSync(wrapperJar)) {
    fs.cpSync(wrapperJar, path.join(projectDir, 'gradle/wrapper/gradle-wrapper.jar'))
  }
  if (fs.existsSync(gradleSrc)) {
    fs.cpSync(gradleSrc, path.join(projectDir, '.modcrafting', GRADLE_RUNTIME_FOLDER), { recursive: true })
  }
}

function runGradle(
  cwd: string,
  runtimeRoot: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd', ['/c', 'gradlew.bat', ...args], {
      cwd,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: path.join(runtimeRoot, 'gradle-home'),
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')};${process.env.PATH || ''}`
      },
      shell: true
    })
    let timer: NodeJS.Timeout | undefined
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error(`Gradle timed out: ${args.join(' ')}`))
      }, timeoutMs)
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Gradle exited ${code}: ${args.join(' ')}`))
    })
  })
}

export async function ensureGradleHomeOnline(
  runtimeRoot: string,
  gradleRuntimePath: string,
  wrapperJarPath: string,
  gradleHomePath: string,
  fabricVersions: FabricVersions,
  isReady: () => boolean,
  writeSeedMarker: () => void,
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  if (isReady()) {
    onProgress({ phase: 'deps', message: 'Fabric 依赖缓存已就绪', percent: 100 })
    return { ok: true }
  }

  onProgress({
    phase: 'deps',
    message: '正在联网下载 Fabric 依赖（首次约 1GB，请保持网络畅通）…',
    percent: 40
  })

  const projectDir = path.join(runtimeRoot, '_prefetch_project')
  try {
    setupPrefetchProject(projectDir, runtimeRoot, gradleRuntimePath, wrapperJarPath, fabricVersions)
    fs.mkdirSync(gradleHomePath, { recursive: true })

    onProgress({ phase: 'deps', message: '正在拉取 Fabric 构建依赖…', percent: 50 })
    await runGradle(projectDir, runtimeRoot, ['build', '--refresh-dependencies', '--no-daemon'], 30 * 60 * 1000)

    onProgress({ phase: 'deps', message: '正在拉取游戏资源…', percent: 75 })
    try {
      await runGradle(projectDir, runtimeRoot, ['downloadAssets', '--no-daemon'], 15 * 60 * 1000)
    } catch {
      /* optional */
    }

    writeSeedMarker()

    if (!isReady()) {
      return { ok: false, error: 'Fabric 依赖下载后校验失败，请检查网络后重试' }
    }

    onProgress({ phase: 'deps', message: 'Fabric 依赖已就绪', percent: 95 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `联网下载 Fabric 依赖失败: ${String(err)}` }
  }
}
