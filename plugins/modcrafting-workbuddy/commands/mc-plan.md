---
description: "跑一次无头回归并归档报告。"
argument-hint: "[计划文件绝对路径，默认 <工程>/.modcrafting/plans/regression.json]"
---

按 `workbuddy-workflow` 的自动化约定执行。

1. 计划文件路径取 `$ARGUMENTS`，为空则用工程下的 `.modcrafting/plans/regression.json`。
2. 在 Git Bash 里执行：`node "${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.js" --plan="<计划文件>"`。
3. 只读 stdout 的单行 JSON，不要读 stderr 的进度行。
4. `verdict` 为 `PASS` 说明通过；`FAIL` 列出失败的 `op` 与 `code`；`INCONCLUSIVE` 必须写成"暂时无法验证"，并说明是环境、能力还是证据问题——不得表述为通过。
5. 用 `present_files` 打开 `reportPath`，再用 `LibraryUpload` 把报告归档到资料库，最后给出本地路径与归档结果。
