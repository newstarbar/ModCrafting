package com.modcrafting.observer;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

/**
 * Top-right「发送给AI」chip.
 * <p>
 * HudRenderCallback only runs in-world (no TitleScreen). ScreenEvents cover
 * menus / title / pause so the chip is always visible when a Screen is open.
 */
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

        // In-world HUD (currentScreen == null)
        HudRenderCallback.EVENT.register(SendToAiHud::renderHud);

        // Title / pause / inventory / any Screen — HudRenderCallback does not run here
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            ScreenEvents.afterRender(screen).register((scr, context, mouseX, mouseY, delta) -> {
                renderChip(context, client);
            });
        });

        ClientTickEvents.END_CLIENT_TICK.register(SendToAiHud::tick);
        ModCraftingObserverClient.LOGGER.info("SendToAi HUD registered (in-world + screens), key=F8");
    }

    private static void renderHud(DrawContext context, RenderTickCounter tickCounter) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null) return;
        // Avoid double-draw when a screen is also rendering the chip
        if (client.currentScreen != null) return;
        renderChip(context, client);
    }

    private static void renderChip(DrawContext context, MinecraftClient client) {
        if (client == null || client.getWindow() == null) return;

        String label = SendToAiActions.isBusy() ? "发送中…" : "发送给AI";
        int textW = client.textRenderer.getWidth(label);
        btnW = Math.max(textW + PAD * 2, 56);
        int sw = client.getWindow().getScaledWidth();
        btnX = sw - btnW - 8;
        btnY = 8;

        int bg = 0xCC101018;
        int border = 0xFF6C8CFF;
        context.fill(btnX - 1, btnY - 1, btnX + btnW + 1, btnY + BTN_H + 1, border);
        context.fill(btnX, btnY, btnX + btnW, btnY + BTN_H, bg);
        context.drawText(
                client.textRenderer,
                Text.literal(label),
                btnX + (btnW - textW) / 2,
                btnY + (BTN_H - 8) / 2,
                0xFFE8ECFF,
                false
        );
    }

    private static void tick(MinecraftClient client) {
        while (sendKey.wasPressed()) {
            SendToAiActions.sendAsync();
        }

        if (client.getWindow() == null) return;
        long handle = client.getWindow().getHandle();
        boolean down = GLFW.glfwGetMouseButton(handle, GLFW.GLFW_MOUSE_BUTTON_LEFT) == GLFW.GLFW_PRESS;
        if (down && !mouseWasDown) {
            boolean mouseFree = client.currentScreen != null || !client.mouse.isCursorLocked();
            if (mouseFree && btnW > 0) {
                double mx = client.mouse.getX() * client.getWindow().getScaledWidth() / (double) client.getWindow().getWidth();
                double my = client.mouse.getY() * client.getWindow().getScaledHeight() / (double) client.getWindow().getHeight();
                if (mx >= btnX && mx <= btnX + btnW && my >= btnY && my <= btnY + BTN_H) {
                    SendToAiActions.sendAsync();
                }
            }
        }
        mouseWasDown = down;
    }
}
