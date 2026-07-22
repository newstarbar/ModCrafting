# 归档脚本

不再纳入日常 npm scripts 的维护/恢复工具。需要时可直接 `node scripts/_archive/<name>` 运行。

| 脚本 | 用途 |
|------|------|
| `finalize-seed.mjs` | 中断的 prefetch 后，将 `_prefetch_runtime/gradle-home` 复制到 seed |
| `tint-water-textures.mjs` | 一次性生成 MC 水面贴图着色 |
| `verify-user-project.mjs` | 手动验证用户项目工具链路径 |
| `prefetch-fabric-docs.ts` | 从 docs.fabricmc.net 抓取知识库文档 |
