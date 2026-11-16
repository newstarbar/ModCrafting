# 2026-11-16 多渠道安装与分发（npx / npm / 插件 / 离线包）

## 背景

此前只有"Stage 出目录 / ZIP，用户手动搬到宿主"的分发方式。用户要求：仓库级 `npx` 安装、完整插件包、独立 skill 包、独立 MCP 包、GitHub 一句话给 Agent 安装、QQ 群下载后一句话安装，覆盖 15 个宿主（Codex、Claude Code、Cursor、Devin CLI、Devin Desktop、OpenCode、Pi、ZCode、DeepSeek Harness、Qoder、Trae、WorkBuddy、CodeBuddy、GitHub Copilot、Kimi）。

## 决策

1. **一份 bundle，四条出口**。`bundle:stage` 产出带 `bundle.json` 指纹清单的运行时目录，npx 下载、npm 包、离线 ZIP、Release 资产全部复用，避免四套打包逻辑漂移。
2. **构建产物不进 git**。安装器首次运行时从 GitHub Release 下载 `ModCrafting-MCP-<tag>.zip` 并校验 SHA-256 + 包内指纹；`--from-zip` / `--bundle-dir` 支持断网与 CI。
3. **CLI 零依赖、零构建、无 `prepare`**。`npx github:` 只安装 `dependencies`，一旦有构建步骤就会拉 esbuild/React 直接失败；同时不建 `packages/*/dist/`，因为 `.gitignore` 的 `dist/` 会匹配任意层级并被 `npm pack` 继承。
4. **默认直写宿主配置，但有边界**。写前 `.bak`、原子落盘、只增删 `modcrafting-fabric` 一个键、内容不变不写、拒绝符号链接/硬链接。Codex `config.toml` 用定点文本补丁而非全量解析，遇点号键/内联表/重复块直接退出 3 并给手工命令。
5. **检测用强弱证据**。目录存在为强证据，环境变量为弱证据；多个强证据且无环境指向时退出 2 并列出候选，绝不"猜一个"或"全装"。
6. **未验证宿主只做已存在路径**。Trae、Kimi 标 `partial`：父目录不存在就不写、不创建猜测路径，skills 未验证就只写 MCP。
7. **npm 双通道但门控**。仓库已有 `NPM_TOKEN` 才发布 `modcrafting` / `modcrafting-mcp` / `modcrafting-skills`，否则整步跳过，`npx github:` 不受影响；版本在打包时从根 `package.json` 注入，不新增人工 bump 点。

## 产物

| 产物 | 说明 |
|---|---|
| `packages/modcrafting-cli/` | 安装器（13 个 lib 模块 + 57 个测试） |
| `PROMPT.md` | 给 Agent 的一句话安装原文（GitHub / 离线 / 排错码） |
| `docs/install.md` | 15 宿主矩阵、已验证/部分验证、退出码、排错 |
| `docs/distribution.md` | bundle 契约、npm 包、资产清单、版本 bump |
| `.claude-plugin/marketplace.json` + `plugins/modcrafting-claude/` | Claude Code 薄插件（MCP 走 `npx modcrafting-mcp@<v>`），`claude:check` 防版本漂移 |
| `scripts/plugin/stage-bundle.mjs` | `bundle.json` 契约生产 |
| `scripts/release/package-npm.mjs` / `publish-npm.mjs` | 三包打包与幂等发布 |
| `scripts/release/package-offline.mjs` | QQ 群离线包（CLI + bundle + install.cmd/sh + PROMPT.md） |
| `scripts/release/check-npm-pack.mjs` | `npm pack --dry-run` 白名单门禁 |

Release 资产从 4 类扩到 7 类：Qoder ZIP、多宿主 ZIP、MCP ZIP、Skills ZIP、Offline ZIP、Release-Info、SHA256SUMS。

## 验证

- `cli:test` 57/57（临时 HOME，覆盖 14 宿主写入→幂等→卸载、TOML 补丁 12 例、ZIP 防护 5 例、下载校验 5 例、CLI 行为 13 例、路径 4 例）。
- `cli:pack:check`：29 文件 / 177KB，CLI 全量入包且不含 `temp/`、`plugins/`、`.env`。
- `plugin:validate`、`plugin:smoke`（36 工具、3 卡片、`--text=digest`、`--web-only`）、`workbuddy:smoke`（钩子真实执行）全通过；`typecheck` 通过。
- 手工端到端：伪造候选收据跑通 `release:package`（7 资产 + SHA256SUMS + Release-Info），离线 ZIP 解压后 `install --bundle-dir` 成功，MCP tarball 解包后 `--self-test` 返回 `ok:true`。
- 已知：`pnpm test` 在本机工作区因既有的未跟踪 `src/` 与本地 core 改动有失败项，与本次分发改造无关；分发相关测试（host-distribution、qoder-plugin）10/10 通过。

## 边界与未做

- 真实 `npx github:newstarbar/ModCrafting#release` 需在干净 runner 上冒烟（受本机网络与 git 缓存影响，未在此环境验证）。
- 原生插件清单只补了 Claude Code（已验证且零成本）；Cursor / OpenCode / Pi / Trae / Copilot / Kimi 走 CLI 安装，不做未验证的 marketplace 猜测。
- dsh 只支持官方命令委派（`dsh mcp add` / `dsh plugin add`），不直写 profile。
