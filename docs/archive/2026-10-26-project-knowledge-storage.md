# 2026-10-26 知识库随工程存放

## 变更

`modcrafting_prepare_assets`、`minecraft_data_lookup`、`mc_wiki_search`、`fabric_docs_search` 增加可选 `projectPath`。传入时知识资源下载并读取自该工程的 `.modcrafting/knowledge`（Fabric 文档在 `.modcrafting/assets`），随工程存放；未传入时保持原后端 `MODCRAFTING_DATA` 行为。`fabric_recipe_workspace`、`fabric_content_workspace`、`fabric_gui_workspace` 的原版数据校验与物品目录按请求内 `projectPath` 读取同一份工程知识库；`modcrafting_environment_status` 在传入 `projectPath` 时报告工程内资源状态与路径。工作台"准备离线资料"同样携带当前工程路径。`minecraft_data_lookup`、`mc_wiki_search` 缺资源时的错误信息附带实际查找目录。`fabric_project_scaffold` 新工程 `.gitignore` 写入 `.modcrafting/` 与 `run/`。

动机：用户在空文件夹首次使用插件时，知识库此前默认落到宿主 `QODER_PLUGIN_DATA`（C 盘 `%USERPROFILE%\.qoder\plugins\data\`）；改为随工程存放后不占用户全局目录，工程自带知识环境。

## 验证

- `pnpm run typecheck` 通过；`plugin:build` 产出 28 工具 bundle。
- `plugin:test` 122/123：唯一失败为 `harness-modcrafting-plugin-core.test.ts` 的 release 分支检查，原因是仓库根存在 2026-10-24 的未跟踪残留 `src/renderer/`（非本轮产物，测试断言根目录无 `src/`）。
- 新增用例：工程级准备写入 `<project>/.modcrafting` 且后端 knowledgeRoot 不被创建；四套工作区夹具迁移到工程级知识库后 21/21 通过。
- 本机 Git Bash PATH 使 `spawnSync('tar')` 解析到 GNU tar（把 `C:\` 当远程主机，报 `Cannot connect to C: resolve failed`），需 System32 bsdtar 优先才能跑 tar 相关用例；与本次功能无关，未改测试基础设施。
- 未做：真实 Qoder 模型聊天工具调用、游戏内验收、新候选包安装验证。
