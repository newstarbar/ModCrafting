# 确定性游戏内测试 V2

日期：2026-08-09

## 背景

旧的游戏验证把客户端启动、截图或一次检视混同为功能成功，且 GUI 默认目标可能错误地覆盖物品、方块和配方测试，导致测试草率或错误地自动修复。

## 实施

- 新增 `game_test` 工作流步骤，与 `run` 分离；仅 V2 `mc_run_test` 返回 `PASS` 可推进。
- 新增 `GameTestSpec`、`GameTestSession`、结构化断言、会话级新鲜证据和 `PASS/FAIL/INCONCLUSIVE` 裁决。
- `mc_test_scenario` 保留旧模板并支持生成 V2 规格；`submit_plan.gameTest` 会编译为独立测试步骤。
- 使用 `ModCrafting Test World` 和固定区域执行环境准备、动作、断言、清理；会话报告写入应用数据目录。
- 观察桥新增 `/v2/capabilities`、`/v2/command`、`/v2/snapshot`、`/v2/query`。V1 仍可操作但不能形成弱成功。
- 环境、导航、缺少桥接能力和纯视觉结果统一为 `INCONCLUSIVE`；相同功能断言在独立清理后的两次失败才进入自动修复。

## 验证

- `npm test`
- `npm run bridge:build`
- `npm run build`

真实游戏冒烟测试仍需在开发者本机以专用世界运行六类场景后确认；本次实现不把桥接未覆盖的配方查询或纯视觉布局伪装为通过。
