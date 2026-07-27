---
title: 使用 OptionListWidget 构建设置界面
description: 用原版 SimpleOption + OptionListWidget 构建零依赖的模组设置界面，自动排列、滚动、居中。
authors:
  - ModCrafting
---

:::info
本文介绍如何使用 Minecraft 原版的 `SimpleOption<T>` 和 `OptionListWidget` 构建模组设置界面。这是**零依赖**方案，无需引入 YACL 等第三方配置库，且自动处理布局排列、滚动和分辨率适配。
:::

## 为什么用 OptionListWidget{#why-optionlist}

模组设置界面常见错误是手动 `addRenderableWidget` 逐个摆按钮，导致：
- 硬编码坐标（`bounds(40, 40, 120, 20)`），不同分辨率下错位
- 不支持滚动，选项多了超出屏幕
- 不支持鼠标滚轮，体验差

`OptionListWidget` 是原版"选项"界面（如视频设置、控制设置）使用的列表组件，自动处理：
- 垂直排列，每行一个选项
- 自动居中（基于 `this.width`）
- 滚动支持（鼠标滚轮 + 拖拽）
- 分辨率适配（`this.width` / `this.height` 变化时自动重排）

## SimpleOption 类型{#simpleoption-types}

`SimpleOption<T>` 是 1.21.x 中原版设置选项的统一封装。常见类型：

### 1. 开关选项（Boolean）

```java
SimpleOption<Boolean> toggleOption = new SimpleOption<>(
    "modid.options.enable_feature",  // 翻译键
    SimpleOption.emptyTooltip(),
    (text, value) -> Text.of(value ? "开启" : "关闭"),
    SimpleOption.BOOLEAN,
    true,  // 默认值
    (value) -> { /* 值变化回调 */ }
);
```

### 2. 滑块选项（Integer 范围）

```java
SimpleOption<Integer> sliderOption = new SimpleOption<>(
    "modid.options.power_level",
    SimpleOption.emptyTooltip(),
    (text, value) -> Text.of("强度: " + value),
    SimpleOption.IntSliderCallbacks.INSTANCE,
    50,  // 默认值
    0,   // 最小值
    100, // 最大值
    (value) -> { /* 值变化回调 */ }
);
```

:::warning
1.21.4 的 `SimpleOption.IntSliderCallbacks.INSTANCE` 构造与旧版本不同。请确认映射版本。
:::

### 3. 循环选择选项（Cycle）

```java
SimpleOption<Mode> cycleOption = new SimpleOption<>(
    "modid.options.mode",
    SimpleOption.emptyTooltip(),
    (text, value) -> Text.of(value.getDisplayName()),
    new SimpleOption.Type.Cycle<>(),
    Mode.DEFAULT,
    (value) -> { /* 值变化回调 */ }
);
```

## 构建 OptionListWidget 设置界面{#building-screen}

完整示例：一个包含开关、滑块、循环选择的模组设置界面。

```java
package com.example.mod.client.gui;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.option.SimpleOption;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.OptionListWidget;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

public class ModConfigScreen extends Screen {
    private OptionListWidget optionList;

    // 模组配置（实际应从 ModConfig 读取/写入）
    private boolean enableFeature = true;
    private int powerLevel = 50;

    private final SimpleOption<Boolean> toggleOption = new SimpleOption<>(
        "modid.options.enable_feature",
        SimpleOption.emptyTooltip(),
        (text, value) -> Text.of(value ? "开启" : "关闭").formatted(Formatting.YELLOW),
        SimpleOption.BOOLEAN,
        enableFeature,
        (value) -> { enableFeature = value; }
    );

    private final SimpleOption<Integer> sliderOption = SimpleOption.ofIntSlider(
        "modid.options.power_level",
        0, 100,
        powerLevel,
        (value) -> { powerLevel = value; }
    );

    public ModConfigScreen() {
        super(Text.of("模组设置"));
    }

    @Override
    protected void init() {
        // 创建 OptionListWidget —— 自动排列、滚动、居中
        optionList = new OptionListWidget(
            this.client,
            this.width,
            this.height,
            32,                          // 顶部偏移（标题下方）
            this.height - 32,            // 底部偏移（按钮上方）
            25                           // 每项高度
        );
        optionList.addAll(
            toggleOption,
            sliderOption
        );
        addSelectableChild(optionList);

        // 完成 按钮 —— 相对坐标居中
        addDrawableChild(ButtonWidget.builder(
            Text.translatable("gui.done"),
            (btn) -> this.close()
        ).dimensions(
            this.width / 2 - 100,   // 居中：宽度 200，左偏 100
            this.height - 28,       // 距底部 28px
            200, 20
        ).build());
    }

    @Override
    public void render(DrawContext context, int mouseX, int mouseY, float delta) {
        super.render(context, mouseX, mouseY, delta);
        // 标题居中
        context.drawCenteredTextWithShadow(
            this.textRenderer,
            this.title,
            this.width / 2,
            12,
            0xFFFFFF
        );
        optionList.render(context, mouseX, mouseY, delta);
    }

    @Override
    public boolean mouseScrolled(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
        return optionList.mouseScrolled(mouseX, mouseY, horizontalAmount, verticalAmount)
            || super.mouseScrolled(mouseX, mouseY, horizontalAmount, verticalAmount);
    }
}
```

## 关键要点{#key-points}

1. **零硬编码坐标**：`OptionListWidget` 自动排列所有 `SimpleOption`，无需手动写 `bounds(x, y, w, h)`
2. **自动滚动**：选项多时自动出现滚动条，鼠标滚轮支持开箱即用
3. **分辨率适配**：所有位置用 `this.width / 2`、`this.height - 28` 等相对坐标，不同分辨率下自动适配
4. **标题居中**：用 `context.drawCenteredTextWithShadow(..., this.width / 2, 12, ...)` 居中绘制标题
5. **底部按钮**：用 `this.width / 2 - 100` 居中放置"完成"按钮，`this.height - 28` 距底部 28px

## 与 GameOptions 集成{#gameoptions-integration}

若需持久化配置，可创建自定义 `GameOptions` 子类或用 `Properties` 文件存储。简化版：

```java
public class ModConfig {
    private static final Path CONFIG_PATH = FabricLoader.getInstance().getConfigDir().resolve("modid.json");
    private boolean enableFeature = true;
    private int powerLevel = 50;

    public static ModConfig load() {
        // 从 JSON 读取
    }

    public void save() {
        // 写入 JSON
    }
}
```

在 `SimpleOption` 的回调中调用 `config.save()` 即可持久化。

## 何时用 OptionListWidget vs 自定义 Screen{#when-to-use}

| 场景 | 推荐方案 |
|------|----------|
| 模组设置界面（开关、滑块、下拉） | **OptionListWidget**（本文） |
| 复杂自定义界面（图标、网格、动态内容） | 自定义 Screen + 相对坐标 |
| HUD 覆盖层 | HudRenderCallback + 相对坐标 |

:::warning
禁止在设置类界面中手动 `addRenderableWidget` 逐个摆按钮。必须用 `OptionListWidget`。
:::
