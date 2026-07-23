package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import org.lwjgl.glfw.GLFW;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class InputActions {
    private static final ScheduledExecutorService RELEASE_SCHEDULER = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "modcrafting-observer-input");
        t.setDaemon(true);
        return t;
    });

    private InputActions() {}

    public static Map<String, Object> handle(Map<String, Object> body) {
        String action = str(body.get("action")).toLowerCase(Locale.ROOT);
        if (action.isEmpty()) {
            return error("BAD_REQUEST", "缺少 action");
        }
        // Convenience: mouse_click with x/y → GUI click_at
        if ("mouse_click".equals(action) && body.get("x") != null && body.get("y") != null) {
            return clickAt(body);
        }
        return switch (action) {
            case "key_down", "key_up", "key_press" -> keyAction(action, body);
            case "mouse_click" -> mouseClick(body);
            case "mouse_move" -> mouseMove(body);
            case "scroll" -> scroll(body);
            case "click_at" -> clickAt(body);
            case "click_widget" -> clickWidget(body);
            case "forward", "back", "left", "right", "jump", "sneak", "sprint",
                 "use", "attack", "inventory", "drop", "swap_hands" -> preset(action, body);
            default -> error("BAD_REQUEST", "未知 action: " + action);
        };
    }

    private static Map<String, Object> clickAt(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen screen = client.currentScreen;
        if (screen == null) {
            return error("NO_SCREEN", "当前没有打开的 GUI，无法点击按钮。先打开界面或按键（如 F6）。");
        }
        if (!body.containsKey("x") || !body.containsKey("y")) {
            return error("BAD_REQUEST", "click_at 需要缩放 GUI 坐标 x/y（可用 /v1/widgets 查询）");
        }
        double x = doubleVal(body.get("x"), 0);
        double y = doubleVal(body.get("y"), 0);
        int mouseButton = mouseButtonCode(str(body.get("button")));
        boolean pressed = screen.mouseClicked(x, y, mouseButton);
        screen.mouseReleased(x, y, mouseButton);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", "click_at");
        out.put("x", x);
        out.put("y", y);
        out.put("button", mouseButton);
        out.put("handled", pressed);
        out.put("screenAfter", client.currentScreen != null ? client.currentScreen.getClass().getSimpleName() : null);
        return out;
    }

    private static Map<String, Object> clickWidget(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen screen = client.currentScreen;
        if (screen == null) {
            return error("NO_SCREEN", "当前没有打开的 GUI");
        }
        ClickableWidget target = null;
        int matchedIndex = -1;
        int index = body.get("index") != null ? intVal(body.get("index"), -1) : -1;
        String label = str(body.get("label"));
        if (label.isEmpty()) label = str(body.get("message"));
        int i = 0;
        for (var element : screen.children()) {
            if (!(element instanceof ClickableWidget widget)) continue;
            boolean match = false;
            if (index >= 0 && i == index) match = true;
            if (!label.isEmpty()) {
                String msg = widget.getMessage() != null ? widget.getMessage().getString() : "";
                if (msg.toLowerCase(Locale.ROOT).contains(label.toLowerCase(Locale.ROOT))) {
                    match = true;
                }
            }
            if (match) {
                target = widget;
                matchedIndex = i;
                break;
            }
            i++;
        }
        if (target == null) {
            return error("NOT_FOUND", "未找到匹配控件（请先 GET /v1/widgets，用 index 或 label）");
        }
        if (!target.visible || !target.active) {
            return error("INACTIVE", "控件不可见或未激活: index=" + matchedIndex);
        }
        double x = target.getX() + target.getWidth() / 2.0;
        double y = target.getY() + target.getHeight() / 2.0;
        Map<String, Object> clickBody = new LinkedHashMap<>(body);
        clickBody.put("x", x);
        clickBody.put("y", y);
        Map<String, Object> result = clickAt(clickBody);
        result.put("action", "click_widget");
        result.put("index", matchedIndex);
        result.put("message", target.getMessage() != null ? target.getMessage().getString() : "");
        return result;
    }

    private static int mouseButtonCode(String button) {
        return switch (button.toLowerCase(Locale.ROOT)) {
            case "right" -> 1;
            case "middle" -> 2;
            default -> 0;
        };
    }

    private static Map<String, Object> preset(String action, Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        KeyBinding binding = switch (action) {
            case "forward" -> client.options.forwardKey;
            case "back" -> client.options.backKey;
            case "left" -> client.options.leftKey;
            case "right" -> client.options.rightKey;
            case "jump" -> client.options.jumpKey;
            case "sneak" -> client.options.sneakKey;
            case "sprint" -> client.options.sprintKey;
            case "use" -> client.options.useKey;
            case "attack" -> client.options.attackKey;
            case "inventory" -> client.options.inventoryKey;
            case "drop" -> client.options.dropKey;
            case "swap_hands" -> client.options.swapHandsKey;
            default -> null;
        };
        if (binding == null) {
            return error("BAD_REQUEST", "不支持的预置动作: " + action);
        }
        int duration = intVal(body.get("durationMs"), 120);
        pressBindingAsync(binding, Math.max(16, Math.min(duration, 5000)));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", action);
        out.put("durationMs", duration);
        return out;
    }

    private static Map<String, Object> keyAction(String action, Map<String, Object> body) {
        String keyName = str(body.get("key"));
        if (keyName.isEmpty()) {
            return error("BAD_REQUEST", "缺少 key");
        }
        InputUtil.Key key = resolveKey(keyName);
        if (key == null) {
            return error("BAD_REQUEST", "无法解析按键: " + keyName);
        }
        if ("key_up".equals(action)) {
            KeyBinding.setKeyPressed(key, false);
        } else if ("key_down".equals(action)) {
            KeyBinding.setKeyPressed(key, true);
            KeyBinding.onKeyPressed(key);
        } else {
            int duration = intVal(body.get("durationMs"), 80);
            KeyBinding.setKeyPressed(key, true);
            KeyBinding.onKeyPressed(key);
            scheduleRelease(key, Math.max(16, Math.min(duration, 2000)));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", action);
        out.put("key", keyName);
        return out;
    }

    private static Map<String, Object> mouseClick(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.currentScreen != null) {
            return error(
                    "BAD_REQUEST",
                    "当前有 GUI 打开。请用 action=click_at（x/y）或 click_widget（index/label）点击按钮；"
                            + "或先 GET /v1/widgets 查看控件列表。"
            );
        }
        String button = str(body.get("button")).toLowerCase(Locale.ROOT);
        if (button.isEmpty()) button = "left";
        KeyBinding binding = switch (button) {
            case "right" -> client.options.useKey;
            case "middle" -> client.options.pickItemKey;
            default -> client.options.attackKey;
        };
        int duration = intVal(body.get("durationMs"), 80);
        pressBindingAsync(binding, duration);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", "mouse_click");
        out.put("button", button);
        return out;
    }

    private static Map<String, Object> mouseMove(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.player == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        double dx = doubleVal(body.get("dx"), 0);
        double dy = doubleVal(body.get("dy"), 0);
        client.player.changeLookDirection(dx, dy);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", "mouse_move");
        out.put("dx", dx);
        out.put("dy", dy);
        out.put("yaw", client.player.getYaw());
        out.put("pitch", client.player.getPitch());
        return out;
    }

    private static Map<String, Object> scroll(Map<String, Object> body) {
        MinecraftClient client = MinecraftClient.getInstance();
        Screen screen = client.currentScreen;
        if (screen != null) {
            double x = body.containsKey("x") ? doubleVal(body.get("x"), screen.width / 2.0) : screen.width / 2.0;
            double y = body.containsKey("y") ? doubleVal(body.get("y"), screen.height / 2.0) : screen.height / 2.0;
            double amount = doubleVal(body.get("delta"), 1);
            boolean handled = screen.mouseScrolled(x, y, 0, amount);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("action", "scroll");
            out.put("gui", true);
            out.put("handled", handled);
            return out;
        }
        if (client.player == null) {
            return error("NOT_IN_WORLD", "玩家尚未进入世界");
        }
        int delta = intVal(body.get("delta"), 1);
        int slot = client.player.getInventory().selectedSlot - Integer.signum(delta);
        while (slot < 0) slot += 9;
        slot %= 9;
        client.player.getInventory().selectedSlot = slot;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("action", "scroll");
        out.put("selectedSlot", slot);
        return out;
    }

    private static void pressBindingAsync(KeyBinding binding, int durationMs) {
        InputUtil.Key key = resolveBoundKey(binding);
        KeyBinding.setKeyPressed(key, true);
        KeyBinding.onKeyPressed(key);
        scheduleRelease(key, durationMs);
    }

    private static void scheduleRelease(InputUtil.Key key, int durationMs) {
        RELEASE_SCHEDULER.schedule(() -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client != null) {
                client.execute(() -> KeyBinding.setKeyPressed(key, false));
            }
        }, durationMs, TimeUnit.MILLISECONDS);
    }

    private static InputUtil.Key resolveBoundKey(KeyBinding binding) {
        try {
            return InputUtil.fromTranslationKey(binding.getBoundKeyTranslationKey());
        } catch (Exception e) {
            return binding.getDefaultKey();
        }
    }

    private static InputUtil.Key resolveKey(String name) {
        String n = name.trim().toLowerCase(Locale.ROOT);
        if (n.matches("f([1-9]|1[0-2])")) {
            int f = Integer.parseInt(n.substring(1));
            int code = GLFW.GLFW_KEY_F1 + (f - 1);
            return InputUtil.Type.KEYSYM.createFromCode(code);
        }
        return switch (n) {
            case "w" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_W);
            case "a" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_A);
            case "s" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_S);
            case "d" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_D);
            case "space", "jump" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_SPACE);
            case "shift", "sneak" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_LEFT_SHIFT);
            case "ctrl", "control", "sprint" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_LEFT_CONTROL);
            case "e", "inventory" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_E);
            case "q", "drop" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_Q);
            case "f", "swap" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_F);
            case "escape", "esc" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_ESCAPE);
            case "enter", "return" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_ENTER);
            case "tab" -> InputUtil.Type.KEYSYM.createFromCode(GLFW.GLFW_KEY_TAB);
            default -> {
                if (n.startsWith("key.keyboard.")) {
                    yield InputUtil.fromTranslationKey(n);
                }
                try {
                    yield InputUtil.fromTranslationKey("key.keyboard." + n);
                } catch (Exception e) {
                    yield null;
                }
            }
        };
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o).trim();
    }

    private static int intVal(Object o, int def) {
        if (o instanceof Number n) return n.intValue();
        if (o instanceof String s) {
            try {
                return Integer.parseInt(s.trim());
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    private static double doubleVal(Object o, double def) {
        if (o instanceof Number n) return n.doubleValue();
        if (o instanceof String s) {
            try {
                return Double.parseDouble(s.trim());
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("code", code);
        out.put("error", message);
        return out;
    }
}
