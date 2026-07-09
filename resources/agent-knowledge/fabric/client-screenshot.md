# 客户端截图与主菜单背景（1.21.4 Yarn）

## ScreenshotRecorder

类：`net.minecraft.client.util.ScreenshotRecorder`

常用静态方法（Yarn 1.21.4）：

```java
// 保存当前帧缓冲到文件（与 F2 截图类似）
ScreenshotRecorder.saveScreenshot(File directory, String fileName, Framebuffer framebuffer, Consumer<Text> messageReceiver);

// 从帧缓冲读取像素为 NativeImage（可再写入自定义路径）
NativeImage image = ScreenshotRecorder.takeScreenshot(Framebuffer framebuffer);
```

## NativeImage 写 PNG

类：`net.minecraft.client.texture.NativeImage`

```java
NativeImage image = ScreenshotRecorder.takeScreenshot(client.getFramebuffer());
image.writeTo(Path.of("config", "my-mod", "background.png"));
image.close();
```

## 客户端入口

截图、按键、TitleScreen 相关代码放在 `src/client/java`，在 `ClientModInitializer.onInitializeClient()` 注册。

## TitleScreen 背景替换思路

- Mixin 注入 `net.minecraft.client.gui.screen.TitleScreen` 的 `render` 或背景绘制方法
- 使用 `DrawContext.drawTexture(...)` 绘制已保存的 PNG 纹理
- 纹理通过 `NativeImageBackedTexture` + `TextureManager.registerTexture` 加载

## 按键注册（Fabric API）

```java
KeyBinding key = KeyBindingHelper.registerKeyBinding(new KeyBinding(
    "key.my-mod.capture",
    InputUtil.Type.KEYSYM,
    GLFW.GLFW_KEY_F6,
    "category.my-mod"
));
ClientTickEvents.END_CLIENT_TICK.register(client -> {
    while (key.wasPressed()) {
        // capture frame
    }
});
```
