# 工具链

ModCrafting 内置离线工具链，确保在无网络或弱网环境下仍可完成模组编译与 `runClient` 测试。

## 捆绑组件

| 组件 | 版本 | 位置 |
|------|------|------|
| JDK | Eclipse Temurin 21 | `resources/jdk-21` |
| Gradle | 9.5 | `resources/gradle-9.5` |
| Fabric 依赖种子 | — | `resources/gradle-home-seed/` |
| 辅助 mod | Mod Menu、ModCrafting Observer 等 | `resources/_base_mods/` |

## 版本类型

由 `src/main/edition.ts` 检测：

| 类型 | 标识 | 说明 |
|------|------|------|
| `dev` | 未打包（`app.isPackaged === false`） | 开发模式，使用系统 PATH 中的工具 |
| `full` | 完整安装版 | 捆绑 JDK + Gradle + 依赖种子，可离线构建 |
| `portable` | `PORTABLE_EXECUTABLE_DIR` 环境变量存在 | 首次启动联网下载工具链到 `runtime/` |

## 模块

`src/main/build-env.ts` 是工具链子系统核心：

- 配置 JDK 21 + Gradle 9.5 路径
- 管理 Fabric 离线依赖缓存（`gradle-home-seed`）
- 生成 `gradlew.bat`
- 启动遮罩 + 进度条，环境未就绪前锁定构建

## 启动初始化流程

1. **Setup 完整版**：内置 JDK/Gradle/依赖种子，首次启动复制到 `runtime/`，完成后可离线构建
2. **Portable 便携版**：仅含应用本体，首次启动自动联网下载 JDK / Gradle / Fabric 依赖（约 1GB）到 `runtime/`
3. **开发模式**：使用系统 PATH 中的工具，但仍可通过 `npm run toolchain:setup` 准备本地工具链

## 离线构建验证

```bash
npm run toolchain:verify          # 检查 JDK/Gradle/Wrapper 文件是否齐全
npm run toolchain:verify-offline   # 验证离线构建流程
```

## EBUSY 重试

`build-env.ts` 中 `retryRmdirSync()` 对 Windows 文件锁（EBUSY/EPERM/ENOTEMPTY）最多 3 次重试，100ms 递增退避。

## 工具链下载逻辑双份

⚠️ 维护注意：工具链下载逻辑存在两份，修改时需同步：

- `scripts/toolchain/toolchain-download.mjs`（构建脚本，用于 `npm run toolchain:setup`）
- `src/main/toolchain-download.ts`（运行时，用于 Portable 首次启动）

修改 URL/版本时，**两处都要改**。

## 安装器静态资源

- `packaging/` 目录（原 `build/`）
- 生成物在 `packaging/nsisbi/`（gitignore）

## 更新清单

`packaging/update-manifest.json` 的 raw 路径为 `main/packaging/update-manifest.json`。

由 `npm run release:manifest` 渲染。CI 自动同步到 GitHub 与 Gitee。

## 多实例联机测试

`mc-runtime.ts` 为每个游戏实例分配：
- 独立 `gameDir`
- 独立 Gradle 守护进程目录（`GRADLE_USER_HOME`）

避免第二个 `runClient` 停止第一个实例的 Daemon。
