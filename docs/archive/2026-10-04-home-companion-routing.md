# 默认单厂多模型路由（伴厂=补短板/第三方检测）

## 背景

内置路由曾把角色钉到 DeepSeek + 智谱 + 通义 + Kimi + MiniMax 五家，用户几乎必须配齐多把 Key。DeepSeek 已具备多模态能力，视觉不再默认需要第二厂。

## 决策

- **默认**：主厂商（默认 DeepSeek）单厂多模型协作；Flash / Pro / 同厂视觉按角色与难度分配。
- **伴厂商**：最多 1 个，定位为补主厂短板或第三方检测（如 `codeReviewer`），不是「专供视觉」。
- **专家槽**：`codeReviewer` 可挂伴厂；`visualReviewer` 预留（游戏/视觉审查），**本阶段不钦定游戏测试最佳模型**，默认仍走主厂多模态。
- **≥3 厂**：仅用户自定义预设。

## 实现要点

- `ModelRoutingConfig`：`homeProviderId`、`companionProviderId?`、`companionExpertRoles`
- `buildHomeProviderLadder` / `materializePresetForHome`：内置预设按主厂梯队物化；伴厂仅覆盖选定专家角色
- SettingsCenter：主厂商 + 高级伴厂专家勾选
- ComposerModelMenu：固定模型优先主厂，其它厂商折叠

## 涉及文件

- `src/shared/model-routing.ts`
- `src/renderer/src/components/SettingsCenter.tsx`
- `src/renderer/src/components/ComposerModelMenu.tsx`
- `scripts/test/harness-model-routing.test.ts`
- `docs/harness.md` / `docs/workflow.md` / `docs/architecture.md`

触发：产品默认路由策略重构。
