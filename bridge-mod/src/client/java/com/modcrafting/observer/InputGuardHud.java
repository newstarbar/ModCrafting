package com.modcrafting.observer;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.text.Text;

/**
 * In-game hint for {@link InputGuard}.
 * <p>
 * Only renders a small, slowly blinking "当前AI操控中，请勿随意操作" hint at the
 * bottom-right corner while AI is controlling. Nothing is drawn when AI is
 * not active. The previous tip card and manual-control toggle have been
 * removed per UX requirements.
 */
public final class InputGuardHud {

    private InputGuardHud() {}

    public static void register() {
        HudRenderCallback.EVENT.register(InputGuardHud::renderHud);
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            ScreenEvents.afterRender(screen).register((scr, context, mouseX, mouseY, delta) -> {
                render(context, client);
            });
        });
        ClientTickEvents.END_CLIENT_TICK.register(InputGuardHud::tick);
        ModCraftingObserverClient.LOGGER.info("InputGuard HUD registered");
    }

    private static void renderHud(DrawContext context, RenderTickCounter tickCounter) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.currentScreen != null) return;
        render(context, client);
    }

    private static void render(DrawContext context, MinecraftClient client) {
        if (client == null || client.getWindow() == null) return;

        // AI 不操控时完全不绘制任何提示
        if (!InputGuard.isActive()) {
            // 仍绘制 Agent 点击高亮（独立于 InputGuard 状态，残留淡出）
            drawClickHighlight(context, client);
            return;
        }

        int sw = client.getWindow().getScaledWidth();
        int sh = client.getWindow().getScaledHeight();

        // 右下角闪动小字警告
        drawAiControllingHint(context, client, sw, sh);

        // Agent 点击高亮
        drawClickHighlight(context, client);
    }

    /**
     * 屏幕右下角缓慢闪动的"当前AI操控中，请勿随意操作"小字提示。
     * 闪动周期 2 秒，alpha 在 0.4 ~ 0.9 之间正弦波动。
     */
    private static void drawAiControllingHint(DrawContext context, MinecraftClient client, int sw, int sh) {
        String label = "当前AI操控中，请勿随意操作";
        int textW = client.textRenderer.getWidth(label);
        int x = sw - textW - 12;
        int y = sh - 12;

        long t = System.currentTimeMillis();
        // 周期 2000ms，alpha 范围 0.4~0.9
        float sine = (float) Math.sin(t * Math.PI / 1000.0);
        float alpha = 0.65f + 0.25f * sine;
        int a = (int) (alpha * 255) & 0xFF;
        int color = (a << 24) | 0xFFF0F2F5;

        context.drawTextWithShadow(client.textRenderer, Text.literal(label), x, y - 8, color);
    }

    /** 绘制 Agent 点击按钮的柔和高亮边框（500ms 淡出）。
     *  仅 GUI Screen 内的点击有高亮；世界内操控（移动/视角/攻击等）不记录高亮。 */
    private static void drawClickHighlight(DrawContext context, MinecraftClient client) {
        InputActions.ClickHighlight hl = InputActions.getLastClickHighlight();
        if (hl == null || hl.isExpired()) return;

        // 柔和蓝色边框，与 AI 自测主题色一致 (0xFF4A90D9)
        int border = 0xFF4A90D9;
        int x = (int) hl.x;
        int y = (int) hl.y;
        int w = (int) hl.width;
        int h = (int) hl.height;

        // 2px 边框
        context.fill(x - 1, y - 1, x + w + 1, y + 1, border);             // 上
        context.fill(x - 1, y + h - 1, x + w + 1, y + h + 1, border);     // 下
        context.fill(x - 1, y, x + 1, y + h, border);                     // 左
        context.fill(x + w - 1, y, x + w + 1, y + h, border);             // 右
    }

    private static void tick(MinecraftClient client) {
        if (!InputGuard.isActive() || client == null || client.getWindow() == null) {
            return;
        }

        // Keep cursor free while AI is controlling so player can still move cursor
        // for any in-world hover detection. Mixins block camera / keybinds / mouse
        // buttons for gameplay.
        if (InputGuard.isLocked() && client.currentScreen == null && client.mouse.isCursorLocked()) {
            client.mouse.unlockCursor();
        }
    }
}
