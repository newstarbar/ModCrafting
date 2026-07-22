---
title: 自定义组件
description: 学习如何给您的界面创建自定义组件。
authors:
  - IMB11
---

组件本质上是容器化的界面元素，可以被添加到屏幕中供玩家交互，交互方式包括鼠标点击、键盘输入等。

## 创建组件{#creating-a-widget}

有很多种创建组件的方式，例如继承 `AbstractWidget`。 这个类提供了许多实用功能，比如控制组件的尺寸和位置，以及接收用户输入事件。事实上这些功能由 `Renderable`、`GuiEventListener`、`NarrationSupplier`、`NarratableEntry` 接口规定：

- `Renderable` 用于渲染，需要通过 `Screen#addDrawableChild` 将组件注册到屏幕中。
- `GuiEventListener` 用于事件，比如鼠标点击、键盘输入等，需要这个来处理事件。
- `NarrationSupplier` 用于无障碍，让组件能够通过屏幕阅读器或其他无障碍工具访问。
- `NarratableEntry` 用于选择，实现此接口后组件可以由 <kbd>Tab</kbd> 键选中，这也能帮助无障碍。


```java
public class CustomWidget extends AbstractWidget {
	public CustomWidget(int x, int y, int width, int height) {
		super(x, y, width, height, Component.empty());
	}

	@Override
	protected void renderWidget(GuiGraphics context, int mouseX, int mouseY, float delta) {
		// We'll just draw a simple rectangle for now.
		// x1, y1, x2, y2, startColor, endColor
		int startColor = 0xFF00FF00; // Green
		int endColor = 0xFF0000FF; // Blue

		context.fillGradient(getX(), getY(), getX() + this.width, getY() + this.height, startColor, endColor);
	}

	@Override
	protected void updateWidgetNarration(NarrationElementOutput builder) {
		// For brevity, we'll just skip this for now - if you want to add narration to your widget, you can do so here.
		return;
	}
}
```


## 将组件添加到屏幕{#adding-the-widget-to-the-screen}

如同其他组件，您需要使用 `Screen#addDrawableChild` 来将组件添加到界面中。 请确保这一步在 `Screen#init` 方法中完成。


```java
		// Add a custom widget to the screen.
		// x, y, width, height
		CustomWidget customWidget = new CustomWidget(40, 80, 120, 20);
		this.addRenderableWidget(customWidget);
```


![屏幕中的自定义组件](/assets/develop/rendering/gui/custom-widget-example.png)

## 组件事件{#widget-events}

您可以自定义用户输入事件的处理逻辑，比如覆写 `mouseClicked`、`afterMouseAction`、`keyPressed` 等方法。

举个例子，您可以使用 `ClickableWidget#isHovered` 方法来使组件在鼠标悬停时变色。


```java
		// This is in the "renderWidget" method, so we can check if the mouse is hovering over the widget.
		if (isHovered()) {
			startColor = 0xFFFF0000; // Red
			endColor = 0xFF00FFFF; // Cyan
		}
```


![鼠标悬停事件](/assets/develop/rendering/gui/custom-widget-events.webp)
