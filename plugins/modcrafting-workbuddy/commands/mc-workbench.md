---
description: "打开可视化工作台。"
argument-hint: "[模块：overview|content|textures|paint|recipe|gui|model|build|game|tests|reports]"
---

1. 恢复本任务 `sessionId`，并确认工程路径。
2. 调用 `modcrafting_open_workbench`，`view` 取 `$ARGUMENTS`（为空则 `overview`），`mode` 用 `builtin`。
3. 返回值里的 `browserUrl` 直接交给 `present_files`，在宿主内置浏览器打开。
4. 不要用 Shell、`Start-Process`、`explorer.exe` 打开浏览器，也不要另起一个工作台服务。
5. 在用户确认看到页面之前，不要说"已打开"；如果打不开，把 `code`（例如 `WORKBENCH_DISABLED`、`BROWSER_OPEN_FAILED`）和下一步做法讲清楚。
