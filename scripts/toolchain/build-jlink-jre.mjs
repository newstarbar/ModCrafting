#!/usr/bin/env node
/**
 * Build a minimal JRE via jlink for NSIS packaging.
 *
 * Source: resources/jdk-21 (full JDK)
 * Output: resources/jre-21-minimal (custom JRE)
 *
 * 正常路径：jlink 生成精简 JRE（~60MB，仅包含指定模块）
 * Fallback 路径：当 Windows Defender 拦截 java.exe 写入 lib 目录时，
 *                用 Node.js 手动复制 JDK 子集构建 JRE（~165MB）
 *
 * The module list is tuned for Fabric 1.21.4 + Loom 1.17 + Gradle 9.5 builds.
 * If a build fails with `java.lang.module.FindException: Module ... not found`,
 * add the missing module to REQUIRED_MODULES and re-run.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isWindows = process.platform === 'win32'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const jdkSource = process.env.JDK_HOME || path.join(root, 'resources', 'jdk-21')
const outputDir = path.join(root, 'resources', 'jre-21-minimal')
const force = process.argv.includes('--force')

// Fabric build required JDK modules (validated against Gradle 9.5 + Loom 1.17 + Java 21)
const REQUIRED_MODULES = [
  'java.base',
  'java.compiler',
  'java.datatransfer',
  'java.desktop',
  'java.instrument',
  'java.logging',
  'java.management',
  'java.naming',
  'java.net.http',
  'java.prefs',
  'java.scripting',
  'java.se',
  'java.security.jgss',
  'java.security.sasl',
  'java.sql',
  'java.sql.rowset',
  'java.transaction.xa',
  'java.xml',
  'java.xml.crypto',
  'jdk.crypto.cryptoki',
  'jdk.crypto.ec',
  'jdk.jfr',
  'jdk.jshell',
  'jdk.management',
  'jdk.net',
  'jdk.nio.mapmode',
  'jdk.unsupported',
  'jdk.zipfs'
]

// 手动构建时跳过的 bin 文件（编译/调试工具，运行时不需要）
const SKIP_BIN_FILES = new Set([
  'javac.exe', 'javadoc.exe', 'javap.exe', 'jcmd.exe', 'jconsole.exe',
  'jdb.exe', 'jdeprscan.exe', 'jdeps.exe', 'jfr.exe', 'jhsdb.exe',
  'jimage.exe', 'jinfo.exe', 'jlink.exe', 'jmap.exe', 'jmod.exe',
  'jpackage.exe', 'jps.exe', 'jrunscript.exe', 'jshell.exe', 'jstack.exe',
  'jstat.exe', 'jstatd.exe', 'jwebserver.exe', 'jarsigner.exe', 'jar.exe',
  'keytool.exe', 'kinit.exe', 'klist.exe', 'ktab.exe', 'rmiregistry.exe',
  'serialver.exe'
])

// 手动构建时跳过的 lib 文件（源码/编译符号/链接库，运行时不需要）
const SKIP_LIB_FILES = new Set([
  'src.zip',      // 50.55 MB JDK 源码
  'ct.sym',       // 10.22 MB 编译符号
  'jvm.lib',      // 1.14 MB 链接库
  'jawt.lib'      // 链接库
])

function dirSizeMb(p) {
  let total = 0
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  if (existsSync(p)) walk(p)
  return (total / 1024 / 1024).toFixed(0)
}

function removeOutputDir() {
  if (!existsSync(outputDir)) return
  console.log(`[jlink] Removing existing output: ${outputDir}`)
  if (isWindows) {
    // Windows 上 rmSync 对含锁文件的目录删除可能静默失败，
    // 使用原生 rmdir /s /q 更可靠
    const rmdirResult = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', outputDir], { stdio: 'pipe', shell: false })
    if (rmdirResult.status !== 0) {
      rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
  } else {
    rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  }
  if (existsSync(outputDir)) {
    throw new Error(`无法删除旧 JRE 目录: ${outputDir}（可能被占用，请关闭相关进程后重试）`)
  }
}

/**
 * 尝试用 jlink 构建精简 JRE
 * @returns {boolean} 是否成功
 */
function tryJlink() {
  const jlinkBin = isWindows ? 'jlink.exe' : 'jlink'
  const jlink = path.join(jdkSource, 'bin', jlinkBin)
  if (!existsSync(jlink)) {
    console.warn(`[jlink] jlink not found: ${jlink}`)
    return false
  }

  const jmodsDir = path.join(jdkSource, 'jmods')
  if (!existsSync(jmodsDir)) {
    console.warn(`[jlink] jmods directory not found: ${jmodsDir}`)
    return false
  }

  console.log(`[jlink] Building minimal JRE from ${jdkSource}`)
  console.log(`[jlink] Modules (${REQUIRED_MODULES.length}): ${REQUIRED_MODULES.join(', ')}`)

  const args = [
    '--module-path', jmodsDir,
    '--add-modules', REQUIRED_MODULES.join(','),
    '--output', outputDir,
    '--strip-debug',
    '--no-header-files',
    '--no-man-pages',
    '--compress=1'
  ]

  // 捕获输出以辅助诊断
  const result = spawnSync(jlink, args, { stdio: 'pipe', shell: false, encoding: 'utf-8' })
  if (result.status === 0) return true

  const stderr = result.stderr || ''
  const stdout = result.stdout || ''
  console.error(`[jlink] jlink exited with code ${result.status}`)
  if (stderr) console.error(`[jlink] stderr: ${stderr.trim()}`)
  if (stdout) console.error(`[jlink] stdout: ${stdout.trim()}`)

  // 检测 Windows Defender 拦截 java.exe 写入 lib 目录
  // 可靠检测方式：jlink 失败 + 输出目录不完整（没有 java.exe）
  // 原因：Defender 拦截 java.exe 在 lib 目录创建文件，导致 jlink 无法完成
  const javaBin = path.join(outputDir, 'bin', isWindows ? 'java.exe' : 'java')
  const isDefenderBlock = isWindows && !existsSync(javaBin)
  if (isDefenderBlock) {
    console.warn('')
    console.warn('[jlink] jlink 失败且输出不完整，推测为 Windows Defender 拦截 java.exe 写入 lib 目录')
    console.warn('[jlink] 切换到 Node.js fallback 模式手动构建 JRE（体积稍大但无需管理员权限）')
    console.warn('[jlink] 提示：以管理员权限运行 scripts/toolchain/fix-defender-exclusion.ps1 添加 Defender 排除项后可获得更小的 JRE')
    console.warn('')
    return false
  }

  // 非 Defender 拦截的错误，直接抛出
  throw new Error(`jlink failed with exit code ${result.status ?? 'unknown'}\n${stderr}\n${stdout}`)
}

/**
 * Node.js 手动构建 JRE（fallback 模式）
 * 当 Defender 拦截 jlink 时使用，通过 Node.js 复制 JDK 子集构建 JRE
 */
function buildJreManually() {
  console.log('[jlink-fallback] 手动构建 JRE（Node.js 复制模式）')
  console.log(`[jlink-fallback] Source: ${jdkSource}`)
  console.log(`[jlink-fallback] Output: ${outputDir}`)

  // 1. 创建目录结构
  const dirs = ['bin', 'lib', 'conf', 'legal']
  for (const d of dirs) {
    mkdirSync(path.join(outputDir, d), { recursive: true })
  }

  // 2. 复制 bin/ 目录（跳过编译/调试工具，但保留 server/ 等子目录）
  console.log('[jlink-fallback] Copying bin/ ...')
  const binDir = path.join(jdkSource, 'bin')
  let binCount = 0
  let binSkip = 0
  for (const name of readdirSync(binDir, { withFileTypes: true })) {
    if (SKIP_BIN_FILES.has(name.name)) {
      binSkip++
      continue
    }
    const src = path.join(binDir, name.name)
    const dst = path.join(outputDir, 'bin', name.name)
    if (name.isDirectory()) {
      cpSync(src, dst, { recursive: true })
      binCount++
    } else if (name.isFile()) {
      copyFileSync(src, dst)
      binCount++
    }
  }
  console.log(`[jlink-fallback]   copied ${binCount} items, skipped ${binSkip} dev tools`)

  // 3. 复制 lib/ 目录（跳过 src.zip, ct.sym, jvm.lib 等大文件）
  console.log('[jlink-fallback] Copying lib/ ...')
  const libDir = path.join(jdkSource, 'lib')
  let libCount = 0
  let libSkip = 0
  let libSavedBytes = 0
  for (const name of readdirSync(libDir, { withFileTypes: true })) {
    if (SKIP_LIB_FILES.has(name.name)) {
      const size = statSync(path.join(libDir, name.name)).size
      libSkip++
      libSavedBytes += size
      continue
    }
    const src = path.join(libDir, name.name)
    const dst = path.join(outputDir, 'lib', name.name)
    if (name.isDirectory()) {
      cpSync(src, dst, { recursive: true })
      libCount++
    } else {
      copyFileSync(src, dst)
      libCount++
    }
  }
  console.log(`[jlink-fallback]   copied ${libCount} items, skipped ${libSkip} files (saved ${(libSavedBytes / 1024 / 1024).toFixed(1)} MB)`)

  // 4. 复制 conf/ 目录
  console.log('[jlink-fallback] Copying conf/ ...')
  cpSync(path.join(jdkSource, 'conf'), path.join(outputDir, 'conf'), { recursive: true })

  // 5. 复制 legal/ 目录（可选，法律文件很小）
  if (existsSync(path.join(jdkSource, 'legal'))) {
    console.log('[jlink-fallback] Copying legal/ ...')
    cpSync(path.join(jdkSource, 'legal'), path.join(outputDir, 'legal'), { recursive: true })
  }

  // 6. 创建 release 文件
  const releaseContent = `JAVA_VERSION="21.0.12"\nOS_NAME="Windows"\nOS_ARCH="x86_64"\nSOURCE="jdk-21-minimal-fallback"\n`
  writeFileSync(path.join(outputDir, 'release'), releaseContent)

  console.log(`[jlink-fallback] JRE built successfully`)
}

function verifyJre() {
  const javaBin = path.join(outputDir, 'bin', isWindows ? 'java.exe' : 'java')
  if (!existsSync(javaBin)) {
    throw new Error(`JRE output missing java binary: ${javaBin}`)
  }

  const verify = spawnSync(javaBin, ['-version'], { stdio: 'pipe', shell: false, encoding: 'utf-8' })
  if (verify.status !== 0) {
    throw new Error(`JRE verification failed: java -version exited ${verify.status}`)
  }

  const versionOutput = (verify.stderr || verify.stdout || '').trim()
  console.log(`\n[jlink] JRE built successfully: ${outputDir}`)
  console.log(`[jlink] Size: ${dirSizeMb(outputDir)} MB`)
  console.log(`[jlink] Verify: ${versionOutput}`)
}

function main() {
  if (!existsSync(jdkSource)) {
    throw new Error(`Missing JDK source: ${jdkSource}. Run: npm run toolchain:setup`)
  }

  // Skip if up-to-date (unless --force)
  if (!force && existsSync(outputDir) && existsSync(path.join(outputDir, 'bin', isWindows ? 'java.exe' : 'java'))) {
    console.log(`[jlink] JRE already exists: ${outputDir} (${dirSizeMb(outputDir)} MB). Use --force to rebuild.`)
    return
  }

  removeOutputDir()

  // 尝试 jlink，失败则 fallback 到手动构建
  const jlinkSuccess = tryJlink()
  if (!jlinkSuccess) {
    // jlink 失败（通常是 Defender 拦截），用 Node.js 手动构建
    removeOutputDir() // 清理 jlink 可能残留的部分文件
    buildJreManually()
  }

  verifyJre()
}

try {
  main()
} catch (err) {
  console.error(`[jlink][fatal] ${err.message || err}`)
  process.exit(1)
}
