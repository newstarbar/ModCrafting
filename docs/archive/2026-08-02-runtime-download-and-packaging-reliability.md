# 环境下载、Fabric 初始化与打包可靠性修复

**归档日期**：2026-08-02  
**触发方式**：大功能改动自动触发  
**问题类型**：复杂下载与构建流程重构

## 背景

安装版和便携版此前使用不同的运行时路径与 seed 分片流程。安装版仍可能依赖最小 JRE，Fabric seed 和 `downloadAssets` 的失败可能被吞掉，完成标记与实际 Loom 缓存条件不一致。打包清理逻辑还曾删除 Electron 必需的 pak/DLL 文件。

## 根因与决策

- 将 Setup 运行时移至 `%LOCALAPPDATA%\ModCrafting\runtime`，Portable 保持在原始 exe 邻近目录；避免升级、卸载或临时安装目录删除缓存。
- 废弃活动初始化路径中的 JRE、Gradle/Fabric seed 和 Gitee 大型分片，改为完整 JDK 21、Gradle 9.5 的可续传直链下载。
- Fabric 专有坐标仅使用官方 Fabric Maven；Minecraft libraries、元数据和 assets 使用 BMCLAPI 优先、官方回退。
- 将 `downloadAssets` 和离线 `build --offline` 作为完成凭据的硬门禁，所有失败都记录结构化诊断。
- Setup 体积限制通过排除重复的已编译渲染依赖、source map、测试与可选运行时依赖实现；不删除 Electron 核心文件。

## 主要改动

| 范围 | 内容 |
|---|---|
| `runtime-layout.ts` | Setup/Portable 统一运行时布局与旧缓存迁移 |
| `toolchain-download.ts` | 固定完整 JDK、Gradle 直链续传、超时与 SHA 校验 |
| `portable-prefetch.ts` | BMCLAPI/Mojang 回退、Fabric 精确路由、assets 与离线构建门禁、进程树取消 |
| `build-env.ts` | 单一环境就绪判定、完成凭据、磁盘检查、跨进程锁和结构化失败 |
| renderer/preload/IPC | 六步进度、取消、日志、诊断包、Error Boundary |
| packaging/release | 保留 Electron 文件、停止 seed/JRE 预构建与发布、标准化文件名和产物门禁 |

## 验证

- `npm run build` 通过。
- `npm test` 通过：384/384。
- Windows Setup 产物：`ModCrafting-Setup-1.0.0.exe`，99,632,595 bytes。
- Windows Portable 产物：`ModCrafting-1.0.0-Portable.exe`，88,832,608 bytes。
- `node scripts/packaging/verify-windows-artifacts.mjs` 通过，验证 `latest.yml` SHA-512、规范命名、Electron 核心文件与 Setup 上限。

## 经验

发布前脚本本身也属于运行时供应链。即使主进程已经弃用 JRE/seed，`prebuild-win.mjs` 仍会生成它们就会导致流程回退和错误发布假设。首次初始化的“完成”必须由真实离线构建验证，而不是单个下载或 marker 文件。
