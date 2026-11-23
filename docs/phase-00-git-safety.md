# P0：ModCrafting 改造前 GitHub 备份与隔离工作区

> 日期：2026-10-12。**P0 必须先于 P1-01～P1-06 执行**。本文件提供执行步骤，不表示已经创建 Git 分支或推送 GitHub。

## 1. 仓库现状（重新执行前须复核）

- 原工作区：`<workspace>\ModCrafting`，本地 `main` = `b40e1fa`；现有 `origin/main` = `6e68512`，落后两个提交。
- 远端两个提交：`da47e3e`（运行时目录配置）和 `6e68512`（提供 `npm run setup:worktree`）。
- 原工作区未跟踪：`Python/`、`docs/phase-01-mcp-foundation.md`、`failures*.txt`、`test_output*.txt`。不能删除，不能误加入 Git。
- 备份分支只指向 **已提交的历史状态**，未跟踪文件不随分支备份；如需保全它们，须另做本地离线备份。

## 2. P0-1 只读检查

```powershell
Set-Location '<workspace>\ModCrafting'
git status --short --branch
git branch -vv
git log -1 --oneline main
git log -1 --oneline origin/main
git log --oneline main..origin/main
git worktree list
```

如果状态与本文快照不同，先审查差异，避免覆盖并行工作。

## 3. P0-2 保存原始 main 提交到备份分支

**此步需要仓库拥有者授权，特别是远端 push。不得自行更改远端、强制覆盖备份引用或泄漏私有数据。**

```powershell
# 保留当前 main 提交，不切换分支或修改文件
git branch backup/pre-mcp-p1-20261012 main

# 仓库拥有者明确批准后才推送 GitHub
git push -u origin backup/pre-mcp-p1-20261012
```

若备份分支已存在，核对其指向，不得使用 `--force`。远端备份成功后：

```powershell
git ls-remote --heads origin backup/pre-mcp-p1-20261012
```

注意：这里保存的是**原 Desktop 主线已提交的代码快照**，不含未跟踪文档和日志；不建议将可能包含个人信息的日志直接 push 到 GitHub。

## 4. P0-3 从最新 origin/main 新建开发 Worktree

```powershell
Set-Location '<workspace>\ModCrafting'
# 只更新远端引用，不合并、不重置原 main
git fetch origin
git log --oneline main..origin/main

# 如果该分支或目录已存在，先停下检查，切勿覆盖
git worktree add -b feat/mcp-foundation-p1 ..\ModCrafting-mcp-p1 origin/main

# 本阶段文档尚未被跟踪，单独复制，不复制 Python、日志或用户配置
Copy-Item -LiteralPath '.\docs\phase-01-mcp-foundation.md' -Destination '..\ModCrafting-mcp-p1\docs\phase-01-mcp-foundation.md'
Copy-Item -LiteralPath '.\docs\phase-00-git-safety.md' -Destination '..\ModCrafting-mcp-p1\docs\phase-00-git-safety.md'
Copy-Item -LiteralPath '.\docs\phase-00-pnpm-worktree.md' -Destination '..\ModCrafting-mcp-p1\docs\phase-00-pnpm-worktree.md'

Set-Location '..\ModCrafting-mcp-p1'
git status --short --branch
git worktree list
```

新 Worktree **应以最新远端主线为起点**，同时原 main 和未跟踪文件完全不动。

## 5. P0-4 恢复开发环境与创建开发基线

> **pnpm 迁移更新（2026-10-12）**：Worktree 创建成功后，优先执行 [`phase-00-pnpm-worktree.md`](./phase-00-pnpm-worktree.md) 的 P0.5 迁移。**下方 `npm run setup:worktree` 是远端旧脚本的原始用法，不再作为直接执行步骤**；因为其内部会触发 `npm install`。应先按 P0.5 将 Worktree 初始化、锁文件、CI 改为 pnpm，再运行更新后的 `pnpm run setup:worktree`。若 pnpm 迁移失败，不在原 main 上尝试修复。

新的 `origin/main` 已添加 `scripts/setup-worktree.mjs`。先检查脚本的读写目标与磁盘消耗，再运行：

```powershell
Set-Location '<workspace>\ModCrafting-mcp-p1'
Get-Content .\scripts\setup-worktree.mjs -TotalCount 160
# 确认脚本行为后：
# 先依照 phase-00-pnpm-worktree.md 完成 P0.5，旧 npm bootstrap 不再直接执行
# 下列命令只在 P0.5 迁移通过后使用：
pnpm run setup:worktree
pnpm run plugin:build
pnpm run plugin:validate
pnpm run plugin:test
```

如果 Worktree 部署后没有 Node/Electron/Java 或本地资源，先使用新增 bootstrap 脚本，不要直接复制整个 node_modules。脚本若可能更改原工作区文件，先暂停排查。

开发初始文档建议在**新分支**中单独提交，但须遵守仓库约定并由使用者决定提交与推送时机。禁止混入任何未跟踪日志或个人配置。

## 6. P0 验收条件

1. `git worktree list` 显示原 `main` 与新 `feat/mcp-foundation-p1`。
2. 原工作区 HEAD、分支以及用户未跟踪文件与操作前一致。
3. 新 Worktree 从已确认的最新 `origin/main` 创建，已取得 P1 开发文档。
4. 如果用户批准了 GitHub 备份，远端存在 `backup/pre-mcp-p1-20261012`，并确认 SHA；否则如实写“远端备份待授权”。
5. 新 Worktree 中插件现有基线命令执行并记录实际结果；失败只做记录，禁止宣称已通过。
6. 完成上述安全检查后才执行 `docs/phase-01-mcp-foundation.md`。

## 7. 给 Codex 的 P0 执行权限边界

- P0 的检查可以直接执行，但不得自行推送、删除、重置或切换原主分支。
- 备份分支 push、Worktree 创建等有状态操作须先获得仓库拥有者明确许可；若只是阅读本文件，不表示已授权执行。
- `npm run setup:worktree` 必须先阅读源码再运行。
- 任何出错时停在当前步骤，输出状态，不通过强制清理解决。

**最终交付：** 新分支隔离开发环境与 P0 记录；不进行 P1 的功能开发。