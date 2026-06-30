# Release 说明模板

发布新版本时，可将以下内容作为 GitHub / Gitee Release 正文（由 CI 或手动填写）。

---

## ModCrafting v{version}

### 下载（国内用户推荐 Gitee）

| 版本 | 说明 | Gitee | GitHub |
|------|------|-------|--------|
| **完整版 Setup** | 内置 JDK/Gradle/Fabric 离线依赖，安装后可离线使用；支持应用内更新 | [Gitee 下载]({gitee_setup_url}) | [GitHub 下载]({github_setup_url}) |
| **便携版 Portable** | 体积小（~100MB），首次启动需联网下载环境（约 1GB） | [Gitee 下载]({gitee_portable_url}) | [GitHub 下载]({github_portable_url}) |

### 如何选择

- **日常开发 / 网络不稳定**：选 **Setup 完整版**
- **U 盘 / 临时机器 / 可接受首启下载**：选 **Portable 便携版**

### 升级说明

- **已安装 Setup 用户**：启动应用 → **帮助 → 检查更新**（优先 Gitee 源，失败自动切换 GitHub）
- **若应用内更新失败**：从 [Gitee 发布页](https://gitee.com/newstarbar/ModCrafting/releases) 或 [GitHub Releases](https://github.com/newstarbar/ModCrafting/releases) 手动下载安装包覆盖安装
- **便携版用户**：下载新版 Portable，替换旧目录中的 exe

### 变更日志

- （在此填写本版本更新内容）

### 开发者发布流程

1. 更新 `package.json` 的 `version`
2. `git commit` 并打 tag：`git tag v1.0.x && git push origin v1.0.x`
3. GitHub Actions 自动构建 Setup + Portable，发布 GitHub Release，并同步 Gitee（需配置 `GITEE_TOKEN`）
4. 确认 `build/update-manifest.json` 已更新到 main 分支
