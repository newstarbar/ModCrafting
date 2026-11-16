# GitHub Actions 与 Release 规则

`release` 是 Fabric/Qoder Plugin 的发布主线；`main` 保留旧版 Desktop 历史，不参与新产品构建和发布。GitHub Release 不再使用 Windows Setup/Portable、Gitee 上传、旧自动更新索引或 Desktop 安装器规则。

## 持续集成

`.github/workflows/plugin.yml` 在针对 `release` 的 Pull Request、推送和手动运行时执行 Windows x64 检查：

- Node.js 22、pnpm 10.34.7 与锁文件安装。
- Core/工作台类型检查、Fabric 插件回归、MCP 协议 Smoke。
- 插件 manifest、白名单 Stage 和 Fabric-Bench 离线案例。
- Minecraft 真实玩法不在 CI 中启动；fixture 结果只验证离线断言与错误分类。

CI 只拥有 `contents: read` 权限。它不上传候选安装包、不访问宿主账户，也不发布 Release。

## 版本与发布

1. 在 `release` 分支更新根 `package.json` 和 `plugins/modcrafting-fabric/.codex-plugin/plugin.json` 的产品版本，并完成 [候选验收记录](docs/candidate-validation.md) 中适用的人工验收。
2. 创建并推送与 `package.json` 完全一致的版本 tag，例如 `v0.2.0`。稳定版使用 `vMAJOR.MINOR.PATCH`；预发布版可使用 `v0.2.0-rc.1`。
3. `.github/workflows/release.yml` 复用 CI 检查，并拒绝版本不匹配或不属于 `release` 历史的 tag。随后在 Windows x64 / JDK 21 上从当前 tag 构建完整 Observer V2 候选包。
4. Actions 创建 7 类资产：Qoder 桌面 Plugin ZIP、多宿主插件包、MCP bundle ZIP、Skills ZIP、离线安装 ZIP、构建信息 JSON、SHA-256 清单，并发布到 GitHub Releases。稳定版显式标记为 Latest，以免旧 Desktop 的 `v1.0.x` 标签继续显示为新产品；预发布版标记为 prerelease，不抢占 Latest。创建/上传是幂等的：重跑同一 tag 时已存在则走 `gh release upload --clobber` 并重新断言状态，不再因 422 失败；也可本地用 `pnpm run release:upload -- --directory <目录> --tag <tag>` 补传。
5. Release 创建后，若仓库配置了 `NPM_TOKEN` secret，Actions 会发布 `modcrafting`、`modcrafting-mcp`、`modcrafting-skills` 三个 npm 包（已存在的版本跳过）；没有凭据时该步骤整体跳过，`npx github:...` 通道不受影响。

tag 是发布触发器。GitHub Actions 不会自行递增版本或创建 tag；不得把旧版 `v1.0.x` tag 重用于新产品。旧 Release 留作历史记录，不由此流程改写或删除。

## 本地打包

设置 JDK 21 并运行 `pnpm run candidate:build`，再补充分发产物：

```powershell
pnpm run bundle:stage
pnpm run release:npm
pnpm run release:offline
pnpm run release:package -- --candidate-json 'D:\path\to\candidate.json' --output-root 'D:\path\to\release-output' --tag 'v0.1.8'
```

`release:package` 需要 `temp/bundle-artifacts/modcrafting-bundle` 已存在，并校验其 `dist/mcp-server.js` 指纹与候选收据一致。所有命令只生成本地文件，不推送 tag、不创建远端 Release、不发布 npm，也不修改宿主配置。tag 必须与当前 package 版本一致。

资产名与校验和见 [分发产物](docs/distribution.md)；资产命名格式 `<Name>-<tag>.zip` 是安装器下载逻辑的契约，不要改。

## 发布证据边界

Actions 证明本工作流运行的静态检查、构建和文件打包通过。它不会登录 Qoder、驱动宿主聊天或自动启动交互式 Minecraft。需要真实玩法或宿主聊天结果时，应先按候选验收记录完成并保存证据，再推送版本 tag。Release 说明和随包 `release-info.json` 会明确写出 CI 未执行的验收项。
