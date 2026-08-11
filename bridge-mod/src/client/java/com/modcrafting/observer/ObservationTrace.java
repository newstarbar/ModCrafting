package com.modcrafting.observer;

import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.registry.Registries;
import net.minecraft.client.render.entity.EntityRenderer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Small, generic client-observation rings. They record rendering facts only;
 * they intentionally know nothing about a tested mod, entity, key binding, or feature.
 */
public final class ObservationTrace {
    private static final int LIMIT = 256;
    private static final Deque<Map<String, Object>> HUD = new ArrayDeque<>();
    private static final Deque<Map<String, Object>> RENDER = new ArrayDeque<>();

    private ObservationTrace() {}

    public static synchronized void hudText(String text, int x, int y, int color) {
        if (text == null || text.isBlank()) return;
        Map<String, Object> entry = base();
        entry.put("text", text);
        entry.put("x", x);
        entry.put("y", y);
        entry.put("color", color);
        MinecraftClient client = MinecraftClient.getInstance();
        entry.put("screen", client != null && client.currentScreen != null ? client.currentScreen.getClass().getName() : null);
        append(HUD, entry);
    }

    public static synchronized void render(Entity entity, EntityRenderer<?, ?> renderer) {
        if (entity == null || renderer == null) return;
        Map<String, Object> entry = base();
        entry.put("entityUuid", entity.getUuidAsString());
        entry.put("entityType", Registries.ENTITY_TYPE.getId(entity.getType()).toString());
        entry.put("rendererClass", renderer.getClass().getName());
        // Model and texture are renderer-specific in modern Minecraft. Their absence
        // is advertised as an unavailable field instead of guessed from class names.
        append(RENDER, entry);
    }

    public static synchronized List<Map<String, Object>> hudSnapshot() { return new ArrayList<>(HUD); }
    public static synchronized List<Map<String, Object>> renderSnapshot() { return new ArrayList<>(RENDER); }

    private static Map<String, Object> base() {
        MinecraftClient client = MinecraftClient.getInstance();
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("observedAt", System.currentTimeMillis());
        entry.put("worldTick", client != null && client.world != null ? client.world.getTime() : null);
        return entry;
    }

    private static void append(Deque<Map<String, Object>> target, Map<String, Object> entry) {
        target.addLast(entry);
        while (target.size() > LIMIT) target.removeFirst();
    }
}
