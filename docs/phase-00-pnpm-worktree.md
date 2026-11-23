# P0.5：pnpm 依赖迁移与 Worktree 共享 Store

> 状态：待 Codex 实施的独立前置任务；不代表已迁移。日期：2026-10-12。
> 执行次序：`phase-00-git-safety.md` 的 Git 保护和 Worktree 创建 → **本文 P0.5** → `phase-01-mcp-foundation.md`。
> 工作范围：只允许在 `<workspace>\ModCrafting-mcp-p1` 的隔离分支实施；原 `ModCrafting` 主工作区不得修改。

## 目标与原则

解决多个 Git Worktree 中 Node 依赖安装缓慢、磁盘占用重复的问题。迁移到 pnpm 的内容寻址 Store，**每个 Worktree 保持独立的 node_modules，多个 Worktree 复用 Store 的相同文件**。绝不把不同 Worktree 的 node_modules 指向同一个共享目录，不共享原生模块二进制状态、不复制整个 node_modules。

2026-10-12 已核对的本机条件：
- Node v24.19.0；pnpm 10.11.0；Store 为 `D:\.pnpm-store\v10`；工作区均在 `D:` 盘，具备同卷硬链接复用条件。
- 当前被 Git 跟踪的是 `package-lock.json`，**还没有** pnpm 锁文件或 pnpm workspace 配置。
- `origin/main` 新增 `scripts/setup-worktree.mjs`；此脚本会用 `npm install`，并在缺少生成数据时执行 `npm run assets:items`。**迁移前不要在新 Worktree 直接执行 `npm run setup:worktree`，否则可能再次生成或扰动 npm 锁文件。**
- `scripts/plugin/build.mjs` 当前从 `../../node_modules/electron-vite/node_modules/esbuild/lib/main.js` 导入，这是一条脆弱的**传递依赖私有路径**；迁移时必须修复。
- 依赖含 `electron`、`node-pty`、`sharp`、`esbuild`；`package.json` 含 `allowScripts` 字段，但不能假设它自动满足 pnpm 的构建脚本审批策略。
- 主仓与 Release CI 仍执行 `npm ci`；不能只转换本地安装、却留下 CI 和工作流继续使用 npm。
- Electron 官方文档对 pnpm 打包兼容性推荐 `node-linker=hoisted`。优先在**隔离 Worktree** 验证 hoisted 方案，不要一开始就对全部工作区执行安装。

## P0.5-01：确认安全隔离，禁止影响原主仓

```powershell
Set-Location '<workspace>\ModCrafting-mcp-p1'
git status --short --branch
git worktree list
node --version
pnpm --version
pnpm store path
```

必须确认当前分支为 `feat/mcp-foundation-p1`，尚未实施 P1。未确认 P0 的远端备份授权时继续遵守其限制；不可向 GitHub 自动 push。

## P0.5-02：一次性迁移锁文件

1. 先运行 `pnpm import`，根据现有 `package-lock.json` 生成 `pnpm-lock.yaml`。若转换出现依赖差异，先分析，不能直接无条件升级依赖大版本。
2. 将 **经过验证的** pnpm 版本精确固定在根 `package.json` 的 `packageManager` 字段；可先使用本机现有 10.11.0 做试验，但必须在 CI 与本地使用同一个版本。正式版本是否需要升级，应检查 Node 22 兼容性、安全维护及锁文件差异。
3. 对 Electron 兼容性，试行根级 `.npmrc` 的 `node-linker=hoisted`（对应 pnpm 10）；若版本配置方式变化，按所固定版本的官方文档调整。**hoisted 有可能降低部分布局隔离收益，但仍可以复用 Store 的包文件**。
4. 执行 `pnpm install`；排查 peer/生命周期脚本警告。不得通过跳过全部安全校验来掩盖问题。对确实需要执行的 Electron、esbuild、sharp、node-pty 等构建脚本，按固定 pnpm 版本进行最小权限的 allowlist/approve 管理。
5. 在验证通过后，将 `pnpm-lock.yaml` 作为唯一正式锁文件；再从**新工作分支**删除 `package-lock.json`，避免双锁漂移。不要修改原仓库中的 npm 锁文件。
6. 迁移暂时只处理现有根项目；不因使用 pnpm 就提前把 `packages/modcrafting-core` 改造成 Workspace 子包。以后确有多个独立 package.json 时再单独设计 `pnpm-workspace.yaml`。

## P0.5-03：修复依赖路径和 Worktree 初始化器

- 将 `scripts/plugin/build.mjs` 改为正常 `import { build } from 'esbuild'`（或等效公开入口）；将 `esbuild` 显式加入与脚本用途匹配的直接依赖（例如 devDependencies）。不可依赖 `electron-vite` 的内部目录布局。
- 检查其他 `node_modules/<package>` 硬编码路径，例如 `scripts/packaging/patch-nsis-install-ui.mjs`、`run-electron-builder.mjs`、`verify-windows-artifacts.mjs`。`hoisted` 下仍需真实测试，不要盲目批量替换。
- 重写 `scripts/setup-worktree.mjs` 的依赖安装入口为 pnpm，按锁文件状态检查是否需要 `pnpm install --frozen-lockfile`；保留原有 Electron 二进制恢复、`items.ts` 生成/复制的容错机制，但生成命令改用 `pnpm run assets:items`。**确保在 Windows 上能正确启动 pnpm 命令**。
- 不再使用 “`node_modules` 目录存在”作为依赖已满足的唯一判断；在部分安装、锁文件已变化时要能自动修复，但不能频繁全量重装。
- `scripts/lib/ensure-native-deps.mjs` 的 `postinstall` 逻辑必须检查 pnpm 布局下的 Electron 和 esbuild 是否真正可执行；同样不要在每次 Worktree 进入时重新下载完整 Electron。
- 如 Qoder SessionStart Hook 已自动调用此脚本，检查该钩子的触发时机及重复执行成本；不得引入每次会话启动自动全量安装的行为。
- 尤其不要把 pnpm Store 或 `node_modules/.pnpm` 整体复制到其他 Worktree。

## P0.5-04：让 CI 与包管理命令一致

- 将相关 workflow 的 `npm ci` 替换为在固定版本 pnpm 下的 `pnpm install --frozen-lockfile`。优先使用已有 CI Node 22，并在 CI 中明确安装/固定 pnpm 版本。
- 将 `npm run ...` 替换成 `pnpm run ...` 时，检查入口、Script 的 spawn 命令与路径假设；保持发布命令的行为一致，**不触发任何真实发布、tag、push**。
- 检查 README、AGENTS.md、docs/commands.md 中安装与工作区指令；使用兼容性说明替代一次性全局文本替换。
- 检查 Electron 打包、原生模块重建和 CI；本次仅跑本地构建/干运行或隔离测试，不上传正式 Release。
- CI 同时存在 npm 与 pnpm 时，必须明确哪个是项目的锁文件真源，避免 “CI 用 npm、本地用 pnpm”。

## P0.5-05：最低可执行验收

```powershell
Set-Location '<workspace>\ModCrafting-mcp-p1'
pnpm install --frozen-lockfile
pnpm run plugin:build
pnpm run plugin:validate
pnpm run plugin:test
pnpm run typecheck
pnpm test
pnpm run build
git status --short --branch
```

如果环境资源允许，再针对新的 Worktree 做 `pnpm run setup:worktree` 幂等复测（连续两次启动，第二次不得无意义重装/重新下载），以及 Electron 启动和 `node-pty` 加载冒烟。**真正 Windows Setup/Portable 打包在独立验证中进行**，不得只因 `pnpm run build` 成功就声称打包兼容。

验证时记录：Store 路径、Worktree 内 `node_modules` 体积（区分逻辑大小与实际占盘）、安装耗时、新旧 lock 差异、Native addon 状态，以及 CI 脚本结果。不承诺绝对节省比例。

## 完成标准（DoD）

1. 新 Worktree 用 pnpm 可重复安装，且不会扰动原仓库。
2. 固定 pnpm 版本、单一 `pnpm-lock.yaml`、CI 锁文件一致。
3. `setup:worktree` 不再隐式运行 npm install；两次运行均通过且第二次不会反复做重活。
4. `plugin:build/test/validate`、TypeScript、已有基础测试执行并记录结果。
5. Electron、esbuild、sharp、node-pty 的必要构建脚本已验证或明确标注未验证。
6. 改动局限于依赖配置、Worktree 初始化、直接依赖路径与相关 CI/文档；不开发新业务、不修改旧 Harness。
7. 在 `docs/phase-00-pnpm-report.md` 记录变化、验证结果、未验证边界和需要回滚的风险。
8. 只有完成本阶段才开始 P1；否则保留原有 npm 基线，不提交半迁移状态。

## 给 Codex 的执行提示词

请先阅读 `docs/phase-00-git-safety.md` 与本文件。确认 GitHub 备份和新 Worktree 安全状态后，仅在 `ModCrafting-mcp-p1` 执行 pnpm 迁移。不要修改原 main，不执行 push、重置、clean 或发布。按 P0.5-01 至 P0.5-05 开发与验证；保留原有行为、最小改动。特别修复 `scripts/plugin/build.mjs` 对 electron-vite 内部 esbuild 路径的依赖，更新 `scripts/setup-worktree.mjs`、lockfile 与 CI。完成后写 `docs/phase-00-pnpm-report.md`，未通过测试必须如实说明。不要直接开始 P1。
