# 游戏实测范式改革：Test Design 强制步 + Observer GUI 容器槽位自动化

**日期**: 2026-10-04
**改动范围**: plan-compiler / step-policy / workflow-engine / game-test-protocol / mc-test-scenario-tool / mc-observer-tools / bridge-mod (InputActions + GameQueries)

---

## 背景问题

1. **测试设计被模板替换**：`mc_test_scenario` 六类散文模板主导行为，`createGameTestSpec` 在缺 actions 时只注入 `give`/`summon`，没有为机制搭沙盒的意识。
2. **计划阶段禁止写测试、执行阶段又逼立刻出 V2 规格**：AI 在没读完实现的机制前就被逼填断言，只能套模板。
3. **GUI/合成能力断层**：Observer 只有 `click_widget`（Screen children），没有 `HandledScreen` 槽位点击；`new_recipe` 模板却假装能「打开合成台→验证产物」。

---

## 落地改动

### Phase 1 — `test_design` 强制步

**计划编译器**（`plan-compiler.ts`）：
- 新增 `test_design` kind（与 `game_test` 并列）
- `appendHostTerminalSteps` 在 `needsGameTest` 时插入 `test_design` → `game_test` 两步
- 固定顺序：`实现* → build → run → test_design → game_test`

**step-policy.ts**：
- `test_design` 白名单：`read_file / grep / list_directory / minecraft_data_lookup / mc_wiki_search / mc_inspect / mc_inventory / mc_world / mc_observe_entity / mc_test_scenario`
- 禁止：写产品代码、`mc_run_test`、`complete_step` 绕过

**workflow-engine.ts**：
- `isValidTestDesignScenarioResult()`：验证 V2 规格含 `acceptanceContract`、`actions` 非空、至少一条机制相关断言
- `test_design` 完成后自动将 `gameTest` 传播到紧随的 `game_test` 步

**plan-normalizer.ts**：
- `canonicalizePlanSteps` 插入 `test_design` 并在无 `game_test` 时自动创建
- `defaultMaxAttempts('test_design') = 8`
- `inferKind` 将「设计游戏测试场景」描述映射到 `test_design`

**controller.ts** 系统提示：
- 旧「按散文步骤手搓验证」叙述替换为强制 `test_design` 流程
- 明确 `test_design` 只允许读代码/世界/注册场景

### Phase 2 — 沙盒原语

**game-test-protocol.ts**：
- `SandboxPreset` 类型：`flat_platform | enclosed_arena | stimulus_pad | crafting_station | skip`
- `SANDBOX_COMMANDS` 映射表：`enclosed_arena` = 玻璃/屏障围栏 + 顶盖
- `resolveSandbox()`：`entity_behavior` 默认 `enclosed_arena`（字段级强制）
- `expandSandboxCommands()`、`composeSetup()` 宿主展开器
- `createGameTestSpec`：传入 `sandbox` 参数自动编排 setup

**mc-test-scenario-tool.ts**：
- `FEATURE_SCAFFOLDS` 新增六类脚手架：可观测维度 + 推荐断言类型 + 默认沙盒 + 设计流程提示
- 输出模板改为：设计脚手架（核心）→ 旧散文步骤（参考附录）→ V2 注册格式示例

### Phase 3 — Observer GUI 容器槽位自动化

**bridge-mod / GameQueries.java**：
- `screen()` 新增 `containerSlots`（槽位数组）、`containerHandlerType`、`containerSyncId`、`cursorStack`
- `containerOf()`：检测 `AbstractContainerScreen` → 通过 `getScreenHandler` 导出所有槽位（index、itemId、count、componentFingerprint）
- `stackFingerprint()`：确定性指纹（item id + NBT + damage）

**bridge-mod / InputActions.java**：
- 新增 `click_slot` action：`{ slot, button?, shift? }` → `interactionManager.clickSlot`
- 新增 `boolVal()` 辅助方法

**bridge-mod / GameTestApi.java**：
- `capabilities` 声明 `containerAutomation: { containerSlots, slotClick }`
- snapshot 顶层透出 `containerSlots`/`containerHandlerType`/`containerSyncId`/`cursorStack`

**game-test-protocol.ts**：
- `SnapshotSource` 新增 `containerSlots`
- `validateActions`：action 允许集新增 `click_slot`；`click_slot` 要求 `args.slot`

**game-test-runner.ts**：
- `snapshotSource()` aliases 新增 `containerSlots → containerSlots`
- `snapshot_value` / `snapshot_changed` / `snapshot_relation` 自动路由到 container slots

**mc-observer-tools.ts**：
- `mcInputTool` schema 新增 `slot`、`shift` 参数

### Phase 4 — 测试与文档

- 新增 `harness-test-design-step.test.ts`：test_design 插入/顺序/推进
- 新增 `harness-sandbox-protocol.test.ts`：沙盒 preset/sandbox 字段/fingerprint/containerSlots
- `docs/harness.md` 新增沙盒与 test_design 章节
- `docs/workflow.md` 更新终端顺序图与 `test_design` 流程

---

## 非目标（本轮不做）

- 不恢复截图自动 PASS
- 不做任意像素 CV；GUI 裁决以 container/slot/screen/widget/HUD 结构化证据为准
- 不在 Plan 阶段强制写满 actions

---

## 关键风险

1. Observer `AbstractContainerScreen` 反射访问可能在版本间断裂 → 已 try-catch
2. `click_slot` 需要 `interactionManager` 非空 → 已在 bridge 侧检查
3. `resolveSandbox` 的字段级拒绝需与 `createGameTestSpec` 入口同步 → 已实现
