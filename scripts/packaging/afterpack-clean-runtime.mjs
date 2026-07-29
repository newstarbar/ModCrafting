#!/usr/bin/env node
/**
 * afterPack hook: 删除 win-unpacked/runtime/ 目录,防止本地 runtime
 * (jdk-21 / gradle-9.5 / gradle-home / fabric-api-sources 等)被意外打包进 Setup.exe。
 *
 * 背景:getRuntimeRoot() 在打包模式返回 exe 目录下的 runtime/。
 * 若开发者曾运行过 unpacked exe,ensureRuntimeJdk / ensureRuntimeGradle /
 * ensureFabricKnowledgeBase 会把 resources/ 复制到 release/win-unpacked/runtime/。
 * NSIS 打包时该目录存在,会被一并压缩,导致 Setup.exe 体积膨胀到 1.35GB+。
 *
 * 本钩子在 electron-builder 打包前清理该目录,确保 Setup.exe 只含 Electron 本体
 * + 显式声明的 extraResources(JRE 已改为按需下载,不再内置)。
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {{ appOutDir: string; electronPlatformName: string }} context
 */
export default async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  // electron-builder passes "win32" / "darwin" / "linux" (not "win"/"mac"/"linux")
  if (electronPlatformName !== 'win32' && electronPlatformName !== 'win') return

  const runtimeDir = path.join(appOutDir, 'runtime')
  if (!existsSync(runtimeDir)) {
    console.log('[afterpack] runtime/ not present, nothing to clean')
    return
  }

  console.log(`[afterpack] cleaning ${runtimeDir} to keep Setup.exe slim`)
  try {
    rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    if (existsSync(runtimeDir)) {
      // Windows 上有时文件句柄未释放,二次尝试
      console.warn('[afterpack] runtime/ still exists after first rm, retrying once more…')
      rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 })
    }
    if (existsSync(runtimeDir)) {
      console.warn('[afterpack][warn] runtime/ could not be fully removed — Setup.exe may include stray files')
    } else {
      console.log('[afterpack] runtime/ removed successfully')
    }
  } catch (err) {
    console.error(`[afterpack][error] failed to remove runtime/: ${err?.message || err}`)
    // 不抛出,避免阻塞打包;NSIS 会再次尝试,且通常清理已足够
  }

  // 删除 Electron 运行时大文件以进一步缩小 Setup.exe
  // - LICENSES.chromium.html: Chromium 开源许可证（可用在线链接替代）
  // - dxcompiler.dll: DirectX 着色器编译器（Chromium 回退到 d3dcompiler_47.dll）
  const filesToDelete = ['LICENSES.chromium.html', 'dxcompiler.dll']
  for (const fname of filesToDelete) {
    const fpath = path.join(appOutDir, fname)
    if (existsSync(fpath)) {
      try {
        rmSync(fpath, { force: true, maxRetries: 3, retryDelay: 200 })
        console.log(`[afterpack] removed ${fname}`)
      } catch (err) {
        console.warn(`[afterpack][warn] failed to remove ${fname}: ${err?.message || err}`)
      }
    }
  }
}
