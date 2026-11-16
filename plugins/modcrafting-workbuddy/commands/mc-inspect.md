---
description: "检查工程与环境，给出能不能开始开发的结论。"
argument-hint: "[工程绝对路径]"
---

按 `modcrafting-start` 的沟通约定执行，不写任何文件。

1. 调用 `modcrafting_environment_status`，工程路径取 `$ARGUMENTS`（为空则不传）。
2. 如果工程存在，再调用 `fabric_project_inspect`；如果 `fabric_validate` 有明显错误，一并列出。
3. 输出三段：**现在能做什么** / **缺什么（JDK、Gradle Wrapper、资源、版本）** / **下一步一条命令级建议**。
4. 只读：不要建工程、不要下载资源、不要启动游戏。
