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
  phase: 'checking' | 'jdk' | 'gradle' | 'fabric' | 'minecraft' | 'assets' | 'verify' | 'optional' | 'project' | 'ready' | 'degraded' | 'error'
  message: string
  percent: number
  error?: string
  currentItem?: string
  source?: string
  metrics?: { completedBytes?: number; totalBytes?: number; completedItems?: number; totalItems?: number; speedBytesPerSecond?: number; etaSeconds?: number }
}

type ProgressSender = (input: string | PrefetchProgressPayload) => void

let activeGradlePid: number | undefined
let prefetchCancelled = false

// 步骤级标记文件：build 和 downloadAssets 各自独立标记，重启时跳过已完成步骤
const PREFETCH_BUILD_MARKER = '.prefetch-build-done.json'
const PREFETCH_ASSETS_MARKER = '.prefetch-assets-done.json'

function isPrefetchStepDone(gradleHome: string, markerFile: string, expected: FabricVersions): boolean {
  const markerPath = path.join(gradleHome, markerFile)
  if (!fs.existsSync(markerPath)) return false
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Partial<FabricVersions>
    for (const key of Object.keys(expected) as (keyof FabricVersions)[]) {
      if (marker[key] !== expected[key]) return false
    }
    return true
  } catch {
    return false
  }
}

function writePrefetchStepDone(gradleHome: string, markerFile: string, expected: FabricVersions): void {
  try {
    const marker = { ...expected, createdAt: new Date().toISOString() }
    fs.writeFileSync(path.join(gradleHome, markerFile), JSON.stringify(marker, null, 2), 'utf-8')
  } catch { /* best effort */ }
}

/** Stops the complete Gradle process tree. A new initialization reuses .part
 * downloads and the validated cache, so cancellation is safely resumable. */
export function cancelFabricPrefetch(): void {
  prefetchCancelled = true
  if (!activeGradlePid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(activeGradlePid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }
  } catch { /* best effort */ }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function writeGradlewBat(projectDir: string, runtimeRoot: string, jdkPath: string): void {
  // .bat 文件中路径使用单反斜杠，不需要转义
  // chcp 65001 切换控制台编码为 UTF-8，避免中文路径/错误信息乱码
  // jdkPath 可能为 marker 指向的本地 JDK 路径（非 runtimeRoot\jdk-21），需用绝对值
  const content = `@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
set DIRNAME=%~dp0
set "MODCRAFTING_RUNTIME=${runtimeRoot}"
set "JAVA_HOME=${jdkPath}"
set "PATH=%JAVA_HOME%\\bin;%PATH%"
set "GRADLE_USER_HOME=%MODCRAFTING_RUNTIME%\\gradle-home"
set "MC_BUNDLED_GRADLE=%DIRNAME%.modcrafting\\${GRADLE_RUNTIME_FOLDER}"
if not exist "%JAVA_HOME%\\bin\\java.exe" (
  echo [ModCrafting] JAVA_HOME not found: "%JAVA_HOME%"
  echo [ModCrafting] MODCRAFTING_RUNTIME: "%MODCRAFTING_RUNTIME%"
  exit /b 1
)
if not exist "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER_JAR}" (
  echo [ModCrafting] Gradle launcher not found: "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER_JAR}"
  exit /b 1
)
"%JAVA_HOME%\\bin\\java" -Dfile.encoding=UTF-8 -Dorg.gradle.appname=gradlew -classpath "%MC_BUNDLED_GRADLE%\\lib\\${GRADLE_LAUNCHER_JAR}" org.gradle.launcher.GradleMain %*
exit /b !ERRORLEVEL!
`
  fs.writeFileSync(path.join(projectDir, 'gradlew.bat'), content, 'utf-8')
}

function setupPrefetchProject(
  projectDir: string,
  runtimeRoot: string,
  jdkPath: string,
  gradleSrc: string,
  wrapperJar: string,
  v: FabricVersions,
  useDomesticMinecraftMirror: boolean
): void {
  const projectName = 'prefetch-mod'
  const groupId = 'com.example'
  const pkg = projectName.replace(/-/g, '_')
  const modId = projectName
  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${pkg}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${pkg}`

  // projectDir 用唯一时间戳命名（调用方保证），不需要删除。
  // 这里只清理上次遗留的旧 _prefetch_project* 目录（异步删除失败时积累的垃圾）。
  // 清理用 rename + 异步删除策略，避免 EPERM 阻塞主流程。
  try {
    const parent = path.dirname(projectDir)
    const baseName = path.basename(projectDir).replace(/_\d+$/, '')
    for (const entry of fs.readdirSync(parent)) {
      if (entry !== path.basename(projectDir) && entry.startsWith(baseName)) {
        const oldDir = path.join(parent, entry)
        const trashDir = `${oldDir}_trash_${Date.now()}`
        try {
          fs.renameSync(oldDir, trashDir)
          setImmediate(() => {
            fs.promises.rm(trashDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
              .catch(() => { /* 遗留下次清理 */ })
          })
        } catch {
          // rename 失败，尝试直接 rmSync（带重试）
          try {
            fs.rmSync(oldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
          } catch { /* 清理失败不影响主流程 */ }
        }
      }
    }
  } catch { /* 读取目录失败不影响主流程 */ }

  fs.mkdirSync(path.join(projectDir, javaPath), { recursive: true })
  fs.mkdirSync(path.join(projectDir, clientJavaPath), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'src/main/resources'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'src/client/resources'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, 'gradle/wrapper'), { recursive: true })
  fs.mkdirSync(path.join(projectDir, '.modcrafting'), { recursive: true })

  const buildGradle = `plugins { id 'fabric-loom' version '${v.loom_version}'; id 'maven-publish' }
version = project.mod_version; group = "${groupId}"
base { archivesName = "${projectName}" }
ext {
    // Loom reads these documented extension properties before resolving Minecraft.
    // Keep all three in sync: libraries alone does not accelerate the 480MB assets phase.
    loom_libraries_base = "${useDomesticMinecraftMirror ? 'https://bmclapi2.bangbang93.com/maven/' : 'https://libraries.minecraft.net/'}"
    loom_resources_base = "${useDomesticMinecraftMirror ? 'https://bmclapi2.bangbang93.com/assets/' : 'https://resources.download.minecraft.net/'}"
    loom_version_manifests = "${useDomesticMinecraftMirror ? 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json' : 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'}"
    loom_fabric_repository = "https://maven.fabricmc.net/"
}
repositories {
    maven { name = 'AliyunCentral'; url = uri('https://maven.aliyun.com/repository/public') }
    maven { name = 'HuaweiCentral'; url = uri('https://repo.huaweicloud.com/repository/maven/') }
    mavenCentral()
}
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
    exclusiveContent {
      forRepository { maven { name = 'Fabric'; url = uri('https://maven.fabricmc.net/') } }
      filter { includeGroupByRegex("net\\\\.fabricmc(\\\\..*)?|fabric-loom") }
    }
    maven { name = 'AliyunGradlePlugin'; url = uri('https://maven.aliyun.com/repository/gradle-plugin') }
    maven { name = 'AliyunCentral'; url = uri('https://maven.aliyun.com/repository/public') }
    maven { name = 'HuaweiCentral'; url = uri('https://repo.huaweicloud.com/repository/maven/') }
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
org.gradle.parallel=true
org.gradle.caching=true
org.gradle.workers.max=4
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

  writeGradlewBat(projectDir, runtimeRoot, jdkPath)

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
  jdkPath: string,
  args: string[],
  timeoutMs: number,
  onOutput?: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (prefetchCancelled) {
      prefetchCancelled = false
      reject(new Error('Environment initialization cancelled by user'))
      return
    }
    const child = spawn('cmd', ['/c', '.\\gradlew.bat', '--console=plain', ...args], {
      cwd,
      env: {
        ...process.env,
        MODCRAFTING_RUNTIME: runtimeRoot,
        JAVA_HOME: jdkPath,
        GRADLE_USER_HOME: path.join(runtimeRoot, 'gradle-home'),
        PATH: `${path.join(jdkPath, 'bin')};${process.env.PATH || ''}`
      }
    })
    activeGradlePid = child.pid
    // 收集完整输出用于失败诊断（Gradle 退出码非 0 时写入 gradle-prefetch.log）
    const fullOutput: string[] = []
    // 转发 Gradle 输出（--console=plain 下下载行为一行一条，可解析为进度）
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        fullOutput.push(trimmed)
        onOutput?.(trimmed)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    let timer: NodeJS.Timeout | undefined
    const stopTree = (): void => {
      try {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else child.kill('SIGTERM')
      } catch { /* ignore */ }
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stopTree()
        reject(new Error(`Gradle timed out: ${args.join(' ')}`))
      }, timeoutMs)
    }
    child.on('error', (err) => {
      activeGradlePid = undefined
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      activeGradlePid = undefined
      if (timer) clearTimeout(timer)
      if (prefetchCancelled) {
        prefetchCancelled = false
        reject(new Error('Environment initialization cancelled by user'))
        return
      }
      if (code === 0) resolve()
      else {
        // 失败时把完整输出写入诊断日志，并在 error message 附加最后 30 行
        // 便于 environment.log 和 UI 显示实际错误（而非仅 "Gradle exited 1"）
        try {
          const logsDir = path.join(runtimeRoot, 'logs')
          fs.mkdirSync(logsDir, { recursive: true })
          fs.appendFileSync(
            path.join(logsDir, 'gradle-prefetch.log'),
            `\n=== [${new Date().toISOString()}] gradle ${args.join(' ')} exited ${code} ===\n${fullOutput.join('\n')}\n`,
            'utf-8'
          )
        } catch { /* best effort */ }
        const tail = fullOutput.slice(-30).join('\n')
        reject(new Error(`Gradle exited ${code}: ${args.join(' ')}\n${tail}`))
      }
    })
  })
}

export async function ensureGradleHomeOnline(
  runtimeRoot: string,
  jdkPath: string,
  gradleRuntimePath: string,
  wrapperJarPath: string,
  gradleHomePath: string,
  fabricVersions: FabricVersions,
  isReady: () => boolean,
  writeSeedMarker: () => void,
  onProgress: ProgressSender
): Promise<{ ok: boolean; error?: string }> {
  prefetchCancelled = false
  if (isReady()) {
    onProgress({ phase: 'deps', message: 'Fabric 依赖缓存已就绪', percent: 100 })
    return { ok: true }
  }

  onProgress({ phase: 'fabric', message: '正在解析 Fabric/Loom 依赖…', percent: 38, source: 'Fabric Maven / 国内 Maven 镜像' })

  // 用唯一目录名避免删除旧目录时的 EPERM（Gradle daemon/杀毒软件锁定文件）
  const projectDir = path.join(runtimeRoot, `_prefetch_project_${Date.now()}`)
  try {
    setupPrefetchProject(projectDir, runtimeRoot, jdkPath, gradleRuntimePath, wrapperJarPath, fabricVersions, true)
    fs.mkdirSync(gradleHomePath, { recursive: true })

    const forward = (phase: PrefetchProgressPayload['phase'], basePercent: number) => (line: string): void => {
      const m = line.match(/(?:Downloading|Downloaded|Unzipping)\s+(.+)/i)
      if (!m) return
      const target = (m[1].trim().split('/').pop() || m[1].trim()).slice(0, 96)
      onProgress({ phase, message: `正在处理：${target}`, currentItem: target, percent: basePercent })
    }

    const warmup = async (domestic: boolean): Promise<void> => {
      setupPrefetchProject(projectDir, runtimeRoot, jdkPath, gradleRuntimePath, wrapperJarPath, fabricVersions, domestic)
      const source = domestic ? 'BMCLAPI 国内镜像' : 'Mojang 官方源'

      // 步骤 1：build（下载 Fabric Loader、Yarn、Fabric API 并编译）
      // 成功后写标记文件，重启或换源重试时跳过此步骤
      if (isPrefetchStepDone(gradleHomePath, PREFETCH_BUILD_MARKER, fabricVersions)) {
        onProgress({ phase: 'fabric', message: 'Fabric 依赖已下载，跳过 build 步骤', percent: 52, source })
      } else {
        onProgress({ phase: 'fabric', message: '正在下载 Fabric Loader、Yarn 与 Fabric API…', percent: 46, source })
        await runGradle(projectDir, runtimeRoot, jdkPath, ['build', '--no-daemon',], 30 * 60 * 1000, forward('fabric', 52))
        writePrefetchStepDone(gradleHomePath, PREFETCH_BUILD_MARKER, fabricVersions)
      }

      onProgress({ phase: 'minecraft', message: '正在处理 Minecraft 与映射…', percent: 58, source })

      // 步骤 2：downloadAssets（下载 Minecraft 资源，约 480MB）
      // 成功后写标记文件，重启或换源重试时跳过此步骤
      if (isPrefetchStepDone(gradleHomePath, PREFETCH_ASSETS_MARKER, fabricVersions)) {
        onProgress({ phase: 'assets', message: '游戏资源已下载，跳过 downloadAssets 步骤', percent: 76, source })
      } else {
        onProgress({ phase: 'assets', message: '正在下载游戏资源（约 480MB，支持缓存复用）…', percent: 64, source })
        // downloadAssets 任务输出可能被缓冲或格式不匹配正则，
        // 启动定时器在 64%-76% 间基于已用时间线性推进进度，避免进度条卡住。
        // forward 回调匹配到下载行时仍会更新 currentItem，两者互不冲突。
        const assetsStart = Date.now()
        const assetsBase = 64
        const assetsTarget = 76
        const assetsDurationMs = 5 * 60 * 1000 // 预估 5 分钟完成，用于线性插值
        const assetsTimer = setInterval(() => {
          if (prefetchCancelled) return
          const elapsed = Date.now() - assetsStart
          const ratio = Math.min(elapsed / assetsDurationMs, 0.95)
          const percent = Math.round(assetsBase + (assetsTarget - assetsBase) * ratio)
          onProgress({ phase: 'assets', message: '正在下载游戏资源（约 480MB，支持缓存复用）…', percent, source })
        }, 2000)
        try {
          await runGradle(projectDir, runtimeRoot, jdkPath, ['downloadAssets', '--no-daemon',], 30 * 60 * 1000, forward('assets', 76))
        } finally {
          clearInterval(assetsTimer)
        }
        writePrefetchStepDone(gradleHomePath, PREFETCH_ASSETS_MARKER, fabricVersions)
      }
    }

    try {
      await warmup(true)
    } catch (mirrorError) {
      onProgress({ phase: 'minecraft', message: '国内镜像不可用，正在切换 Mojang 官方源重试…', percent: 60, source: 'Mojang 官方源' })
      // warmup(true) 的 Gradle daemon 刚退出，Windows 上文件句柄释放是异步的。
      // 等待 3s 让 daemon 完全退出并释放 _prefetch_project 下的句柄，避免
      // 紧接着的 setupPrefetchProject rmSync 报 EPERM。
      await new Promise((r) => setTimeout(r, 3000))
      await warmup(false)
    }

    onProgress({ phase: 'verify', message: '正在验证离线 Fabric 构建…', percent: 88 })
    await runGradle(projectDir, runtimeRoot, jdkPath, ['build', '--offline', '--no-daemon',], 20 * 60 * 1000)
    // 离线 build 成功说明缓存足够支持离线构建，先写 seed marker，
    // 再由 isReady() 验证 marker + 缓存目录完整性。
    // 注意：writeSeedMarker 必须在 isReady 之前调用，否则首次运行时
    // marker 不存在导致 isReady 永远返回 false，writeSeedMarker 永远执行不到。
    writeSeedMarker()
    if (!isReady()) return { ok: false, error: 'Fabric 离线构建虽完成，但缓存校验未通过' }
    onProgress({ phase: 'verify', message: '离线构建验证通过', percent: 96 })
    return { ok: true }
  } catch (err) {
    const errStr = String(err)
    // downloadAssets 失败通常是网络/镜像源问题，添加针对性提示帮助用户自助解决
    if (errStr.includes('downloadAssets') && errStr.includes('DownloadException')) {
      return {
        ok: false,
        error: `联网下载 Fabric 依赖失败: ${errStr}\n\n提示：Minecraft 游戏资源（约 480MB）下载失败。已尝试 BMCLAPI 国内镜像与 Mojang 官方源，均未成功。可能原因：网络不稳定/被防火墙拦截/镜像临时故障。请检查网络连接或尝试配置系统代理后重试，已下载的部分会自动复用。`
      }
    }
    return { ok: false, error: `联网下载 Fabric 依赖失败: ${errStr}` }
  }
}
