---
name: evidence-and-step-completion
description: 步骤为什么被判缺证据，以及拿到证据的唯一有效动作。
---

# 步骤证据与完成判定

宿主只认工具真实产出的产物，不认「看起来已经做好了」。`complete_step` 被 `blocked: [step_evidence_required]` 拒绝时，按本节处理。

## 什么算证据

- 本项目步骤所需的写入类工具真实返回的产物路径：`write_file` / `edit_file` / `fabric_mixin_register` / `create_recipe` / `fabric_recipe_generate` / `fabric_data_assets_generate` / `fabric_content_register` 等。
- 校验类工具返回的结构化 `validation`（`recipe` / `mixin` / `mod_json` / `game` 四类）与 `artifactPaths`。
- 同一步骤自己产出的证据才计入该步骤；**上一步真实写出的产物可以跨步采纳**，但宿主会先提示再采纳，不需要你重复写一遍文件。

## 什么不算证据

- 文件在磁盘上已经存在。重写类步骤的目标文件本来就存在，磁盘状态不能证明本步骤做了改动。
- 只读结果：`read_file`、`list_directory`、`grep`、`explain_code`、各类知识检索。
- 与步骤目标无关的校验器返回 `ok: true`（例如要写 Mixin 源码，却只校验 `fabric.mod.json`）。

## 被拒绝后的唯一正确动作

拒绝文案会点名缺哪个路径。直接对那个路径执行 `edit_file`（已读过该文件时优先）或 `write_file`，然后再 `complete_step`。

**不要重复调用同一个校验器试图「凑出」证据**——连续两次缺证据会进入 `evidence_deadlock` 并暂停任务，届时需要用户介入。

## 预算语义

- 「已用 N/N 轮」有两种含义：护栏强制停止时会区分真实消耗轮次与步骤预算，以日志里的 `loopIterations` 为准。
- 纯只读探索轮会累积探索计数；`read_skill` 与知识检索属于免费轮次，不会消耗写入预算。看到自己在连续空转就立刻转为写文件。
