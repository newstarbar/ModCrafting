# 第三方组件与许可声明

本文档列出 **ModCrafting** 在开发与分发过程中涉及的主要第三方软件、库与资源，及其许可信息摘要。

> **说明**
>
> - ModCrafting **源码**以 [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) 发布（见仓库根目录 `LICENSE` 或 `package.json`）。
> - 本文档**不构成法律意见**；完整条款以各上游项目的官方许可文本为准。
> - 安装包面向最终用户的补充说明见 [`packaging/license_zh_CN.txt`](packaging/license_zh_CN.txt)。

---

## 不包含的内容

| 项目 | 说明 |
|------|------|
| **Minecraft 游戏本体** | ModCrafting 不分发 Minecraft。用户须自行拥有合法游戏副本，并遵守 [Minecraft EULA](https://www.minecraft.net/zh-hans/eula)。 |
| **Mojang / Microsoft 商标** | 「Minecraft」等商标归其权利人所有。ModCrafting 与 Mojang / Microsoft **无官方关联**。 |
| **用户 API Key** | DeepSeek 等 AI 服务密钥由用户自行配置，仅存于本机，不由本仓库分发。 |

---

## 一、安装包捆绑的运行时组件

以下组件在 `npm run prefetch:deps` 与打包流程完成后，随 Windows 安装包 / 便携版一并分发（位于安装目录 `resources/` 下）：

| 组件 | 版本（当前锁定） | 许可 | 上游 |
|------|------------------|------|------|
| **Eclipse Temurin JDK** | 21（LTS） | GPL-2.0 with Classpath Exception | [Adoptium](https://adoptium.net/) |
| **Gradle** | 9.5.0 | Apache-2.0 | [gradle.org](https://gradle.org/) |
| **Gradle Wrapper JAR** | 随项目 | Apache-2.0 | [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html) |
| **Gradle 依赖缓存种子** (`gradle-home-seed`) | 见下文 | 各依赖自有许可 | 由 `prefetch:deps` 生成 |

### Gradle 依赖缓存种子（`gradle-home-seed`）

`npm run prefetch:deps` 会联网下载 Fabric 开发所需 Maven 构件并写入 `resources/gradle-home-seed/`。其中主要包括（版本见 [`resources/fabric-versions.json`](resources/fabric-versions.json)）：

| 组件 | 当前版本 | 典型许可 | 上游 |
|------|----------|----------|------|
| **Minecraft 客户端 / 服务端 JAR**（开发用） | 1.21.4 | Mojang 资产使用条款（非 OSS） | Mojang |
| **Fabric Loader** | 0.16.10 | Apache-2.0 | [FabricMC](https://github.com/FabricMC/fabric-loader) |
| **Fabric API** | 0.116.0+1.21.4 | MIT / Apache-2.0（模组内声明） | [FabricMC](https://github.com/FabricMC/fabric) |
| **Fabric Loom**（Gradle 插件） | 1.17.12 | Apache-2.0 | [FabricMC](https://github.com/FabricMC/fabric-loom) |
| **Yarn Mappings** | 1.21.4+build.1 | CC0-1.0（映射数据） | [FabricMC/yarn](https://github.com/FabricMC/yarn) |
| **传递依赖**（ASM、TinyRemapper、LWJGL 等） | 随解析结果 | 多为 Apache-2.0 / MIT / BSD | Maven Central 等 |

缓存目录内另有数百个传递依赖 JAR，其许可以各构件 `META-INF` 或 POM 为准。生成完整清单可在预取项目目录执行：

```bash
cd resources/_prefetch_project
./gradlew dependencies --configuration compileClasspath
```

---

## 二、开发辅助模组（可选捆绑）

打包配置可将 `resources/_base_mods/*.jar` 复制到安装包的 `_base_mods/`，并在打开项目时同步至 `.modcrafting/base-mods/`，供 `runClient` 本地运行时加载。

| 模组 | 典型文件名 | 许可 | 上游 |
|------|------------|------|------|
| **Mod Menu** | `modmenu-*.jar` | MIT | [TerraformersMC/ModMenu](https://github.com/TerraformersMC/ModMenu) |

> 若仓库中未包含对应 JAR，打包时该目录为空，不影响核心功能。自行放入 JAR 时须遵守其上游许可。

---

## 三、npm 运行时依赖（`dependencies`）

应用运行时打包进 `app.asar`（`node-pty` 部分解包）：

| 包名 | 版本（锁定见 `package-lock.json`） | 许可 | 仓库 |
|------|-------------------------------------|------|------|
| `electron` | ^42.4.1 | MIT | [electron/electron](https://github.com/electron/electron) |
| `react` | ^19.1.0 | MIT | [facebook/react](https://github.com/facebook/react) |
| `react-dom` | ^19.1.0 | MIT | [facebook/react](https://github.com/facebook/react) |
| `@electron-toolkit/utils` | ^4.0.0 | MIT | [alex8088/electron-vite](https://github.com/alex8088/electron-vite) |
| `@xterm/xterm` | ^6.0.0 | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| `@xterm/addon-fit` | ^0.11.0 | MIT | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) |
| `iconv-lite` | ^0.7.2 | MIT | [pillarjs/iconv-lite](https://github.com/pillarjs/iconv-lite) |
| `node-pty` | ^1.1.0 | MIT | [microsoft/node-pty](https://github.com/microsoft/node-pty) |

### Electron 内置 Chromium 与 Node.js

Electron 发行版内嵌 **Chromium** 与 **Node.js**，其许可见 Electron 源码树中的 `LICENSE` / `LICENSES.chromium.html`。分发 ModCrafting 安装包时，这些组件随 Electron 一并提供。

---

## 四、npm 开发与构建依赖（`devDependencies`）

仅用于开发与打包，**不**随最终用户安装包的核心业务逻辑直接运行，但可能参与构建产物生成：

| 包名 | 版本（见 `package-lock.json`） | 许可 | 仓库 |
|------|----------------------------------|------|------|
| `electron-vite` | ^5.0.0 | MIT | [alex8088/electron-vite](https://github.com/alex8088/electron-vite) |
| `electron-builder` | ^26.0.0 | MIT | [electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) |
| `vite` | ^8.0.16 | MIT | [vitejs/vite](https://github.com/vitejs/vite) |
| `@vitejs/plugin-react` | ^6.0.2 | MIT | [vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |
| `typescript` | ^5.8.3 | Apache-2.0 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) |
| `@types/react` | ^19.1.2 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react-dom` | ^19.1.2 | MIT | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |

`electron-builder`、`electron-vite` 等工具另有大量传递依赖，完整树见 `npm ls` 或 `package-lock.json`。

---

## 五、NSIS 安装程序

Windows 安装包由 [electron-builder](https://www.electron.build/) 调用 **NSIS** 生成。NSIS 及相关插件许可见其官方发布包。自定义安装逻辑见 [`packaging/installer.nsh`](packaging/installer.nsh)。

---

## 六、GPL-3.0 与上游许可的兼容性说明

ModCrafting 以 **GPL-3.0** 发布时：

- 与 **MIT / Apache-2.0 / BSD** 等宽松许可的上游库通常可组合分发，须保留其版权声明与许可全文。
- **Electron（MIT）**、**React（MIT）** 等与 GPL 应用组合分发在常见理解下可行，但仍须遵守 GPL 对**完整对应源码**的要求。
- **JDK（GPL-2.0 + Classpath Exception）** 作为独立捆绑运行时，一般按 Classpath Exception 与应用程序区分；具体解读请咨询法律顾问。
- **Minecraft 资产**非开源软件，仅通过 Fabric 工具链在**用户本机**用于开发测试，不由 ModCrafting 重新许可。

---

## 七、应用更新与下载镜像

- **应用更新**：Setup 完整版通过 `electron-updater` 从 **Gitee Releases（优先）** 与 **GitHub Releases（备用）** 获取 `latest.yml` 与安装包；版本清单见 [`packaging/update-manifest.json`](packaging/update-manifest.json)。
- **便携版工具链**：首次运行从 **Adoptium**、**Microsoft JDK**、**Gradle 官方** 或 **腾讯云 Gradle 镜像** 下载，不由 ModCrafting 重新分发。

---

## 八、如何更新本文件

1. 升级 `package.json` 中直接依赖后，核对 `package-lock.json` 内各包 `license` 字段。  
2. 升级 [`resources/fabric-versions.json`](resources/fabric-versions.json) 后，重新运行 `npm run prefetch:deps` 并更新第二节版本表。  
3. 新增捆绑 JAR（如 `_base_mods`）时，在第二节补充一行并链接上游仓库。  
4. 发布前运行：

   ```bash
   npm ls --all --json | node -e "/* 可选：自定义脚本汇总 license */"
   ```

---

## 九、联系

如发现本文档遗漏、许可标注错误或疑似侵权，请通过 [GitHub Issues](https://github.com/newstarbar/ModCrafting/issues) 或 Security Advisory 联系维护者。

---

*最后更新：与 ModCrafting 1.0.0 / Fabric 1.21.4 工具链锁定一致。*
