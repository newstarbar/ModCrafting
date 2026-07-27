package com.modcrafting.observer;

import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

/**
 * In-game tip / status for {@link InputGuard}.
 * Drawn only inside the game framebuffer (never covers the OS title bar).
 * <p>
 * Locked: corner chip always shown; tip card appears while the mouse is over the game window.
 * Cursor is unlocked while locked so hover works in-world; mixins still block gameplay input.<br>
 * Unlocked: corner "手动模式" chip; click to re-lock.
 */
public final class InputGuardHud {
    private static final int PAD = 10;
    private static final int BTN_H = 20;
    private static final int INDICATOR_H = 16;

    private static boolean mouseWasDown;
    private static int restoreBtnX;
    private static int restoreBtnY;
    private static int restoreBtnW;
    private static int indicatorX;
    private static int indicatorY;
    private static int indicatorW;
    private static int tipCardX;
    private static int tipCardY;
    private static int tipCardW;
    private static int tipCardH;
    private static boolean tipVisible;
    private static boolean restoreHitValid;
    private static boolean indicatorHitValid;

    private InputGuardHud() {}

    public static void register() {
        HudRenderCallback.EVENT.register(InputGuardHud::renderHud);
        ScreenEvents.AFTER_INIT.register((client, screen, scaledWidth, scaledHeight) -> {
            ScreenEvents.afterRender(screen).register((scr, context, mouseX, mouseY, delta) -> {
                render(context, client, mouseX, mouseY);
            });
        });
        ClientTickEvents.END_CLIENT_TICK.register(InputGuardHud::tick);
        ModCraftingObserverClient.LOGGER.info("InputGuard HUD registered");
    }

    private static void renderHud(DrawContext context, RenderTickCounter tickCounter) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client == null || client.currentScreen != null) return;
        double[] mouse = scaledMouse(client);
        render(context, client, mouse[0], mouse[1]);
    }

    private static void render(DrawContext context, MinecraftClient client, double mouseX, double mouseY) {
        tipVisible = false;
        restoreHitValid = false;
        indicatorHitValid = false;
        restoreBtnW = 0;
        indicatorW = 0;

        if (!InputGuard.isActive() || client == null || client.getWindow() == null) {
            tipCardW = 0;
            tipCardH = 0;
            // 即使非 AI 自测期间也绘制点击高亮（供解锁后短暂残留）
            drawClickHighlight(context, client);
            return;
        }

        int sw = client.getWindow().getScaledWidth();
        int sh = client.getWindow().getScaledHeight();
        long handle = client.getWindow().getHandle();

        if (InputGuard.isLocked()) {
            drawIndicator(context, client, sw, sh, "AI 自测", 0xFF4A90D9);
            // 使用 GLFW_HOVERED 检测鼠标是否悬停在游戏窗口上。
            // 旧的 overWindow 判断基于 client.mouse.getX()/getY()，但这些值在鼠标离开窗口后
            // 不更新（保留窗口内最后已知位置），导致提示卡片常驻显示。
            // GLFW_HOVERED 直接由 GLFW 维护，准确反映光标是否在窗口客户区内。
            boolean mouseOverWindow = GLFW.glfwGetWindowAttrib(handle, GLFW.GLFW_HOVERED) == GLFW.GLFW_TRUE;
            if (mouseOverWindow) {
                tipVisible = true;
                drawTipCard(context, client, sw, sh);
            } else {
                tipCardW = 0;
                tipCardH = 0;
            }
        } else {
            tipCardW = 0;
            tipCardH = 0;
            drawIndicator(context, client, sw, sh, "手动模式", 0xFF5BCA6B);
            indicatorHitValid = true;
        }

        // 绘制 Agent 点击高亮（独立于 locked 状态，只要 InputGuard 激活就绘制）
        drawClickHighlight(context, client);
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

    private static void drawIndicator(DrawContext context, MinecraftClient client, int sw, int sh, String label, int border) {
        int textW = client.textRenderer.getWidth(label);
        indicatorW = textW + 16;
        indicatorX = sw - indicatorW - 8;
        indicatorY = sh - INDICATOR_H - 8;
        context.fill(indicatorX - 1, indicatorY - 1, indicatorX + indicatorW + 1, indicatorY + INDICATOR_H + 1, border);
        context.fill(indicatorX, indicatorY, indicatorX + indicatorW, indicatorY + INDICATOR_H, 0xCC14161C);
        context.drawText(
                client.textRenderer,
                Text.literal(label),
                indicatorX + 8,
                indicatorY + (INDICATOR_H - 8) / 2,
                0xFFF0F2F5,
                false
        );
    }

    private static void drawTipCard(DrawContext context, MinecraftClient client, int sw, int sh) {
        String title = "AI 自测进行中";
        String line1 = "当前正在处于 AI 自测期间，您的操作可能会影响 AI 自测的效果。";
        String line2 = "如需手动操作，请点击下方按钮恢复控制（AI 仍会继续自测）。";
        String btnLabel = "恢复手动控制";

        int cardW = Math.min(360, sw - 40);
        int textMax = cardW - PAD * 2;
        int titleW = client.textRenderer.getWidth(title);
        int line1H = wrapHeight(client, line1, textMax);
        int line2H = wrapHeight(client, line2, textMax);
        int btnTextW = client.textRenderer.getWidth(btnLabel);
        restoreBtnW = Math.max(btnTextW + 24, 120);

        int cardH = PAD + 12 + 6 + line1H + 4 + line2H + 12 + BTN_H + PAD;
        int cardX = (sw - cardW) / 2;
        int cardY = Math.max(12, (sh - cardH) / 2 - 20);

        tipCardX = cardX;
        tipCardY = cardY;
        tipCardW = cardW;
        tipCardH = cardH;

        // Light translucent white card (no full-screen dim)
        context.fill(cardX - 1, cardY - 1, cardX + cardW + 1, cardY + cardH + 1, 0x66FFFFFF);
        context.fill(cardX, cardY, cardX + cardW, cardY + cardH, 0xB8F5F7FA);

        int ty = cardY + PAD;
        context.drawText(client.textRenderer, Text.literal(title), cardX + (cardW - titleW) / 2, ty, 0xFF1A1D24, false);
        ty += 18;
        ty = drawWrapped(context, client, line1, cardX + PAD, ty, textMax, 0xE01A1D24);
        ty += 4;
        ty = drawWrapped(context, client, line2, cardX + PAD, ty, textMax, 0xC01A1D24);
        ty += 12;

        restoreBtnX = cardX + (cardW - restoreBtnW) / 2;
        restoreBtnY = ty;
        restoreHitValid = true;
        context.fill(restoreBtnX, restoreBtnY, restoreBtnX + restoreBtnW, restoreBtnY + BTN_H, 0xEB4A90D9);
        context.drawText(
                client.textRenderer,
                Text.literal(btnLabel),
                restoreBtnX + (restoreBtnW - btnTextW) / 2,
                restoreBtnY + (BTN_H - 8) / 2,
                0xFFFFFFFF,
                false
        );
    }

    private static int wrapHeight(MinecraftClient client, String text, int maxWidth) {
        int lines = 1;
        int w = 0;
        for (int i = 0; i < text.length(); i++) {
            int cw = client.textRenderer.getWidth(text.substring(i, i + 1));
            if (w + cw > maxWidth) {
                lines++;
                w = cw;
            } else {
                w += cw;
            }
        }
        return lines * 10;
    }

    private static int drawWrapped(DrawContext context, MinecraftClient client, String text, int x, int y, int maxWidth, int color) {
        StringBuilder line = new StringBuilder();
        int cy = y;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            String next = line.toString() + c;
            if (client.textRenderer.getWidth(next) > maxWidth && !line.isEmpty()) {
                context.drawText(client.textRenderer, Text.literal(line.toString()), x, cy, color, false);
                cy += 10;
                line.setLength(0);
            }
            line.append(c);
        }
        if (!line.isEmpty()) {
            context.drawText(client.textRenderer, Text.literal(line.toString()), x, cy, color, false);
            cy += 10;
        }
        return cy;
    }

    private static double[] scaledMouse(MinecraftClient client) {
        double mx = client.mouse.getX() * client.getWindow().getScaledWidth() / (double) client.getWindow().getWidth();
        double my = client.mouse.getY() * client.getWindow().getScaledHeight() / (double) client.getWindow().getHeight();
        return new double[]{mx, my};
    }

    private static void tick(MinecraftClient client) {
        if (!InputGuard.isActive() || client == null || client.getWindow() == null) {
            mouseWasDown = false;
            return;
        }

        // Keep cursor free while locked so player can hover the tip chip in-world.
        // Mixins still block camera / keybinds / mouse buttons for gameplay.
        if (InputGuard.isLocked() && client.currentScreen == null && client.mouse.isCursorLocked()) {
            client.mouse.unlockCursor();
        }

        long handle = client.getWindow().getHandle();
        boolean down = GLFW.glfwGetMouseButton(handle, GLFW.GLFW_MOUSE_BUTTON_LEFT) == GLFW.GLFW_PRESS;
        if (down && !mouseWasDown) {
            double[] m = scaledMouse(client);
            double mx = m[0];
            double my = m[1];
            if (restoreHitValid && tipVisible && restoreBtnW > 0
                    && mx >= restoreBtnX && mx <= restoreBtnX + restoreBtnW
                    && my >= restoreBtnY && my <= restoreBtnY + BTN_H) {
                InputGuard.setLocked(false);
            } else if (indicatorHitValid && indicatorW > 0
                    && mx >= indicatorX && mx <= indicatorX + indicatorW
                    && my >= indicatorY && my <= indicatorY + INDICATOR_H) {
                InputGuard.setLocked(true);
            }
        }
        mouseWasDown = down;
    }
}
