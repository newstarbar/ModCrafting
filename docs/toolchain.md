# 工具链与首次初始化

ModCrafting 仅支持 Windows x64。安装版和便携版使用同一套首次初始化管线：完整 Temurin JDK 21、Gradle 9.5、Fabric/Loom、Minecraft 依赖、游戏资源和一次离线 Fabric 构建。

## 运行时目录

| 版本 | 运行时目录 |
|---|---|
| Setup | `%LOCALAPPDATA%\ModCrafting\runtime` |
| Portable | `PORTABLE_EXECUTABLE_DIR\runtime` |
| 开发模式 | 仓库 `runtime/` |

Setup 升级和卸载不会删除 `%LOCALAPPDATA%` 中的运行时。旧版位于 exe 邻近目录的完整缓存会在首次启动时迁移并校验；不完整缓存不会被当作完成状态。

## 下载和校验

- JDK 固定为 Temurin `21.0.12+8` Windows x64。必须同时包含 `java.exe`、`javac.exe`、`jar.exe` 和匹配版本的 `release` 文件。
- Gradle 固定为 `9.5.0`。JDK、Gradle 下载支持 `.part`、Range 续传、空闲超时、重试、SHA-256 校验和原子替换。
- JDK 优先 GitHub 代理源（ghproxy.com / gh-proxy.com 代理 Adoptium GitHub release，国内加速），Adoptium API + GitHub 直连作为官方兜底；Gradle 优先腾讯云/华为云，官方回退。
- Minecraft libraries、版本清单和 assets 优先 BMCLAPI，Mojang 官方回退；文件由 Mojang 清单的大小和 SHA-1 校验。
- `net.fabricmc` 坐标始终路由到 `maven.fabricmc.net`，不会先访问已知返回 404 的公共国内 Maven。

初始化前会检查至少 3GB 空闲空间，并使用单实例与跨进程初始化锁保护 staging、Gradle 缓存和完成凭据。

## 完成条件

环境只有在下列步骤全部成功后才会写入完成凭据并显示 100%：

1. JDK 和 Gradle 校验；
2. Fabric Loader、Yarn、Fabric API 与 Loom 缓存；
3. Minecraft client/server、映射和游戏资源；
4. Loom `downloadAssets`；
5. 同一缓存下的 `gradlew build --offline --no-daemon`。

完成凭据记录版本、缓存规模、asset 验证和离线构建结果。启动时会快速复核凭据和关键文件；缺失或版本变化只修复受影响部分。

## 进度、取消与诊断

界面显示六步：JDK、Gradle、Fabric/Loom、Minecraft、游戏资源、离线验证。下载任务展示来源、当前文件、字节/文件数、速度和 ETA；未知总量的 Gradle 任务不会伪造百分比。取消会结束 Gradle 进程树并保留可续传的下载和缓存。

初始化错误会带错误 ID、阶段、是否可重试和技术原因。界面可重试、打开日志或导出诊断包；日志位于运行时 `logs/`，会脱敏并轮转。可选知识库、向量搜索或 OpenCode 失败时为“部分功能未就绪”，不阻塞核心构建环境。

## 本地命令

```bash
npm run toolchain:verify       # 开发资源的静态检查
npm run toolchain:verify-offline # 离线构建检查
npm test
npm run build:win              # Setup + Portable + Windows 产物门禁
```

发布包不再内置或生成 JRE、Fabric seed、Gradle seed，也不再上传这些大文件分片到 Gitee。
