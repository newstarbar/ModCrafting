---
title: GUI 布局规范与相对坐标
description: 禁止硬编码绝对坐标；所有自定义 Screen / HUD 必须基于 this.width / this.height 计算相对位置。
authors:
  - ModCrafting
---

:::warning
**硬约束**：禁止在 Screen / HUD 中出现 `bounds(40, 40, ...)`、`drawText(..., 40, 40, ...)` 这类绝对坐标。
所有位置必须基于 `this.width` / `this.height` 计算。违反此规范的代码不得通过 code review。
:::

## 为什么禁止硬编码{#why-no-hardcode}

Minecraft 客户端运行在多种分辨率下：1280x720、1920x1080、2560x1440、4K、超宽屏等。硬编码绝对坐标会导致：

- **错位**：在 1280x720 下居中的按钮，在 2560x1440 下偏左
- **重叠**：多个绝对定位元素在不同分辨率下互相覆盖
- **超出屏幕**：`y = 700` 在 720p 下刚好到底，在更小窗口下直接不可见
- **GUI 缩放失效**：用户调整"GUI 缩放"后元素位置完全错乱

## 相对坐标核心公式{#core-formulas}

### 1. 水平居中

```java
// 居中绘制宽度为 W 的元素：左边 = this.width / 2 - W / 2
int buttonX = this.width / 2 - 100;  // 按钮宽 200，左偏 100
ButtonWidget.builder(Text.of("完成"), callback)
    .dimensions(buttonX, this.height - 28, 200, 20)
    .build();
```

### 2. 垂直布局

```java
// 距顶部 N 像素
int titleY = 12;  // 标题距顶 12px（小偏移可用常量）

// 距底部 N 像素
int bottomButtonY = this.height - 28;  // 底部按钮距底 28px

// 垂直居中
int centerY = this.height / 2 - 10;  // 元素高 20，向上偏 10
```

### 3. 多元素垂直排列

```java
// 起点 + 步长，不要写死绝对 Y
int startY = 40;
int stepY = 24;
for (int i = 0; i < options.size(); i++) {
    int y = startY + i * stepY;
    // 在 (this.width / 2 - 100, y) 添加元素
}
```

:::tip
**推荐**：垂直列表用 `OptionListWidget`，自动处理排列与滚动，无需手写 `startY + i * stepY`。
:::

### 4. 水平排列

```java
// 两个按钮左右分布
int leftBtnX = this.width / 2 - 100 - 110;   // 居中 - 半宽 - 间距
int rightBtnX = this.width / 2 + 110;        // 居中 + 间距
```

## HUD 相对坐标{#hud-relative}

`HudRenderCallback` 中没有 `this.width` / `this.height`，需要从 `DrawContext` 或 `client.getWindow()` 获取：

```java
HudRenderCallback.EVENT.register((context, tickCounter) -> {
    int width = client.getWindow().getScaledWidth();
    int height = client.getWindow().getScaledHeight();

    // 左上角
    context.drawText(textRenderer, Text.of("左上"), 4, 4, 0xFFFFFF, false);

    // 右上角
    String text = "右上";
    int textWidth = textRenderer.getWidth(text);
    context.drawText(textRenderer, Text.of(text), width - textWidth - 4, 4, 0xFFFFFF, false);

    // 中下
    int centerX = width / 2 - textWidth / 2;
    int bottomY = height - 12;
    context.drawText(textRenderer, Text.of(text), centerX, bottomY, 0xFFFFFF, false);
});
```

## 禁止的反例{#forbidden-examples}

### 反例 1：硬编码按钮位置

```java
// ❌ 禁止
ButtonWidget.builder(Text.of("开始"), cb)
    .dimensions(540, 360, 200, 20)  // 写死 540, 360
    .build();

// ✅ 正确
ButtonWidget.builder(Text.of("开始"), cb)
    .dimensions(this.width / 2 - 100, this.height / 2 - 10, 200, 20)
    .build();
```

### 反例 2：硬编码文字位置

```java
// ❌ 禁止
context.drawText(textRenderer, Text.of("标题"), 620, 20, 0xFFFFFF, true);

// ✅ 正确
context.drawCenteredTextWithShadow(
    textRenderer,
    Text.of("标题"),
    this.width / 2,  // 居中 X
    8,               // 距顶 8px（小偏移可常量）
    0xFFFFFF
);
```

### 反例 3：硬编码 HUD 位置

```java
// ❌ 禁止：在 1920x1080 居中，1280x720 下偏右
context.drawText(textRenderer, Text.of("中心"), 950, 540, 0xFFFFFF, false);

// ✅ 正确
int w = client.getWindow().getScaledWidth();
int h = client.getWindow().getScaledHeight();
int textW = textRenderer.getWidth("中心");
context.drawText(textRenderer, Text.of("中心"), w / 2 - textW / 2, h / 2 - 4, 0xFFFFFF, false);
```

## 允许的常量偏移{#allowed-constants}

小偏移（≤ 32px）可作为常量，例如：

- 标题距顶：`8` 或 `12`
- 底部按钮距底：`28`
- 元素间距：`4`、`8`、`12`
- 边框留白：`4`、`6`

但**结构性位置**（居中、右对齐、底对齐）必须用 `this.width` / `this.height` 计算。

## 与 gui_layout_preview 配合{#with-preview-tool}

`gui_layout_preview` 工具输出的布局 JSON 中，元素坐标基于 **1280x720 画布**。编写代码时必须按比例转换：

```java
// 布局 JSON: { "x": 560, "y": 100, "width": 160, "height": 20 }
// 转换为相对坐标（按 1280x720 缩放）：
int elementX = (int)(this.width * (560.0 / 1280));
int elementY = (int)(this.height * (100.0 / 720));
int elementW = (int)(this.width * (160.0 / 1280));
int elementH = 20;  // 高度通常保持像素值
```

:::info
对于 `option-list` 类型，直接用 `OptionListWidget` 自动布局，**无需转换坐标**。
对于 `custom-screen` 和 `hud-overlay` 类型，按上述比例公式转换。
:::

## 自检清单{#checklist}

编写 GUI 代码后，逐条检查：

- [ ] 所有 `dimensions(x, y, w, h)` 的 x、y 是否用 `this.width / 2` / `this.height / 2` 计算？
- [ ] 所有 `drawText` / `drawCenteredTextWithShadow` 的位置是否相对计算？
- [ ] HUD 是否通过 `client.getWindow().getScaledWidth/Height()` 获取尺寸？
- [ ] 多元素垂直排列是否用 `startY + i * stepY` 而非写死 Y？
- [ ] 是否使用了 `OptionListWidget` 来处理设置列表（而非手动摆按钮）？

:::warning
若任一项为"否"，重构后再提交。`gui_layout_preview` 工具生成的布局 JSON 必须按 1280x720 → `this.width x this.height` 比例转换。
:::
