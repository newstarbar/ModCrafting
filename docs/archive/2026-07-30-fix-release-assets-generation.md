# 修复 Release 资源生成目录

**归档日期**：2026-07-30
**触发方式**：自动（修改构建流程）
**涉及文件数**：5
**问题类型**：Bug 修复 / 构建流程

## 背景

GitHub Actions 的 Release 工作流在执行 `npm run assets:prepare` 时失败，报错为无法创建 `src/renderer/src/data/items.ts`。

## 根因分析

`items.ts` 是由资产生成器产生的文件，并已被 `.gitignore` 忽略。开发机上该文件通常已经存在，因此它的父目录也存在；但 GitHub Actions 从干净工作区检出代码时，`src/renderer/src/data/` 不存在。生成器创建了 public 资源目录，却没有在写入 `items.ts` 前创建数据目录。

## 改动清单

| 文件路径 | 改动类型 | 说明 |
| --- | --- | --- |
| `scripts/assets/generate_items.py` | 修改 | 写入生成索引前递归创建父目录。 |
| `package.json` | 修改 | 将应用版本升级至 1.0.1，用于新的补丁版发布。 |
| `package-lock.json` | 修改 | 同步根包版本。 |
| `docs/archive/README.md` | 修改 | 登记本次归档。 |

## 关键决策

使用新的 `v1.0.1` 标签触发 Release，而非移动已存在的 `v1.0.0` 标签；这样可保留原有发布记录，并确保安装包版本、标签和更新清单一致。

## 验证方式

- 将生成器输出重定向到一个不存在父目录的临时路径，完整运行物品与预览资源生成；成功生成 1121 个物品索引。
- 运行 `npm run test`；381 项测试全部通过。

## 经验教训

被忽略的生成文件不能作为 CI 目录存在性的隐式前提。每个生成器都应在写入目标文件前自行创建父目录，确保在本地缓存和干净检出环境中行为一致。

## 后续修复：NSISBI 校验失败

`v1.0.1` 的 Release 在构建 NSIS 安装包时失败。`run-electron-builder.mjs` 在本地 NSISBI 缺失时把 Base64 SHA-512 值传给 electron-builder 的 `customNsisBinary` 下载配置；该下载路径按校验文件格式解析该值，因而在下载完成后报“Could not parse checksum file”。

Release 工作流现在会缓存并显式执行 `setup-nsisbi.mjs`；打包脚本也会在本地工具包缺失时同步执行该初始化脚本，再通过 `ELECTRON_BUILDER_NSIS_DIR` 使用已验证的本地工具包。移除了有问题的临时下载配置。

验证：`node --check` 检查两个打包脚本、`node scripts/packaging/setup-nsisbi.mjs`、`npm run build` 均通过。应用版本提升至 `1.0.2`，使用新标签触发发布。
