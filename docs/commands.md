# 常用命令

以下内容以当前 `package.json` 为准。Windows 本地开发使用 PowerShell；`test:app:*` 会启动真实 Electron 进程。

## 开发与基础验证

```bash
npm run dev              # Electron 热更新开发模式
npm run build            # 编译主进程、预加载与 Renderer
npm run start            # 启动已构建的 Electron 应用
npm run test             # Harness 单元/回归测试（自动收集 harness-*.test.ts）
npm run test:harness     # npm run test 的别名
```

## Harness Test Lab

```bash
npm run test:mcp         # Test Lab MCP 构造、Schema 与工具发现烟测
npm run test:mcp:serve   # 通过 stdio 启动开发专用 MCP Server
npm run test:app         # 前台 Electron + 本地回放 Provider 的确定性应用回归
npm run test:app:hidden  # 隐藏 Electron 的无人值守/CI 兼容回归
npm run test:app:live    # 前台真实 Provider 低频烟测
npm run test:app:game    # 前台真实 Provider + Minecraft/Observer 烟测
npm run bridge:build     # 构建 Observer 并复制到 resources/_base_mods/
```

`test:app` 与 `test:app:hidden` 是日常可重复门禁。`test:app:live` 和 `test:app:game` 依赖本机 Provider、网络、Minecraft 和 Observer，允许生成 `INCONCLUSIVE` 报告；不得把它转换为自动修复信号。

Standalone runner 的产物位于系统临时目录 `modcrafting-app-test/<runId>/artifacts/`；MCP 启动的运行位于 `%LOCALAPPDATA%/ModCrafting Test Lab/runs/<runId>/artifacts/`。详见 [Test Lab MCP](./test-lab-mcp.md)。

## Windows 构建

```bash
npm run build:win           # Setup + Portable，并验证两个产物
npm run build:win:setup     # 仅 NSIS Setup
npm run build:win:portable  # 仅 Portable
npm run smoke:win           # 对 release/win-unpacked/ModCrafting.exe 做烟测
```

`prebuild:win*` 由打包流程调用，用于准备对应 edition 的资源；一般不需要单独执行。

## 工具链

```bash
npm run toolchain:setup           # 准备 JDK 21 与 Gradle 9.5
npm run toolchain:verify          # 检查 JDK、Gradle、Wrapper
npm run toolchain:prefetch        # 预取 Fabric/Minecraft 离线依赖
npm run toolchain:verify-offline  # 真实验证离线构建
npm run toolchain:symbol-index    # 生成 Fabric 符号索引
npm run toolchain:export-zip      # 导出运行时压缩包
```

旧别名如 `setup:toolchain`、`prefetch:deps`、`verify:toolchain` 仍存在；新文档和脚本应使用 `toolchain:*`。

## 资源与知识库

```bash
npm run assets:prepare       # 准备 Minecraft Renderer 资源
npm run assets:mc            # 下载/解压 Minecraft 客户端资源
npm run assets:items         # 生成物品预览和索引
npm run assets:icon          # 生成 Windows ICO
npm run knowledge:download   # 下载全部预构建离线知识库
npm run docs:sync-fabric     # 同步 Fabric 官方文档知识源
```

Minecraft 版本升级后必须重新运行 `npm run knowledge:download`。知识库构建本身位于独立的 ModCrafting-knowledge-base 仓库。

## 发布

常规发布使用单一入口：

```bash
npm run release:publish
```

该命令生成 release notes、创建并推送 tag、推送 Git/Gitee 并同步发布附件。运行前必须已经构建目标产物，并由开发者确认版本号。详细流程见根目录 `RELEASE.md`。

维护用子命令：

```bash
npm run release:manifest
npm run release:notes
npm run release:push-gitee
npm run release:sync-gitee
npm run release:gitee-only
npm run release:cleanup-github
```

## 清理

```bash
npm run clean:local -- --all
```

清理属于破坏性操作；执行前确认目标仅为仓库生成物，不得手动递归删除工作区或 `runtime/`。

## 测试文件约定

`scripts/test/run-harness.mjs` 自动收集 `scripts/test/harness-*.test.ts`。主要测试层级：

| 层级 | 入口 | 典型覆盖 |
|---|---|---|
| Harness 单元/回归 | `npm test` | 计划、工具门控、分类、证据、修复范围、游戏协议 |
| MCP 协议烟测 | `npm run test:mcp` | stdio Server 构造、Schema 和工具发现 |
| 应用级回放 | `npm run test:app` | 真实 Electron/React/Controller/IPC 与活跃状态 |
| Observer | `npm run bridge:build` | Java/Mixin 编译及基础模组 JAR |
| 真实外部烟测 | `test:app:live` / `test:app:game` | Provider、Minecraft、Observer 和完整报告 |

## 脚本目录

```text
scripts/
├── assets/       # Minecraft 渲染资源和图标
├── knowledge/    # 下载预构建知识库
├── lib/          # 共享 Node 脚本能力
├── mcp/          # 开发专用 Test Lab MCP
├── packaging/    # electron-builder / NSIS
├── release/      # 发布说明、tag 与 Gitee 同步
├── test/         # Harness、应用自动化、回放 Provider 和黑盒夹具
├── toolchain/    # JDK、Gradle、Fabric 离线依赖
└── prebuild-win.mjs
```
