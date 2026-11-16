# 分发产物与发布流程

一份已验证的运行时 bundle，四条出口。所有出口共用 `bundle.json` 契约，版本号只在根 `package.json` 维护。

## 依赖关系

```
plugin:build      → plugins/modcrafting-fabric/dist/mcp-server.js
plugin:stage      → temp/plugin-artifacts/modcrafting-fabric   （8 文件 + skills 白名单）
bundle:stage      → temp/bundle-artifacts/modcrafting-bundle   （+ bundle.json 指纹清单）
candidate:build   → temp/candidate-artifacts/run-*/{product,distribution,candidate.json}
release:npm       → temp/npm-artifacts/{modcrafting,modcrafting-mcp,modcrafting-skills}-<v>.tgz
release:offline   → temp/offline-artifacts/ModCrafting-Offline-v<v>.zip
release:package   → 7 个 Release 资产（含 SHA256SUMS 与 Release-Info）
```

`bundle:stage` 必须在 `plugin:stage` 之后、`release:package` 之前运行；CI 已按此顺序接线。

资产可重入：`pnpm run release:upload -- --directory <本地 release 目录> --tag v0.1.8`。Release 不存在时创建，已存在时用 `gh release upload --clobber` 覆盖并重新断言 Latest/prerelease；上传前会按 `SHA256SUMS` 逐个校验 7 个文件。

## bundle.json 契约

```json
{
  "bundleVersion": 1,
  "name": "modcrafting-fabric",
  "version": "0.1.8",
  "minecraft": "1.21.4",
  "entry": "dist/mcp-server.js",
  "skills": ["fabric-game-validation", "fabric-mod-development", "modcrafting-start"],
  "dataPlaceholder": "MODCRAFTING_DATA",
  "files": { "dist/mcp-server.js": "<sha256>", "...": "..." }
}
```

安装器在解包到 `versions/<version>/` 之前校验每个文件的 SHA-256；任一不符即中止，不写宿主配置。

## npm 包

| 包 | 内容 | 用途 |
|---|---|---|
| `modcrafting` | 根仓库 `files` 白名单（CLI + PROMPT.md + docs/install.md） | `npx modcrafting install`，与 `npx github:...` 同一份代码 |
| `modcrafting-mcp` | `dist/mcp-server.js`、assets、skills、bundle.json、启动 shim | 宿主 `.mcp.json` 里用 `npx -y modcrafting-mcp@<v>` |
| `modcrafting-skills` | 3 个 `SKILL.md` + `index.json` | 只想要技能时使用 |

三者的 `version` 在打包时从根 `package.json` 注入，没有第四个需要手动 bump 的文件。

发布由 `.github/workflows/release.yml` 在 GitHub Release 创建之后执行，`NPM_TOKEN` 缺失时整步跳过；`publish-npm.mjs` 会先 `npm view` 判断版本是否已存在，重跑 tag 不会 403。

## Release 资产

| 资产 | 用途 |
|---|---|
| `ModCrafting-Fabric-Qoder-Plugin-<tag>.zip` | Qoder 扩展面板导入 |
| `ModCrafting-Fabric-Multi-Host-<tag>.zip` | Codex / Claude Code / Qoder CLI 插件目录 |
| `ModCrafting-MCP-<tag>.zip` | 仅 MCP bundle（安装器联网下载的就是它） |
| `ModCrafting-Skills-<tag>.zip` | 仅技能包 |
| `ModCrafting-Offline-<tag>.zip` | QQ 群离线包（CLI + bundle + 启动脚本 + PROMPT.md） |
| `ModCrafting-Fabric-Release-Info-<tag>.json` | 版本、commit、target、Observer 指纹、验收边界 |
| `ModCrafting-Fabric-SHA256SUMS-<tag>.txt` | 全部资产的 SHA-256，安装器据此校验下载 |

资产名带 tag 后缀是有意为之：安装器按 `<Name>-<tag>.zip` 拼 URL，改名会让所有老版本客户端失效。

## 版本 bump 清单

`X.Y.Z`：Z = 本地验证轮次，Y = 发行版变更，X = 大版本。

1. 根 `package.json.version`
2. `plugins/modcrafting-fabric/.codex-plugin/plugin.json.version`
3. `pnpm run plugin:build`（重新生成 `compatibility.json`，不要手改）
4. `pnpm run plugin:stage && pnpm run bundle:stage`
5. `pnpm run candidate:build`（需要 JDK 21 与 `JAVA_HOME`）
6. `pnpm run product:stage` → `pnpm run host:stage`
7. `pnpm run release:npm` / `release:offline` / `release:package`
8. 推 `vX.Y.Z` tag

CLI 没有自己的版本文件：`modcrafting --version` 直接读根 `package.json`，`install` 默认下载与 CLI 同版本的 bundle。

## 本地边界

以上命令只写 `temp/` 与显式 `--output-root`，不推送 tag、不创建 Release、不发布 npm、不修改宿主配置。真正安装只发生在用户运行 `modcrafting install` 时。
