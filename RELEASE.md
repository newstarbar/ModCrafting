# 发布说明

Release 正文由 `npm run release:publish` **自动生成**，无需每次手改 Markdown。格式参考 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases)。

## 瘦包策略（v1.0.0+）

为兼顾国内网络环境与安装包体积，v1.0.0 起采用**瘦包 + 首次下载**策略（安装包版与便携版一致，JDK/Gradle 从公共镜像测速选最快源下载）：

| 资源 | 位置 | 大小 |
|------|------|------|
| JDK 21（完整版） | 首次从公共镜像下载（华为云/Adoptium 等，测速选优） | ~200 MB |
| Gradle 9.5 精简版 | 首次从公共镜像下载（腾讯云/华为云/官方，测速选优） | ~120 MB |
| Fabric 依赖种子 | 首次从 Gitee/GitHub Release 下载分片 | ~500 MB |
| **安装包总计** | | **~100 MB** |
| **首次下载量** | | **~925 MB** |

用户首次启动时会看到**下载预估对话框**，确认后开始下载（国内镜像 5-15 分钟，JDK/Gradle 自动测速选择最快源）。下载完成后可完全离线使用。

## seed 分片

Fabric 依赖种子（`gradle-home-seed.tar.xz`）压缩后约 500 MB，超过 Gitee 单文件 100 MB 限制。CI 会自动分片：

- 分片大小：90 MB / 块
- 文件命名：`seed.part.001` ~ `seed.part.00N` + `manifest.json`（含 SHA256 校验）
- 生成脚本：[`scripts/release/split-seed-shards.mjs`](scripts/release/split-seed-shards.mjs)
- 下载器：[`src/main/seed-downloader.ts`](src/main/seed-downloader.ts)（多镜像回退：Gitee → GitHub）

CI 上传到 GitHub Release、本地 `release:publish` 上传到 Gitee Release 后，应用首次启动自动从 Gitee 下载分片、校验、合并、解压。

> **多源测速**：JRE/seed/Gradle 分片下载前会对 Gitee 与 GitHub 两个源实测速度、自动选最快的（下载进度区显示"⏱ 下载源测速"面板）。**请确保分片资产同时部署到 Gitee 与 GitHub Releases**——只部署 Gitee 时 GitHub 探测失败、按 Gitee 单源兜底（多源退化为单源）。

## Gradle 发行版资产

Gradle 9.5 发行版（`resources/gradle-9.5/`）精简后压缩约 60-90 MB，与 seed/JRE 一样部署到 Gitee Release（`mod-crafting-env`），首次启动**优先从 Gitee 下载**，未部署或下载失败时自动回退腾讯云镜像（存量用户不受影响）：

- 生成：`npm run release:split-gradle`（自动执行 strip 精简 → 压缩 `gradle-9.5.tar.xz` → 按 90 MB 分片）
- 文件命名：`gradle.part.001` ~ `gradle.part.00N` + `gradle-manifest.json`（含 SHA256 校验）
- 上传：将 `resources/gradle-shards/` 中所有文件作为独立资产上传到 `mod-crafting-env` Release（与 jre/seed 分片同 tag）
- 下载器：[`src/main/seed-downloader.ts`](src/main/seed-downloader.ts)（Gitee → GitHub 回退）+ [`src/main/build-env.ts`](src/main/build-env.ts)（Gitee 优先、腾讯云镜像兜底）

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
3. 本地构建产物（供 Gitee Release 上传）：
   - 工具链：`npm run toolchain:setup` → `toolchain:strip-gradle` → `toolchain:build-jre` → `toolchain:prefetch` → `toolchain:symbol-index`
   - 知识库：`npm run knowledge:download`
   - 应用包：`npm run build:win`
   - 分片资源：`npm run release:split-seed` → `release:split-gradle` → `release:archive-extra`（注：JDK/Gradle 走公共镜像下载，不再需要 JRE 分片）
4. 配置 `.env`（首次发布需要）：
   ```bash
   cp .env.example .env
   # 编辑 .env 填入 GITEE_TOKEN
   ```
5. 运行一条命令同时发布 GitHub + Gitee：
   ```bash
   npm run release:publish
   ```
   脚本自动完成：
   - 生成 `packaging/release-body.md` + 归档 `docs/releases/vX.Y.Z.md`
   - 创建并推送 tag 到 GitHub（触发 CI 自动构建并发布 GitHub Release）
   - 推送 git + tag 到 Gitee
   - 上传本地产物到 Gitee Release（Setup / Portable / seed 分片 / Gradle 分片 / 额外资源）

**幂等**：Gitee 已存在该版本时自动跳过 Gitee 部分，但仍会推送 tag 触发 CI。

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
| 分片 Gradle | `node scripts/release/archive-gradle.mjs` | `resources/gradle-shards/` |

## Gitee 配置

Gitee 仓库配置见 [`packaging/gitee-config.json`](packaging/gitee-config.json)（owner/repo）。

### .env 配置

`GITEE_TOKEN` 从项目根目录 `.env` 文件读取（已被 `.gitignore` 忽略，不会提交）：

```bash
cp .env.example .env
# 编辑 .env，填入 GITEE_TOKEN
```

令牌获取：https://gitee.com/profile/personal_access_tokens

也可通过系统环境变量设置（PowerShell）：

```powershell
$env:GITEE_TOKEN = "<你的 Gitee 私人令牌>"
```

### docs/releases/ 归档

每次运行 `npm run release:publish` 会将 `packaging/release-body.md` 复制到 `docs/releases/vX.Y.Z.md` 作为版本文档归档。

若 Gitee 仓库没有对应代码，会报「创建标签失败」，此时需先确保 `release:push-gitee` 成功执行（`release:publish` 已自动调用）。

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

