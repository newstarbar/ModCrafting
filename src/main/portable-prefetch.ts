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
  v: FabricVersions,
  useDomesticMinecraftMirror: boolean
): void {
  const projectName = 'prefetch-mod'
  const groupId = 'com.example'
  const pkg = projectName.replace(/-/g, '_')
  const modId = projectName
  const javaPath = `src/main/java/${groupId.replace(/\./g, '/')}/${pkg}`
  const clientJavaPath = `src/client/java/${groupId.replace(/\./g, '/')}/${pkg}`

  // Gradle 子进程刚退出时，Windows 上文件句柄可能尚未释放，rmSync 会报
  // ENOTEMPTY/EPERM（warmup 二次调用、杀毒软件实时扫描、daemon 残留都会触发）。
  // 标准 Windows 文件锁处理：先 rename 到临时目录（原子操作，不受文件锁影响），
  // 再异步删除旧目录（不阻塞主流程，失败则下次启动时清理）。
  // rename 失败时 fallback 到带重试的 rmSync。
  if (fs.existsSync(projectDir)) {
    const trashDir = `${projectDir}_old_${Date.now()}`
    try {
      fs.renameSync(projectDir, trashDir)
      // 异步删除，不阻塞；fs.promises.rm 在 Node 14+ 可用
      setImmediate(() => {
        fs.promises.rm(trashDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
          .catch(() => { /* 旧目录遗留，下次启动时清理 */ })
      })
    } catch {
      // rename 失败（跨盘符/被锁），fallback 到带重试的 rmSync
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
    }
  }

  // 清理上次遗留的 _old_ 目录（异步删除失败时积累的垃圾）
  try {
    const parent = path.dirname(projectDir)
    const baseName = path.basename(projectDir)
    for (const entry of fs.readdirSync(parent)) {
      if (entry.startsWith(`${baseName}_old_`)) {
        const oldDir = path.join(parent, entry)
        fs.rmSync(oldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
      }
    }
  } catch { /* 清理失败不影响主流程 */ }

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
        JAVA_HOME: path.join(runtimeRoot, 'jdk-21'),
        GRADLE_USER_HOME: path.join(runtimeRoot, 'gradle-home'),
        PATH: `${path.join(runtimeRoot, 'jdk-21', 'bin')};${process.env.PATH || ''}`
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

  const projectDir = path.join(runtimeRoot, '_prefetch_project')
  try {
    setupPrefetchProject(projectDir, runtimeRoot, gradleRuntimePath, wrapperJarPath, fabricVersions, true)
    fs.mkdirSync(gradleHomePath, { recursive: true })

    const forward = (phase: PrefetchProgressPayload['phase'], basePercent: number) => (line: string): void => {
      const m = line.match(/(?:Downloading|Downloaded|Unzipping)\s+(.+)/i)
      if (!m) return
      const target = (m[1].trim().split('/').pop() || m[1].trim()).slice(0, 96)
      onProgress({ phase, message: `正在处理：${target}`, currentItem: target, percent: basePercent })
    }

    const warmup = async (domestic: boolean): Promise<void> => {
      setupPrefetchProject(projectDir, runtimeRoot, gradleRuntimePath, wrapperJarPath, fabricVersions, domestic)
      const source = domestic ? 'BMCLAPI 国内镜像' : 'Mojang 官方源'
      onProgress({ phase: 'fabric', message: '正在下载 Fabric Loader、Yarn 与 Fabric API…', percent: 46, source })
      await runGradle(projectDir, runtimeRoot, ['build', '--no-daemon',], 30 * 60 * 1000, forward('fabric', 52))
      onProgress({ phase: 'minecraft', message: '正在处理 Minecraft 与映射…', percent: 58, source })
      onProgress({ phase: 'assets', message: '正在下载游戏资源（约 480MB，支持缓存复用）…', percent: 64, source })
      await runGradle(projectDir, runtimeRoot, ['downloadAssets', '--no-daemon',], 30 * 60 * 1000, forward('assets', 76))
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
    await runGradle(projectDir, runtimeRoot, ['build', '--offline', '--no-daemon',], 20 * 60 * 1000)
    // 离线 build 成功说明缓存足够支持离线构建，先写 seed marker，
    // 再由 isReady() 验证 marker + 缓存目录完整性。
    // 注意：writeSeedMarker 必须在 isReady 之前调用，否则首次运行时
    // marker 不存在导致 isReady 永远返回 false，writeSeedMarker 永远执行不到。
    writeSeedMarker()
    if (!isReady()) return { ok: false, error: 'Fabric 离线构建虽完成，但缓存校验未通过' }
    onProgress({ phase: 'verify', message: '离线构建验证通过', percent: 96 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `联网下载 Fabric 依赖失败: ${String(err)}` }
  }
}
