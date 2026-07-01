# 发布说明

Release 正文由 CI **自动生成**，无需每次手改 Markdown。格式参考 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases)。

## 自动生成的内容

打 tag `v*` 推送后，[`scripts/render-release-notes.mjs`](scripts/render-release-notes.mjs) 会生成 `build/release-body.md`，包含：

- 中文标题与文档链接
- Setup / Portable 下载表（GitHub + Gitee 直链）
- 版本选择、升级说明、合规提示
- **变更日志**：从 `git log` 按 commit 信息自动归类为「新增 / 修复 / 优化」
- Compare 链接（如 `v1.0.0...v1.0.1`）

该文件用于：

- **GitHub Release**（`electron-builder --publish`，`draft: false` 直接发布）
- **Gitee Release**（`sync-gitee-release.mjs` 同步正文与附件）

## 发布流程

1. 更新 `package.json` 的 `version`
2. 提交代码，commit 信息建议使用规范前缀（便于自动归类）：
   - `feat:` / `新增:` → ✨ 新增
   - `fix:` / `修复:` → 🐛 修复
   - `perf:` / `优化:` / `refactor:` → 🔧 优化
   - `chore:` / `ci:` / `build:` → 默认不展示在 Release 正文
3. 打 tag 并推送：`git tag v1.0.1 && git push origin v1.0.1`
4. GitHub Actions 自动：构建 → 发布 GitHub Release → 同步 Gitee → 更新 `build/update-manifest.json` 到 main

## Gitee 配置

见 [`build/gitee-config.json`](build/gitee-config.json)。GitHub Actions 还需 Secret `GITEE_TOKEN`。

CI 发版时会先执行 `push-gitee-git.mjs`（把当前 commit + tag 推到 Gitee），再 `sync-gitee-release.mjs` 上传附件。若 Gitee 仓库没有对应代码，会报「创建标签失败」。

## 本地预览 Release 正文

```bash
node scripts/render-release-notes.mjs v1.0.0
# 输出 build/release-body.md
```
