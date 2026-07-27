package com.modcrafting.observer;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * In-process input guard for AI self-test.
 * When active+locked, GLFW→KeyBinding / camera updates are blocked by mixins;
 * AI still drives the client via {@link InputActions} (KeyBinding / look / Screen APIs).
 */
public final class InputGuard {
    private static volatile boolean active;
    private static volatile boolean locked = true;

    private InputGuard() {}

    public static void register() {
        ModCraftingObserverClient.LOGGER.info("InputGuard registered");
    }

    public static boolean isActive() {
        return active;
    }

    public static boolean isLocked() {
        return active && locked;
    }

    public static void setActive(boolean value) {
        active = value;
        if (!value) {
            locked = true;
        }
    }

    public static void setLocked(boolean value) {
        if (!active) return;
        locked = value;
    }

    public static Map<String, Object> snapshot() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("active", active);
        out.put("locked", locked);
        return out;
    }

    public static Map<String, Object> apply(Map<String, Object> body) {
        boolean hadActive = body.containsKey("active");
        boolean hadLocked = body.containsKey("locked");
        if (hadActive) {
            setActive(asBool(body.get("active")));
        }
        if (hadLocked) {
            if (!active && asBool(body.get("locked"))) {
                setActive(true);
            }
            setLocked(asBool(body.get("locked")));
        } else if (hadActive && active) {
            // POST {active:true} defaults to locked
            setLocked(true);
        }
        return snapshot();
    }

    /** Allow ESC so the player can open pause / leave menus even while locked. */
    public static boolean shouldBlockKey(int key) {
        if (!isLocked()) return false;
        return key != org.lwjgl.glfw.GLFW.GLFW_KEY_ESCAPE;
    }

    private static boolean asBool(Object value) {
        if (value instanceof Boolean b) return b;
        if (value instanceof Number n) return n.intValue() != 0;
        if (value == null) return false;
        return Boolean.parseBoolean(String.valueOf(value));
    }
}
