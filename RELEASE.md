# 发布流程

ModCrafting v1.0.0 仅发布 Windows x64 的两个应用产物：

- `ModCrafting-Setup-1.0.0.exe`
- `ModCrafting-1.0.0-Portable.exe`

JDK、Gradle、Fabric/Loom、Minecraft 依赖和游戏 assets 不随发布包分片。两种版本均在首次启动后使用同一在线初始化管线，并在离线 Fabric build 通过前保持未就绪状态。

## 本地质量门禁

```bash
npm test
npm run build
npm run build:win
```

`build:win` 会检查：

- Setup 与 Portable 文件名；
- `latest.yml` 指向 Setup 文件且 SHA-512 完整；
- Electron 核心运行文件（包括 chrome pak 与 `dxcompiler.dll`）；
- Windows x64 原生终端模块；
- Setup 严格小于 `100,000,000` 字节。

任一门禁失败均不得创建、替换或上传 Release。禁止通过删除 Electron 核心文件绕过体积限制。

## 发布步骤

1. 确认 `package.json` 的版本和本地质量门禁全部通过。
2. 运行 `npm run release:publish`。该脚本生成发布说明和归档、创建并推送 tag，并同步 GitHub/Gitee Release 应用产物。
3. 检查 GitHub 与 Gitee 上的 Setup、Portable、`latest.yml` 和校验值。

当需要重置既有版本 tag/release 时，先归档旧版元数据和哈希，再在两个远端删除旧 Release、强制移动 tag、重建 Release。此操作只能在全部本地门禁通过后执行。

## v1.0.0 迁移说明

旧 v1.0.0 客户端不会自动升级到新的运行时布局。用户需要重新下载 Setup 或 Portable；旧安装版的有效运行时缓存会在首次启动时迁移至 `%LOCALAPPDATA%\ModCrafting\runtime`。
