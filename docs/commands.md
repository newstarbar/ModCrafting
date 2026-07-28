# 常用命令

## 开发与构建

```bash
npm run dev                    # Electron 开发模式（热更新）
npm run build                  # 仅编译 TypeScript / 前端
npm run start                  # 直接运行编译后的 Electron 应用
npm run test                   # 运行 harness 单元测试
npm run build:win              # 完整 Windows 构建（Setup + Portable）
npm run build:win:setup        # 仅构建 NSIS 安装版
npm run build:win:portable     # 仅构建便携版
```

## 工具链

```bash
npm run toolchain:verify       # 检查 JDK/Gradle/Wrapper 文件是否齐全
npm run toolchain:verify-offline  # 验证离线构建流程
npm run toolchain:setup        # 下载 JDK 21 + Gradle 9.5 到 resources/
npm run toolchain:prefetch     # 预取 Fabric/Minecraft 依赖（约 1GB）
```

旧命令别名（`setup:toolchain`、`prefetch:deps`、`verify:toolchain` 等）仍可用，但优先使用 `toolchain:*` 命名空间。

## 资源准备

```bash
npm run assets:prepare         # 下载 MC 客户端 JAR + 生成物品预览（发布前）
npm run assets:mc              # 仅下载/解压 temp/minecraft-assets
npm run assets:items           # 从已解压资源生成 public/items 与 items.ts
npm run assets:icon            # 从 appIcon.png 生成 .ico
```

## 知识库下载

知识库构建已迁移到独立仓库 [ModCrafting-knowledge-base](https://github.com/newstarbar/ModCrafting-knowledge-base)，本仓库通过以下命令下载预构建的知识库资源：

```bash
npm run knowledge:download   # 下载所有离线知识库（minecraft-data + 百科向量索引 + 模型缓存）
```

## 发布与清理

```bash
npm run release:manifest       # 渲染 packaging/update-manifest.json
npm run clean:local -- --all  # 清理本地 release/out/temp 等生成物
```

## 测试

测试运行器：`scripts/test/run-harness.mjs`，自动收集 `scripts/test/harness-*.test.ts`。

新增 harness 测试放在 `scripts/test/` 下，遵循 `harness-*.test.ts` 命名规范。

| 测试文件 | 覆盖范围 |
|---------|---------|
| `harness-plan-phase-gate.test.ts` | 计划阶段门控（轮次上限、工具白名单） |
| `harness-mc-data-lookup.test.ts` | minecraft_data_lookup 工具 |
| `harness-mc-wiki-search.test.ts` | mc_wiki_search 工具 |
| `harness-knowledge-build.test.ts` | 知识库构建脚本 |

## 脚本目录结构

```
scripts/
├── toolchain/     # JDK、Gradle、Fabric 依赖种子
├── assets/        # MC 渲染资源与图标
├── packaging/     # electron-builder / NSIS
├── release/       # 发版清单与 Gitee 同步
├── knowledge/     # Minecraft 知识库构建脚本
├── test/          # harness 单元测试
├── lib/           # 跨脚本共享（ensure-native-deps、paths）
├── _archive/      # 一次性维护脚本
└── prebuild-win.mjs
```

## 发布新版本

1. 更新 `package.json` 的 `version`
2. 打 tag 并推送：`git tag v1.0.0 && git push origin v1.0.0`
3. GitHub Actions 自动构建 Setup + Portable、发布 GitHub Release、同步 Gitee
4. 详见 [`RELEASE.md`](../RELEASE.md)
