# modcrafting CLI

`ModCrafting Fabric` 的多宿主安装器。零依赖、无构建、源码即产物，因此可以直接从仓库运行：

```
npx -y github:newstarbar/ModCrafting#release install --auto
```

## 命令

```
modcrafting install [--host <id>|--auto|--all-detected] [--dry-run] [--json]
modcrafting mcp     [--host <id>] [--remove]
modcrafting skills  [--host <id>] [--remove] [--project]
modcrafting doctor  [--host <id>] [--json]
modcrafting update  [--bundle-version <v>]
modcrafting uninstall [--host <id>|--all-detected]
modcrafting versions
```

`install` 的 bundle 来源优先级：`--from-zip` > `--bundle-dir` > `~/.modcrafting/versions/<v>` 缓存 > GitHub Release 下载。下载后会对照 `SHA256SUMS` 与包内 `bundle.json` 双重校验。

## 会写什么

| 位置 | 内容 |
|---|---|
| `~/.modcrafting/versions/<v>/` | 校验过的 MCP bundle |
| `~/.modcrafting/data/<host>/` | 每个宿主独立的 `MODCRAFTING_DATA` |
| `~/.modcrafting/state.json` | 安装记录，`uninstall` 依据 |
| `~/.modcrafting/backups/` | 改动前的 `.bak`（保留 5 份） |
| 宿主配置 | 仅一个 `modcrafting-fabric` 条目 |
| 宿主 skills 目录 | 3 个 `SKILL.md` |

## 写入安全

- JSON 配置解析失败 → 退出码 3，零写入。
- Codex `config.toml` 用点号键、内联表或重复块 → 退出码 3，并给出手工命令。
- 内容未变则不写文件、不备份（幂等）。
- 原子写（同目录临时文件 → rename），拒绝符号链接、junction、硬链接。
- 只认自己写过的名字，不碰你的其它 MCP 服务器。

## 退出码

`0` 成功｜`1` 用法错误｜`2` 宿主歧义/未检测到｜`3` 配置冲突｜`4` 下载或校验失败｜`5` 宿主不支持。

## 目录

```
bin/modcrafting.mjs   入口
lib/args.mjs          参数、帮助、退出码
lib/paths.mjs         home / APPDATA / XDG / 根目录
lib/hosts.mjs         15 个宿主的数据注册表
lib/detect.mjs        强弱证据判定
lib/fsx.mjs           原子写、备份、JSON 读取
lib/toml.mjs          Codex config.toml 定点补丁
lib/zip.mjs           ZIP 读取（中央目录 + inflateRaw + crc32）
lib/fetch.mjs         Release 下载与 SHA256SUMS
lib/bundle.mjs        bundle 解析与校验
lib/skills.mjs        技能安装/卸载
lib/configs.mjs       宿主配置合并
lib/commands.mjs      命令编排
lib/state.mjs         安装记录
lib/report.mjs        人类 / JSON 输出
test/                 node --test 套件（临时 HOME 隔离）
```
