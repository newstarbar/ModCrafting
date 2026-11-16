---
description: "打包当前模组并解释结果。"
argument-hint: "[工程绝对路径] [gradle 任务，默认 build]"
---

按 `fabric-mod-development` 的构建约定执行。

1. 创建或恢复本任务的 `sessionId`（`modcrafting_session`）。
2. 先 `fabric_validate`；有 error 级诊断就先修，不要带着错误构建。
3. `fabric_build_start`（`projectPath` 用 `$ARGUMENTS` 的第一个参数，`task` 默认 `build`）。
4. 轮询 `fabric_job_status` 直到 `completed` / `failed` / `stopped`；用 `minecraft_log_read` 分页看失败原因，不要把整段 Gradle 输出贴给用户。
5. 汇报：产物路径、耗时、失败的首个根因与修复建议。
