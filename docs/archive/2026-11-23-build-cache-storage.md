# 2026-11-23 构建缓存智能落盘（减轻系统盘压力）

## 背景

新模组第一次构建会把 Gradle 发行包、依赖、Loom/Minecraft 缓存和可能自动下载的 JDK 写进 `GRADLE_USER_HOME`，通常是几 GB。此前插件把默认数据目录放在 `%LOCALAPPDATA%\ModCrafting\fabric-plugin`，缓存又固定在 `<数据目录>/cache`，默认安装就会压在 C 盘；只有用户手动设置 `GRADLE_USER_HOME` 或把整个数据目录搬到其他盘才能缓解。用户要求在不重新下载、不误删旧缓存的前提下，让构建缓存默认避开系统盘。

## 决策

1. **数据根与缓存根分离**。`dataRoot` 继续保存 session、日志、报告、备份等小文件；新增 `cacheRoot`，其下 `gradle/` 作为 `GRADLE_USER_HOME`（Gradle 发行包、依赖、Loom/Minecraft、自动 JDK），`tmp/` 作为 Gradle 子进程的 `TEMP/TMP`。原 `storage.gradleUserHome` / `temporaryDirectory` 字段保留。
2. **固定解析顺序**：`MODCRAFTING_CACHE` → 已设置的 `GRADLE_USER_HOME` → 保存过的 `<dataRoot>/storage.json` → 已存在的 `<dataRoot>/cache`（兼容旧安装，避免重新下载）→ 自动选盘。
3. **Windows 自动选盘只选固定盘**：先复用其他宿主留下的缓存标记（`<盘>:\ModCrafting\cache\.modcrafting-cache.json`，工程所在盘优先，否则剩余空间最大）；数据目录在非系统盘时用 `<数据目录>/cache`；否则工程在非系统盘时用 `<工程盘>:\ModCrafting\cache`；否则系统盘低于 20 GB 时选剩余空间最大的固定盘（至少 10 GB）；都不满足时回退数据目录并给出提示。网络盘、可移动盘不参与自动选择。
4. **选择稳定、可跨宿主复用**。自动选择在首次真实构建时写入 `storage.json` 与缓存标记，后续不随剩余空间变化来回切换；其他宿主识别到标记后复用同一目录。检查状态只读，不创建目录。
5. **构建时统一环境**。`startGradle` 使用解析出的 `GRADLE_USER_HOME`、`TEMP`、`TMP`，并在构建日志首行报告实际缓存路径、来源和提示。`visual-assets` 查找 `minecraft-client.jar` 时按同一组候选路径（`MODCRAFTING_CACHE` / `storage.json` / `GRADLE_USER_HOME` / 插件缓存 / `~/.gradle` / `.minecraft`），不再写死 `~/.gradle`。
6. **迁移与清理必须显式**。`modcrafting_toolchain` 新增 `storage`（只读报告，含有上限的体积统计）、`storage-write`（保存绝对 `cacheRoot`）、`migrate`（需 `confirm=true`，复制当前 Gradle 缓存后切换，旧目录保留）、`clean`（需 `confirm=true`，只删除插件标记的未活动缓存或旧 `<dataRoot>/cache`，拒绝当前活动缓存、工程目录、盘根和任意未标记目录）。插件不会自动迁移或删除旧缓存。若 `MODCRAFTING_CACHE` 或 `GRADLE_USER_HOME` 仍优先于保存的配置，`storage-write` 与 `migrate` 的结果会明确提示先修改或移除该环境变量。
7. **枚举失败可回退**。Windows 盘符与剩余空间通过 PowerShell CIM 查询，3 秒超时并缓存 60 秒；失败时使用 `fs.statfs` 或直接回退数据目录，不阻塞构建。

## 产物

| 文件 | 说明 |
|---|---|
| `packages/modcrafting-core/src/storage.ts` | 解析优先级、自动选盘、持久化、标记、体积统计、迁移与清理 |
| `packages/modcrafting-core/src/node.ts` | `SystemToolchainProvider` 接入缓存解析；`startGradle` 注入缓存环境与日志；storage 动作 |
| `packages/modcrafting-core/src/runtime.ts` | `modcrafting_toolchain` 的 storage 动作分发与 confirm 门禁 |
| `packages/modcrafting-core/src/contracts.ts` | `EnvironmentStatus.storage` 扩展为完整 `StorageStatus` |
| `packages/modcrafting-core/src/visual-assets.ts` | 客户端素材按插件缓存路径查找 |
| `plugins/modcrafting-fabric/src/mcp-server.ts` | 工具 schema、描述和新手可读的下一步说明 |
| `scripts/test/harness-storage.test.ts` | 26 个用例：优先级、选盘、持久化、迁移、清理、工具门禁、路径查找 |
| `docs/qoder-user-guide.md`、`docs/install.md`、`docs/core-contracts.md`、两份 `modcrafting-start` 技能 | 用户与 Agent 指引 |

## 验证

- `node --experimental-strip-types --test scripts/test/harness-storage.test.ts`：26/26。
- `pnpm run plugin:typecheck`：通过。
- `pnpm test`：392/392，全量 focused suite 通过（含新增 storage harness）。
- `pnpm run candidate:build`：bench / builder / observer / plugin / stage 全部通过，`compatibility.json` 的 `coreBundleSha256` 已按新构建刷新。
- `node scripts/plugin/stage-qoder.mjs --source <候选插件目录>`：生成 0.2.2 Qoder ZIP，版本与 `coreBundleSha256` 校验一致。
- `pnpm run plugin:smoke`：重建后的候选包 43 个工具、协议、环境状态、web 入口与 plan 均 PASS；真实游戏未运行。
- `pnpm run claude:check`：Claude 插件与 marketplace 已同步到 0.2.2。
- 旧缓存行为：已有 `<dataRoot>/cache/gradle` 时仍返回 `source=existing`，不触发重新下载；迁移测试确认源目录保留。

## 边界

- 迁移是同步复制，缓存很大时会等待较长时间，当前不提供进度条；工具描述要求先停止构建和游戏。
- 不迁移工程内的 `run/`、`.gradle/`、`build/`，也不控制宿主自身的缓存；这些仍在用户选择工程目录时所在的盘。
- 自动选盘只在 Windows 生效；其他平台保持 `<dataRoot>/cache`。
