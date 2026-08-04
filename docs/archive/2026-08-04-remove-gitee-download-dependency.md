# 移除 Gitee 下载依赖 · GitHub + gh.xmly.dev 代理加速重构

**归档日期**：2026-08-04
**触发方式**：大功能改动自动触发
**问题类型**：下载源策略重构

## 背景

旧分发策略：Gitee 主仓承载发布二进制，Gitee 环境仓（`mod-crafting-env`）承载 seed/jre shards、extra-zips 等环境产物，作国内加速主源；GitHub 作为兜底。

问题：
- Gitee 环境仓维护成本高，需双仓同步 tag/release。
- Gitee API 不稳定，分片配额 1GB 容易撑爆。
- `ghproxy.com` 已失效（http=000 超时），`gh-proxy.com` 极慢（100KB/s），旧代码还在用 `ghproxy.com/${githubUrl}` 拼接 fallback。
- 用户体验差：环境产物下载只在 Gitee 通畅时快，Gitee 一抖动整个首启流程就拖时间。

## 决策

- **统一源**：所有 GitHub 资产下载统一走 `https://gh.xmly.dev/` 反代加速，常量集中到 `src/main/github-mirror.ts`。
- **双源测速选优**：每个 GitHub asset 同时构造「gh.xmly.dev 代理」与「GitHub 直连」两版本，主进程用 `pickFastestUrls` 实测首字节延迟，取最快。
- **Gitee 退化为浏览器备用入口**：`DEFAULT_RELEASE_PAGES.gitee` 与 `openReleasePages()` 保留，让用户在 GitHub 直连不畅时可手动浏览器下载 Setup/Portable；Gitee 不再承载环境产物。
- **失效代理清理**：JDK 候选源移除 `gh-proxy.com`，仅保留「清华 TUNA 主源 + api.adoptium.net + GitHub 直连」三源；不再引入新的 gh.xmly.dev（国内 TUNA 镜像已足够快）。
- **打包侧 manifest 走代理**：`packaging/update-manifest.json` 的 `feeds.github.manifest/setup/portable` 改为 `https://gh.xmly.dev/https://github.com/...` 包裹形式，由 updater 直接喂给 `autoUpdater`。

## 主要改动

| 范围 | 内容 |
|---|---|
| `src/main/github-mirror.ts`（新建） | `GITHUB_PROXY_PREFIX`、`wrapGithubProxy(url)`、`githubDirectAndProxy(url)` → `{direct, proxied}` |
| `src/main/updater.ts` | 删除 `MANIFEST_URLS.gitee` / `preferredMirror`；`fetchManifestWithFallback` 改为 `github-proxy → github`；source 类型 `'github' \| 'github-proxy'`；`downloadFromSource` 用 `manifest.feeds.github.manifest`（打包时已包裹代理）；失败引导浏览器打开 Release 页 |
| `src/main/seed-downloader.ts` | 删除 `loadGiteeEnvRepo` / `giteeEnvRepo` / `GITEE_RELEASE_BASE`；`fetchManifest` 改 `pickFastestUrls` 双源；`getSeedReleaseInfo()` 返回 `{ tag, githubBase, githubProxyBase }`；`downloadAndExtract*Shards` 函数标注 `@deprecated`（harness 测试断言要求保留） |
| `src/main/knowledge-downloader.ts` | 删除 `KB_REPO_GITEE_OWNER/REPO`；`resolveKnowledgeReleaseTag` 仅查 GitHub API，asset URL 用 `githubDirectAndProxy` 构造直连 + 代理两版本；`ensureKnowledgeBase` 阶段 1/2 候选源均改为双源 `pickFastestUrls` |
| `src/main/toolchain-download.ts` 与 `scripts/toolchain/toolchain-download.mjs`（双份同步） | `JDK_MIRROR_URLS_WIN_X64` 移除 `gh-proxy.com`，保留 `[TUNA_JDK_URL, api.adoptium.net, GITHUB_JDK_URL]` |
| `scripts/knowledge/download-knowledge-base.mjs` | 移除 `queryGiteeRelease`、`GITEE_OWNER/REPO`；asset URL 用本地 `wrapGithubProxy` 拼 `https://gh.xmly.dev/ + url`；`downloadFile(proxied, direct, ...)` 先试代理失败回退直连 |
| `scripts/release/sync-gitee-release.mjs` | 删除 `collectSeedShards` / `collectJreShards` / `collectExtraResources` 死函数；删除 `resolveGiteeEnvRepo` import 与 `envRepo` 变量；注释说明仅上传 Setup/Portable |
| `scripts/release/gitee-config.mjs` | 移除 `resolveGiteeEnvRepo` / `giteeEnvUrls` 导出与 `FALLBACK_ENV`；`readFileConfig` 不再读 `envRepo` 字段 |
| `scripts/release/render-update-manifest.mjs` | 新增 `wrapGithubProxy` 本地实现；`feeds.github.manifest/setup/portable` URL 全部包裹代理；`releasesPage` 保持直链 |
| `packaging/gitee-config.json` | 移除 `envRepo` 字段，仅留 `owner/repo` |
| `packaging/update-manifest.json` | `feeds.github` 的 manifest/setup/portable URL 改为 `https://gh.xmly.dev/https://github.com/...` 形式 |
| `scripts/release/publish-release.mjs` | 头部注释说明 Gitee 仅上传 Setup/Portable；环境产物见 GitHub Release + gh.xmly.dev 代理 |
| `src/preload/index.ts` / `src/renderer/src/vite-env.d.ts` | `checkForUpdates` 返回类型 `source?: 'gitee' \| 'github'` → `'github' \| 'github-proxy'` |
| `src/renderer/src/components/SessionSidebar.tsx` | 在「关于 ModCrafting」section 前新增「检查更新」按钮，调用 `window.api.checkForUpdates()` 显示结果，订阅 `window.api.onUpdateStatus` 显示下载进度（`downloading`/`downloaded`/`error`） |
| `RELEASE.md` / `docs/toolchain.md` / `AGENTS.md` | 文档同步更新：发布流程说明 Gitee 仅 Setup/Portable，工具链移除 ghproxy/gh-proxy，AGENTS 维护红线新增「GitHub + gh.xmly.dev 代理」与「Gitee 仅承载发布二进制」两条 |

## 验证

- `npx electron-vite build` 通过（main / preload / renderer 三段）。
- `node scripts/test/run-harness.mjs` 全部通过：398/398 项不退化。
- `grep "gitee.com" src/main/` 仅余 `src/main/updater.ts:45` 的 `DEFAULT_RELEASE_PAGES.gitee`（浏览器 URL，符合预期）。
- `grep "ghproxy\.com|gh-proxy\.com"` 仅余注释中说明已失效的引用，无实际使用。

## 经验

- **代理加速常量集中化**：以后再换 GitHub 代理时只需改 `github-mirror.ts` 的 `GITHUB_PROXY_PREFIX` 一个常量，所有下载器、打包脚本、知识库脚本自动同步。
- **双源测速而非硬编码优先级**：网络环境千差万别，硬编码「先代理后直连」在代理抖动时反而更慢；`pickFastestUrls` 实测首字节延迟选优是更鲁棒的方案。
- **死代码标注 `@deprecated` 而非删除**：`harness-packaging-runtime.test.ts` 断言 `buildEnv` 不包含 `downloadAndExtract*Shards` 函数名；这些函数虽然不再被运行时调用，但测试通过反向断言它们「不存在于 buildEnv」来验证主进程不再依赖它们。删除会导致断言失效；标注 `@deprecated` 保留函数体让测试通过。
- **打包侧 manifest URL 也走代理**：updater 把 `manifest.feeds.github.manifest` 直接喂给 `autoUpdater.setFeedURL`，所以这个 URL 本身必须是代理包裹形式，否则国内用户更新检查都会卡。
