---
name: client-gui-hud
description: Screen / HUD 从预览确认到代码落地，再到游戏内数据化验证的完整流程。
---

# 客户端界面与 HUD

前置约束（必须先 `gui_layout_preview` 拿到用户确认的布局才能写 GUI 代码）由宿主强制，本节讲的是确认之后怎么做。

## 1. layoutType 决定实现载体

| layoutType | 落地方式 |
|------------|----------|
| `option-list` | 原版设置列表：`SimpleOption` + `OptionListWidget`，不要自己排版坐标 |
| `custom-screen` | 继承 `Screen`，用 `init()` 里的相对坐标居中（`width`/`height` 自适应，别写死 1280×720） |
| `hud-overlay` | `HudRenderCallback`（ClientModInitializer 注册），按 `drawOptions` 缩放计算 |

预览里每个元素的 `data-layout-id` / `data-layout-type` 与确认后的坐标，就是控件的 id、类型和初始位置；把它们映射成真实控件，不要重新发明布局。

## 2. 预览 HTML 的边界

预览 HTML 只描述视觉：absolute 定位的 div，带 `data-layout-id`、`data-layout-type`，1280×720 画布。**禁止** `<button>`、`<input type="button">`、`onclick`、确认/取消按钮和 `<script>`——宿主会剥离，确认由外层 UI 负责。

## 3. 侧别

GUI 代码只能在客户端：`ClientModInitializer` / `@EnvironmentEnvType.CLIENT` 的类里。把 `Screen` 引到 common 注册类会触发服务端崩溃。

## 4. 游戏内验证

进入测试世界后：

1. 先 `mc_inspect` 取结构化结果（当前界面类型、控件列表、玩家状态）。它比截图可靠，也是非视觉模型唯一能自证的途径。
2. HUD 类要确认热键：`mc_test_scenario` 的 `hotkey` 参数传实际按键，再用 `mc_input` 触发。
3. 截图 `mc_screenshot` 仅作展示与用户复核。视觉模型可直接分析截图；**不支持图片的模型禁止声称「截图显示正常」**，改述 mc_inspect 数据，或明确标注「需用户手动确认」。
4. 颜色、动画、渲染质感这类 mc_inspect 覆盖不到的效果，一律标注需用户确认，不要当作通过。
