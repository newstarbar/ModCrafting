package com.modcrafting.observer;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

/** Top-right HUD chip + keybind for「发送给AI」. */
public final class SendToAiHud {
    private static final int PAD = 6;
    private static final int BTN_H = 18;
    private static KeyBinding sendKey;
    private static int btnX;
    private static int btnY;
    private static int btnW;
    private static boolean mouseWasDown;

    private SendToAiHud() {}

    public static void register() {
        sendKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.modcrafting_observer.send_to_ai",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_F8,
                "category.modcrafting_observer"
        ));

        HudRenderCallback.EVENT.register(SendToAiHud::render);
        ClientTickEvents.END_CLIENT_TICK.register(SendToAiHud::tick);
    }

    private static void render(DrawContext context, RenderTickCounter tickCounter) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.getWindow() == null) return;

        String label = SendToAiActions.isBusy() ? "发送中…" : "发送给AI";
        int textW = client.textRenderer.getWidth(label);
        btnW = textW + PAD * 2;
        int sw = client.getWindow().getScaledWidth();
        btnX = sw - btnW - 8;
        btnY = 8;

        int bg = 0xAA101018;
        int border = 0xFF6C8CFF;
        context.fill(btnX - 1, btnY - 1, btnX + btnW + 1, btnY + BTN_H + 1, border);
        context.fill(btnX, btnY, btnX + btnW, btnY + BTN_H, bg);
        context.drawText(client.textRenderer, Text.literal(label), btnX + PAD, btnY + (BTN_H - 8) / 2, 0xFFE8ECFF, false);
    }

    private static void tick(MinecraftClient client) {
        while (sendKey.wasPressed()) {
            SendToAiActions.sendAsync();
        }

        // Allow mouse click when a screen is open (mouse free) or mouse is not grabbed.
        long handle = client.getWindow().getHandle();
        boolean down = GLFW.glfwGetMouseButton(handle, GLFW.GLFW_MOUSE_BUTTON_LEFT) == GLFW.GLFW_PRESS;
        if (down && !mouseWasDown) {
            boolean mouseFree = client.currentScreen != null || !client.mouse.isCursorLocked();
            if (mouseFree) {
                double mx = client.mouse.getX() * client.getWindow().getScaledWidth() / client.getWindow().getWidth();
                double my = client.mouse.getY() * client.getWindow().getScaledHeight() / client.getWindow().getHeight();
                if (mx >= btnX && mx <= btnX + btnW && my >= btnY && my <= btnY + BTN_H) {
                    SendToAiActions.sendAsync();
                }
            }
        }
        mouseWasDown = down;
    }
}
