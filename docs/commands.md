# 命令清单

所有命令均从仓库根目录运行。Node.js 需为 22.15 或更新版本，包管理器使用 pnpm 10.34.7。

## 开发与定向验证

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run dev
pnpm start
pnpm run typecheck
pnpm test
pnpm run plugin:validate
pnpm run plugin:smoke
pnpm run workbuddy:validate
pnpm run workbuddy:smoke
pnpm run bench:fabric
```

- `build` 构建自包含 MCP 插件及 Fabric-Bench CLI，不构建桌面应用。
- `dev` 重新构建插件后启动本地浏览器工作台。
- `start` 使用 `MODCRAFTING_DATA` 启动工作台后端；URL 自带引导会话，首屏不再报 `SESSION_REQUIRED`。
- `typecheck` 覆盖 MCP/插件源码、`ui://` 卡片 bundle 和浏览器工作台三部分。
- `test` 运行 Core、浏览器、游戏协议、分发和 Qoder 打包回归。
- `plugin:smoke` 在隔离目录验证 stdio MCP 初始化、Schema、工具注解、内联卡片资源、`--text=digest`、`--web-only` 引导会话与 `--plan`。
- `workbuddy:validate` / `workbuddy:smoke` 校验 WorkBuddy 包结构，并真实执行三个钩子命令。
- `bench:fabric` 默认运行不启动 Minecraft 的离线案例。

## 插件与候选包

```powershell
pnpm run plugin:build
pnpm run plugin:stage
pnpm run workbuddy:stage
pnpm run plugin:qoder -- --source 'ABSOLUTE_CANDIDATE_PLUGIN_DIR'
pnpm run candidate:build
pnpm run acceptance:first-use
```

- `plugin:stage` 按白名单生成 Codex Plugin 目录。
- `workbuddy:stage` 复用上一步的目录，生成 WorkBuddy 插件包/专家包（含 hooks、commands、agents、专家卡）。
- `plugin:qoder` 从候选插件目录生成 Qoder ZIP；输出在 `temp/qoder-artifacts/`。
- `candidate:build` 需要系统 JDK 21 和 `JAVA_HOME`，会构建 Observer V2 并生成完整本地候选包。
- `acceptance:first-use` 验证产品入口下的新 session 首次准备流程；它不代替 Qoder 真实聊天验证。

## 安装器与分发

```powershell
pnpm run cli:test
pnpm run cli:pack:check
pnpm run bundle:stage
pnpm run claude:stage
pnpm run claude:check
pnpm run release:npm
pnpm run release:npm:publish -- --dry-run
pnpm run release:offline
node packages/modcrafting-cli/bin/modcrafting.mjs install --host cursor --dry-run
node packages/modcrafting-cli/bin/modcrafting.mjs doctor --json
```

- `cli:test` 用临时 HOME 跑 15 个宿主的写入/幂等/卸载矩阵、TOML 补丁、ZIP 防护与下载校验。
- `cli:pack:check` 执行 `npm pack --dry-run`，断言 CLI 全部文件在包内且不含 `temp/`、`plugins/`、`.env` 等。
- `bundle:stage` 产出 `temp/bundle-artifacts/modcrafting-bundle`（含 `bundle.json` 指纹），是所有安装渠道的唯一输入。
- `claude:stage` 生成提交进 git 的 Claude Code 薄插件（`.claude-plugin/plugin.json`、`.mcp.json`）与 marketplace 清单；`claude:check` 在 CI 拦截版本漂移。
- `release:npm` 生成 `modcrafting`、`modcrafting-mcp`、`modcrafting-skills` 三个 `.tgz`；`release:npm:publish` 幂等发布（已存在版本跳过）。
- `release:offline` 生成 QQ 群用的自包含离线 ZIP。
- `modcrafting install` 默认直写宿主配置并备份；`--dry-run` 只打印，`--print-snippet` 只输出片段。

## 游戏与知识

```powershell
pnpm run bench:fabric:live -- --help
pnpm run product:stage -- --help
pnpm run host:stage -- --help
pnpm run host:config -- --help
pnpm run host:smoke
pnpm run docs:sync-fabric
pnpm run release:package -- --help
```

真实游戏验证需要 JDK 21、工程 Gradle Wrapper、Observer V2 和专用测试实例。工具连接成功、游戏启动成功和玩法断言通过是不同结果；只在日志中记录实际完成的阶段。`docs:sync-fabric` 更新仓库内 Fabric 文档快照，不会启动 Minecraft。

## 交付边界

本地 Stage 与 Qoder ZIP 只生成文件，**不安装或修改宿主配置**；真正写宿主配置的只有用户显式运行的 `modcrafting install`（写前备份、幂等、只动自己的键）。`release:package` 从完整候选目录生成版本化 ZIP 和校验和，但不会推送、打标签或发布。将 `vMAJOR.MINOR.PATCH` tag 推送到 GitHub 后，Actions 会验证 tag 与 `package.json` 版本及 `release` 分支归属，通过构建与打包后创建 GitHub Release；详见 [Release 规则](../RELEASE.md) 与 [分发产物](distribution.md)。
