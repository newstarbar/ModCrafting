# 发布说明

Release 正文由 CI **自动生成**，无需每次手改 Markdown。格式参考 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases)。

## 瘦包策略（v1.0.0+）

为兼顾国内网络环境与安装包体积，v1.0.0 起采用**瘦包 + 首次下载**策略：

| 资源 | 位置 | 大小 |
|------|------|------|
| 精简 JRE（jlink） | 安装包内置 | ~60 MB |
| Gradle 9.5 精简版 | 首次从腾讯云镜像下载 | ~120 MB |
| Fabric 依赖种子 | 首次从 Gitee Release 下载分片 | ~500 MB |
| **安装包总计** | | **~400-500 MB** |
| **首次下载量** | | **~620 MB** |

用户首次启动时会看到**下载预估对话框**，确认后开始下载（国内镜像 5-10 分钟）。下载完成后可完全离线使用。

## seed 分片

Fabric 依赖种子（`gradle-home-seed.tar.xz`）压缩后约 500 MB，超过 Gitee 单文件 100 MB 限制。CI 会自动分片：

- 分片大小：90 MB / 块
- 文件命名：`seed.part.001` ~ `seed.part.00N` + `manifest.json`（含 SHA256 校验）
- 生成脚本：[`scripts/release/split-seed-shards.mjs`](scripts/release/split-seed-shards.mjs)
- 下载器：[`src/main/seed-downloader.ts`](src/main/seed-downloader.ts)（多镜像回退：Gitee → GitHub）

CI 上传到 GitHub Release 和 Gitee Release 后，应用首次启动自动从 Gitee 下载分片、校验、合并、解压。

## 自动生成的内容

打 tag `v*` 推送后，[`scripts/release/render-release-notes.mjs`](scripts/release/render-release-notes.mjs) 会生成 `packaging/release-body.md`，包含：

- 中文标题与文档链接
- Setup / Portable 下载表（GitHub + Gitee 直链 + 大小 + 说明）
- 版本选择、升级说明、合规提示
- **变更日志**：从 `git log` 按 commit 信息自动归类为「新增 / 修复 / 优化」
- Compare 链接（如 `v1.0.0...v1.0.1`）

该文件用于：

- **GitHub Release**（`electron-builder --publish`，`draft: false` 直接发布）
- **Gitee Release**（`sync-gitee-release.mjs` 同步正文与附件）

## 发布流程

1. 更新 `package.json` 的 `version`
2. 提交代码，commit 信息建议使用规范前缀（便于自动归类）：
   - `feat:` / `新增:` → 新增
   - `fix:` / `修复:` → 修复
   - `perf:` / `优化:` / `refactor:` → 优化
   - `chore:` / `ci:` / `build:` → 默认不展示在 Release 正文
3. 打 tag 并推送：`git tag v1.0.1 && git push origin v1.0.1`
4. GitHub Actions 自动：
   - 构建工具链（setup → strip-gradle → build-jre → prefetch → archive → split-seed）
   - 构建 Setup + Portable
   - 发布 GitHub Release（Setup + Portable + seed 分片）
   - 更新 `packaging/update-manifest.json` 到 main
5. 本地同步 Gitee（见下方「Gitee 配置」章节）：
   - 设置 `$env:GITEE_TOKEN`
   - 运行 `npm run release:gitee-local`

## CI 构建步骤（toolchain）

| 步骤 | 命令 | 产物 |
|------|------|------|
| 下载 JDK + Gradle | `npm run toolchain:setup` | `resources/jdk-21/`, `resources/gradle-9.5/` |
| 精简 Gradle | `npm run toolchain:strip-gradle` | 移除 docs/samples/src |
| 构建 jlink JRE | `npm run toolchain:build-jre` | `resources/jre-21-minimal/` (~60 MB) |
| 预取 Fabric 依赖 | `npm run toolchain:prefetch` | `resources/gradle-home-seed/` |
| 生成符号索引 | `npm run toolchain:symbol-index` | `resources/fabric-symbols/` |
| 准备 seed | `node scripts/toolchain/prepare-seed-for-packaging.mjs` | 清理 + 规范化 |
| 压缩 seed | `node scripts/toolchain/archive-gradle-home-seed.mjs` | `resources/gradle-home-seed.tar.xz` |
| 分片 seed | `node scripts/release/split-seed-shards.mjs` | `resources/seed-shards/` |

## Gitee 配置

见 [`packaging/gitee-config.json`](packaging/gitee-config.json)。

> Gitee 同步已从 GitHub Actions 迁移到本地执行。CI 不再负责 Gitee 同步，改由 `npm run release:gitee-local` 在本地完成。

### 本地同步 Gitee

GitHub Release 发布完成后，本地执行以下步骤同步到 Gitee：

1. 设置 Gitee 私人令牌（PowerShell）：

   ```powershell
   $env:GITEE_TOKEN = "<你的 Gitee 私人令牌>"
   ```

   令牌获取：https://gitee.com/profile/personal_access_tokens

2. 确保本地构建产物齐全（Setup / Portable / seed 分片 / JRE 分片 / 额外资源 / `packaging/release-body.md`）。产物缺失时脚本会报错并列出需运行的构建命令。

3. 运行同步命令：

   ```bash
   npm run release:gitee-local
   ```

脚本逻辑（幂等）：

- 读取 `package.json` 的 `version`，构造 tag `vX.Y.Z`
- 查询 Gitee 是否已存在该 tag 的 Release，存在则跳过同步
- 查询 GitHub 最新 Release tag 作为信息对比（不阻断）
- 检查本地构建产物，缺失则报错并给出构建命令提示
- 调用 `release:push-gitee` 推送 commit + tag 到 Gitee
- 调用 `release:sync-gitee` 创建 Release 并上传附件（含 seed 分片）

若 Gitee 仓库没有对应代码，会报「创建标签失败」，此时需先确保 `release:push-gitee` 成功执行。

## 本地预览 Release 正文

```bash
npm run release:notes -- v1.0.0
# 输出 packaging/release-body.md
```

## 本地生成 seed 分片（调试用）

```bash
# 前置：需已运行 toolchain:setup + toolchain:prefetch
node scripts/toolchain/archive-gradle-home-seed.mjs
node scripts/release/split-seed-shards.mjs
# 产物在 resources/seed-shards/
```

