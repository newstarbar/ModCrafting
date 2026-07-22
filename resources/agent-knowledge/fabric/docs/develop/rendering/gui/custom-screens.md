---
title: 自定义界面
description: 学习如何给你的模组创建自定义界面。
authors:
  - IMB11
---

:::info
本文所述均指一般的、未涉及同步的界面，这类界面是由玩家独自在客户端打开的，不需要服务端的参与。
:::

界面是指玩家可以交互的 GUI，比如标题界面、暂停界面等。

您可以创建自己的界面来展示自定义内容、自定义配置目录等。

## 创建界面{#creating-a-screen}

要创建界面，您需要继承 `Screen` 类并覆写 `init` 方法。您可能还需要覆写 `render` 方法，但是请保证调用 `super.render`， 否则背景和组件都不会渲染。

您需要注意：

- 组件不应该在 `Screen` 的构造方法里创建，因为此时界面还没有初始化，并且某些变量（比如界面的宽 `width` 和高 `height`）也还没有正确地初始化。
- 当界面正在初始化时，`init` 方法将被调用，这是创建组件对象的最佳时机。
  - 您可以通过 `addRenderableWidget` 方法来添加组件，这个方法接收任何实现了 `Renderable` 和 `GuiEventListener` 接口的组件对象。
- `render` 方法将在每一帧被调用，您可以在这个方法里获取诸多上下文，比如鼠标的位置。

举个例子，我们可以创建一个简单的界面，这个界面有一个按钮和一个按钮的标签。


```java
public class CustomScreen extends Screen {

	public CustomScreen(Component title) {
		super(title);
	}

	@Override
	protected void init() {
		Button buttonWidget = Button.builder(Component.nullToEmpty("Hello World"), (btn) -> {
			// When the button is clicked, we can display a toast to the screen.
			this.minecraft.getToastManager().addToast(
					SystemToast.multiline(this.minecraft, SystemToast.SystemToastId.NARRATOR_TOGGLE, Component.nullToEmpty("Hello World!"), Component.nullToEmpty("This is a toast."))
			);
		}).bounds(40, 40, 120, 20).build();
		// x, y, width, height
		// It's recommended to use the fixed height of 20 to prevent rendering issues with the button
		// textures.

		// Register the button widget.
		this.addRenderableWidget(buttonWidget);

	}

	@Override
	public void render(GuiGraphics context, int mouseX, int mouseY, float delta) {
		super.render(context, mouseX, mouseY, delta);

		// Minecraft doesn't have a "label" widget, so we'll have to draw our own text.
		// We'll subtract the font height from the Y position to make the text appear above the button.
		// Subtracting an extra 10 pixels will give the text some padding.
		// textRenderer, text, x, y, color, hasShadow
		context.drawString(this.font, "Special Button", 40, 40 - this.font.lineHeight - 10, 0xFFFFFFFF, true);
	}
}
```


![自定义界面 1](/assets/develop/rendering/gui/custom-1-example.png)

## 打开界面{#opening-the-screen}

您可以使用 `MinecraftClient` 类的 `setScreen` 方法来打开您的界面。您可以在许多地方做这件事，比如当一个按键触发时，当一条命令执行时，或者当客户端收到一个网络包时。

```java
Minecraft.getInstance().setScreen(
  new CustomScreen(Component.empty())
);
```

## 关闭界面{#closing-the-screen}

当您想要关闭界面时，只需将界面设为 `null` 即可：

```java
Minecraft.getInstance().setScreen(null);
```

如果您希望在关闭界面时回退到上一个界面，您可以将当前界面对象传入自定义的 `CustomScreen` 构造方法，把它保存为字段，然后覆写 `close` 方法，将实现修改为 `this.client.setScreen(/* 您保存的上一个界面 */)` 即可。


```java
	public Screen parent;
	public CustomScreen(Component title, Screen parent) {
		super(title);
		this.parent = parent;
	}

	@Override
	public void onClose() {
		this.minecraft.setScreen(this.parent);
	}
```


现在，当您按照上面的步骤打开界面时，您可以给构造方法的第二个参数传入当前界面对象，这样当您调用 `CustomScreen#close` 的时候，游戏就会回到上一个界面。

```java
Screen currentScreen = Minecraft.getInstance().currentScreen;
Minecraft.getInstance().setScreen(
  new CustomScreen(Component.empty(), currentScreen)
);
```
